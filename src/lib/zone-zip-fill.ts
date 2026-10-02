// A zone you drew named no ZIPs.
//
// Owner, 2026-10-01: drawing a radius, drive time or polygon "does not auto
// insert all the zip codes that are within that. We need that to happen, due
// to many things relying on the zip codes." What relies on them most is
// public_quote -- the signup page and the lead form match a visitor by ZIP
// alone, because a form has a ZIP and no point. So a circle with an empty ZIP
// list quotes nobody who arrives that way.
//
// This file decides which US ZIPs a drawn shape holds. Pure: the candidates
// come from reference.zip_centroids (one row per Census ZCTA: its internal
// point and the radius of a circle with its land area), and the caller passes
// them in.
//
// ── THE ONE RULE: THE MATCHER DECIDES WHAT IS INSIDE ─────────────────────
//
// "Inside" is not re-implemented here. Each candidate is asked of matchZone()
// in zone-match.ts with a zone that has the drawn geometry and no ZIPs -- the
// exact call that assigns a property to a zone. So the radius is haversine,
// the polygon is the same ray cast over the same ring, and a drive time is the
// same `minutes * DRIVE_M_PER_MIN` circle (there is no isochrone anywhere in
// this codebase; if one is ever added to the matcher, the fill follows it with
// no change here). The fill and the matcher cannot drift because there is only
// one of them.
//
// ── INSIDE, EDGE, OUTSIDE ────────────────────────────────────────────────
//
//   inside  the ZIP's center is in the shape. Added automatically.
//   edge    the center is outside, but within the ZIP's own radius
//           (sqrt(ALAND/pi), capped) of the boundary, so part of the ZIP
//           probably is inside. OFFERED, never added: an exact ZIP match
//           outranks proximity in zone-match.ts, so listing a ZIP claims every
//           address in it -- including the part outside what was drawn, which
//           may be another zone's circle.
//   outside everything else.

import { DRIVE_M_PER_MIN, haversineMeters, matchZone, type ZoneMatchFields } from "./zone-match";

/** A drawn shape, as the coverage map reports it. */
export interface ZoneShapeInput {
  mode: "radius" | "drive_time" | "polygon" | string;
  polygon?: { coordinates?: number[][][] } | null;
  centerLat?: number | null;
  centerLng?: number | null;
  radiusMeters?: number | null;
  driveTimeMinutes?: number | null;
}

export interface ZipCentroid {
  zip: string;
  lat: number;
  lng: number;
  /** Radius of a circle with the ZIP's land area, in metres. */
  radiusM: number;
}

/** The furthest outside a shape a ZIP center can be and still be offered as
 *  an edge ZIP. Rural ZCTAs can be 100 km across; a suggestion 60 km outside
 *  a 2-mile circle is noise, so the ZIP's own radius is capped here. */
export const EDGE_MAX_M = 8000;

/** Most ZIPs one fill adds. Nearest the middle first. A shape holding more is
 *  better split into zones, and the UI says so. */
export const MAX_AUTO_ZIPS = 1000;

/** Most candidates asked of the database for one shape. */
export const MAX_CANDIDATES = 5000;

/** A shape the matcher can actually use, or null for a half-drawn one (a
 *  polygon with fewer than three points, a circle with no center yet). */
export function zoneFromShape(shape: ZoneShapeInput | null | undefined): ZoneMatchFields | null {
  if (!shape) return null;
  if (shape.mode === "polygon") {
    const raw = shape.polygon?.coordinates?.[0];
    if (!raw || raw.length < 3) return null;
    // Closed, as the coverage map writes it; close it if a caller did not.
    const [fx, fy] = raw[0];
    const [lx, ly] = raw[raw.length - 1];
    const ring = fx === lx && fy === ly ? raw : [...raw, raw[0]];
    if (ring.length < 4) return null; // three points and the repeat
    return { id: "drawn", geo_match_mode: "polygon", boundary: { coordinates: [ring] } };
  }
  if (shape.centerLat == null || shape.centerLng == null) return null;
  if (shape.mode === "radius" && shape.radiusMeters) {
    return {
      id: "drawn",
      geo_match_mode: "radius",
      center_latitude: shape.centerLat,
      center_longitude: shape.centerLng,
      radius_meters: shape.radiusMeters,
    };
  }
  if (shape.mode === "drive_time" && shape.driveTimeMinutes) {
    return {
      id: "drawn",
      geo_match_mode: "drive_time",
      center_latitude: shape.centerLat,
      center_longitude: shape.centerLng,
      drive_time_minutes: shape.driveTimeMinutes,
    };
  }
  return null;
}

/** A stable key for a shape, so the same shape is not looked up twice. Rounded
 *  to ~1 m, which is finer than anything a finger can place. */
export function shapeKey(shape: ZoneShapeInput | null | undefined): string | null {
  const z = zoneFromShape(shape);
  if (!z) return null;
  const r = (n: unknown) => Number(n).toFixed(5);
  if (z.geo_match_mode === "polygon") {
    return `p:${z.boundary!.coordinates![0].map(([x, y]) => `${r(x)},${r(y)}`).join(";")}`;
  }
  return `${z.geo_match_mode}:${r(z.center_latitude)},${r(z.center_longitude)}:${z.radius_meters ?? z.drive_time_minutes}`;
}

/** Metres per degree of latitude on the sphere haversineMeters uses (R =
 *  6,371 km). Not the 111,320 often quoted: that is the equatorial figure,
 *  and a box built with it is ~0.1% short of the matcher's own circle. */
const M_PER_DEG_LAT = (6_371_000 * Math.PI) / 180;

/** Degrees of latitude and longitude that hold every point within `m` metres
 *  of a point at `lat`. Longitude uses the exact great-circle extent,
 *  asin(sin(d/R) / cos(lat)), which is wider than d / (R cos lat): the
 *  circle bulges past its own parallel. */
function degreesFor(m: number, lat: number): { dLat: number; dLng: number } {
  const R = 6_371_000;
  const d = m / R;
  const cosLat = Math.max(0.01, Math.cos((Math.abs(lat) * Math.PI) / 180));
  const s = Math.sin(Math.min(d, Math.PI / 2)) / cosLat;
  const dLng = s >= 1 ? 180 : (Math.asin(s) * 180) / Math.PI;
  return { dLat: m / M_PER_DEG_LAT, dLng };
}

/** The box to ask the database for: the shape's extent plus the widest edge
 *  margin, with 1% to spare so nothing on the line is missed. Null when the
 *  shape is not complete. */
export function searchBox(
  shape: ZoneShapeInput | null | undefined,
): { south: number; west: number; north: number; east: number } | null {
  const z = zoneFromShape(shape);
  if (!z) return null;
  let south: number, north: number, west: number, east: number;
  let pad: number;
  if (z.geo_match_mode === "polygon") {
    const ring = z.boundary!.coordinates![0];
    south = Math.min(...ring.map((p) => p[1]));
    north = Math.max(...ring.map((p) => p[1]));
    west = Math.min(...ring.map((p) => p[0]));
    east = Math.max(...ring.map((p) => p[0]));
    pad = EDGE_MAX_M * 1.01;
  } else {
    const lat = Number(z.center_latitude);
    const lng = Number(z.center_longitude);
    south = north = lat;
    west = east = lng;
    const reach =
      z.geo_match_mode === "radius"
        ? Number(z.radius_meters)
        : Number(z.drive_time_minutes) * DRIVE_M_PER_MIN;
    pad = (reach + EDGE_MAX_M) * 1.01;
  }
  // Widest at the edge furthest from the equator.
  const { dLat, dLng } = degreesFor(
    pad,
    Math.max(Math.abs(south), Math.abs(north)) + pad / M_PER_DEG_LAT,
  );
  return {
    south: Math.max(-90, south - dLat),
    north: Math.min(90, north + dLat),
    west: Math.max(-180, west - dLng),
    east: Math.min(180, east + dLng),
  };
}

/** Metres from a point to the nearest edge of a ring ([lng, lat] pairs), on
 *  a local flat projection -- plenty for "is this within a few km". */
function distanceToRingMeters(pt: { lat: number; lng: number }, ring: number[][]): number {
  const kx = M_PER_DEG_LAT * Math.cos((pt.lat * Math.PI) / 180);
  const ky = M_PER_DEG_LAT;
  let best = Infinity;
  for (let i = 0; i < ring.length - 1; i++) {
    const ax = (ring[i][0] - pt.lng) * kx;
    const ay = (ring[i][1] - pt.lat) * ky;
    const bx = (ring[i + 1][0] - pt.lng) * kx;
    const by = (ring[i + 1][1] - pt.lat) * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    best = Math.min(best, Math.hypot(cx, cy));
  }
  return best;
}

export interface ZipClassification {
  /** ZIPs whose center the matcher puts inside the shape, nearest the middle
   *  first, at most MAX_AUTO_ZIPS. */
  inside: string[];
  /** How many were inside before the cap. */
  insideTotal: number;
  /** ZIPs that only partly overlap: offered, never added. Nearest first. */
  edge: string[];
}

export function classifyZipCentroids(
  shape: ZoneShapeInput | null | undefined,
  centroids: ZipCentroid[],
  cap: number = MAX_AUTO_ZIPS,
): ZipClassification {
  const zone = zoneFromShape(shape);
  if (!zone) return { inside: [], insideTotal: 0, edge: [] };

  const middle =
    zone.geo_match_mode === "polygon"
      ? (() => {
          const ring = zone.boundary!.coordinates![0].slice(0, -1);
          return {
            lat: ring.reduce((s, p) => s + p[1], 0) / ring.length,
            lng: ring.reduce((s, p) => s + p[0], 0) / ring.length,
          };
        })()
      : { lat: Number(zone.center_latitude), lng: Number(zone.center_longitude) };
  const reach =
    zone.geo_match_mode === "radius"
      ? Number(zone.radius_meters)
      : zone.geo_match_mode === "drive_time"
        ? Number(zone.drive_time_minutes) * DRIVE_M_PER_MIN
        : 0;

  const inside: Array<{ zip: string; d: number }> = [];
  const edge: Array<{ zip: string; d: number }> = [];
  const seen = new Set<string>();
  for (const c of centroids) {
    if (seen.has(c.zip)) continue;
    seen.add(c.zip);
    const pt = { lat: c.lat, lng: c.lng };
    const d = haversineMeters(middle, pt);
    // The matcher's own answer, with a zone that lists no ZIPs -- so only
    // the geometry can make it match.
    if (matchZone([zone], { point: pt })) {
      inside.push({ zip: c.zip, d });
      continue;
    }
    const outsideBy =
      zone.geo_match_mode === "polygon"
        ? distanceToRingMeters(pt, zone.boundary!.coordinates![0])
        : d - reach;
    if (outsideBy <= Math.min(c.radiusM, EDGE_MAX_M)) edge.push({ zip: c.zip, d });
  }
  const byDistance = (a: { zip: string; d: number }, b: { zip: string; d: number }) =>
    a.d - b.d || a.zip.localeCompare(b.zip);
  inside.sort(byDistance);
  edge.sort(byDistance);
  return {
    inside: inside.slice(0, cap).map((x) => x.zip),
    insideTotal: inside.length,
    edge: edge.map((x) => x.zip),
  };
}

// ── Where each chip came from ────────────────────────────────────────────
//
// The ZIP list is one array on the zone, but the drawer has to know why each
// entry is there, because changing the shape treats them differently:
//
//   fromShape  added by a fill. Removed again when a later shape no longer
//              holds it -- otherwise shrinking a circle would leave the old
//              circle's ZIPs claiming addresses the zone no longer covers.
//   typed      typed or pasted by the owner, or an edge ZIP they ticked. A
//              shape change never removes these; the owner put them there.
//   dismissed  a chip the owner removed. A later fill does not bring it
//              back; "Fill ZIPs from the area" (an explicit ask) does.
//
// Not stored: the zone keeps one list. When an existing zone is opened, the
// saved ZIPs inside its current shape are taken as fromShape and the rest as
// typed (see `baselineFill`) -- the one reading that never removes a ZIP the
// owner added by hand.

export interface ZipListState {
  zips: string[];
  fromShape: string[];
  typed: string[];
  dismissed: string[];
}

export function initialZipState(saved: string[] | null | undefined): ZipListState {
  const zips = Array.from(new Set(saved ?? []));
  // Until the saved shape has been looked up, every saved ZIP counts as the
  // owner's: a shape change before then can add, and can never remove.
  return { zips, fromShape: [], typed: [...zips], dismissed: [] };
}

/** An existing zone, once its current shape's ZIPs are known: which saved
 *  ZIPs the shape accounts for, and which inside ZIPs are missing. Changes
 *  nothing on the list -- filling an existing zone is the owner's click. */
export function baselineFill(
  state: ZipListState,
  inside: string[],
): { state: ZipListState; missing: string[] } {
  const ins = new Set(inside);
  const fromShape = state.zips.filter((z) => ins.has(z));
  const typed = state.zips.filter((z) => !ins.has(z));
  const missing = inside.filter((z) => !state.zips.includes(z));
  return { state: { ...state, fromShape, typed }, missing };
}

export interface FillResult {
  state: ZipListState;
  added: string[];
  removed: string[];
}

/** The shape changed and now holds `inside`. Add what is new (unless the
 *  owner removed it), drop what only the old shape held, keep everything the
 *  owner typed. With `explicit`, a removed chip comes back too. */
export function applyShapeFill(
  state: ZipListState,
  inside: string[],
  { explicit = false }: { explicit?: boolean } = {},
): FillResult {
  const ins = new Set(inside);
  const typed = new Set(state.typed);
  const dismissed = new Set(explicit ? [] : state.dismissed);
  const removed = state.fromShape.filter((z) => !ins.has(z) && !typed.has(z));
  const kept = state.zips.filter((z) => !removed.includes(z));
  const added = inside.filter((z) => !kept.includes(z) && !dismissed.has(z));
  const zips = [...kept, ...added];
  const fromShape = zips.filter((z) => ins.has(z) && !typed.has(z));
  return {
    state: { zips, fromShape, typed: state.typed, dismissed: [...dismissed] },
    added,
    removed,
  };
}

/** The owner typed, pasted or ticked these. */
export function addTyped(state: ZipListState, zips: string[]): ZipListState {
  const next = Array.from(new Set([...state.zips, ...zips]));
  return {
    zips: next,
    fromShape: state.fromShape.filter((z) => !zips.includes(z)),
    typed: Array.from(new Set([...state.typed, ...zips])),
    dismissed: state.dismissed.filter((z) => !zips.includes(z)),
  };
}

/** The owner removed these chips. */
export function removeZips(state: ZipListState, zips: string[]): ZipListState {
  const gone = new Set(zips);
  return {
    zips: state.zips.filter((z) => !gone.has(z)),
    fromShape: state.fromShape.filter((z) => !gone.has(z)),
    typed: state.typed.filter((z) => !gone.has(z)),
    dismissed: Array.from(new Set([...state.dismissed, ...zips])),
  };
}

/** Which of these ZIPs another zone already lists, and which zone. */
export function claimedElsewhere(
  zips: string[],
  otherZones: Array<{ id: string; name: string; zip_codes?: string[] | null }>,
  selfId?: string | null,
): Map<string, string> {
  const owner = new Map<string, string>();
  for (const z of otherZones) {
    if (selfId && z.id === selfId) continue;
    for (const zip of z.zip_codes ?? []) if (!owner.has(zip)) owner.set(zip, z.name);
  }
  const out = new Map<string, string>();
  for (const zip of zips) {
    const name = owner.get(zip);
    if (name) out.set(zip, name);
  }
  return out;
}

// ── What the drawer says after a fill ────────────────────────────────────

export type FillView = {
  status: "idle" | "loading" | "done" | "error";
  inside: string[];
  insideTotal: number;
  edge: string[];
  added: number;
  removed: number;
  candidatesCapped: boolean;
  tooLarge: boolean;
  /** An existing zone's area, looked up on open and not applied. */
  baseline: boolean;
};

export const IDLE_FILL: FillView = {
  status: "idle",
  inside: [],
  insideTotal: 0,
  edge: [],
  added: 0,
  removed: 0,
  candidatesCapped: false,
  tooLarge: false,
  baseline: false,
};

/** One plain sentence (or two) about what the last fill did. */
export function fillStatusText(fill: FillView, areaWord: string): string {
  if (fill.status === "loading") return `Finding the ZIPs inside ${areaWord}…`;
  if (fill.status === "error")
    return "Couldn't look up the ZIPs for this area. You can still type them.";
  if (fill.status !== "done") return "";
  if (fill.tooLarge) {
    return "This area is too large to list ZIPs for. Draw a smaller one, or type the ZIPs.";
  }
  if (fill.insideTotal === 0) {
    return `No ZIP has its center inside ${areaWord}. Make it bigger, or add a nearby ZIP below.`;
  }
  const parts: string[] = [];
  if (fill.baseline) {
    parts.push(
      `${fill.insideTotal} ${fill.insideTotal === 1 ? "ZIP has its" : "ZIPs have their"} center inside ${areaWord}.`,
    );
  } else {
    parts.push(
      fill.added > 0
        ? `Added ${fill.added} ${fill.added === 1 ? "ZIP" : "ZIPs"} with a center inside ${areaWord}.`
        : `The ZIPs inside ${areaWord} are already on the list.`,
    );
    if (fill.removed > 0) {
      parts.push(
        `Removed ${fill.removed} that only the old area held. ZIPs you typed are never removed.`,
      );
    }
  }
  if (fill.insideTotal > MAX_AUTO_ZIPS) {
    parts.push(
      `This area holds ${fill.insideTotal.toLocaleString("en-US")} ZIPs, so only the ${MAX_AUTO_ZIPS.toLocaleString("en-US")} nearest the middle are used. An area this big usually works better as two zones.`,
    );
  }
  if (fill.candidatesCapped) {
    parts.push("The area is big enough that ZIPs far from its middle were not checked.");
  }
  return parts.join(" ");
}
