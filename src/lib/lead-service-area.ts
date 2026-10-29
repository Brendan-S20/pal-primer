// Is a lead's ZIP somewhere this business works? (#439)
//
// The audit found leads on /leads with New York ZIPs (10001, 10003, 10024)
// for a business whose zones are elsewhere, and nothing on the row said so.
// The office would call, quote and maybe convert a lead it cannot serve.
//
// A lead has no coordinates, only the text the form saved in `location`
// (street, city, "ST 12345", or a bare ZIP). So a zone is asked two ways:
//
//   * by its ZIP list and postal prefix, through matchZone, the same ZIP
//     levels the public_quote RPC uses for a signup;
//   * by its drawn shape (radius, drive time, polygon), through the ZIP's
//     Census center, classified by classifyZipCentroids in zone-zip-fill.ts,
//     the same call the zone editor uses to fill a shape's ZIPs. The caller
//     looks those centers up and passes the result in as `drawn`.
//
// The live demo org is why the second half exists: its main zone lists 145
// ZIPs, and seven more zones are drawn on the map with no ZIPs listed. Asked
// by ZIP alone, those seven could never say no, so every lead would have
// read "unknown" and the warning would never have shown.
//
// "outside" is said only when every zone says no for certain. An edge ZIP
// (its center is just outside a shape, but part of it is probably inside), a
// shape whose centers could not be looked up, or a lookup that hit its row
// cap all leave the answer "unknown". A false "outside" on a lead the
// business can serve costs more than a missing one.

import { matchZone, type ZoneMatchFields } from "@/lib/zone-match";
import {
  classifyZipCentroids,
  zoneFromShape,
  type ZipCentroid,
  type ZoneShapeInput,
} from "@/lib/zone-zip-fill";

export type LeadAreaVerdict = "inside" | "outside" | "unknown";

/** What a drawn zone's shape holds, from the ZIP centers near it. */
export interface DrawnZoneZips {
  inside: ReadonlySet<string>;
  edge: ReadonlySet<string>;
  /** Every center in the shape's search box came back (no row cap hit), so
   *  a ZIP in neither set is outside the shape for certain. */
  complete: boolean;
}

/** The ZIP in the text, read only where a ZIP sits: the text ends with it
 *  (a bare "48067", or "..., Royal Oak MI 48067", optionally "+4" or ", USA"
 *  after it), or it follows a two-letter state ("MI 48067, Royal Oak").
 *  A five-digit run anywhere else is not a ZIP: "26000 Woodward Ave, Royal
 *  Oak" has a house number and no ZIP, and reading 26000 would have called a
 *  lead the business can serve outside its area (#439 review). */
export function zipFromLocation(location: string | null | undefined): string | null {
  const text = (location ?? "").trim();
  const atEnd = text.match(
    /(?:^|[\s,])(\d{5})(?:-\d{4})?\s*(?:,?\s*(?:USA|US|United States))?\.?$/i,
  );
  if (atEnd) return atEnd[1];
  const afterState = [...text.matchAll(/\b[A-Z]{2}\.?\s+(\d{5})(?:-\d{4})?\b/g)];
  return afterState.length ? afterState[afterState.length - 1][1] : null;
}

/** The drawn shape of a zone row, or null when it matches by ZIP only. */
export function zoneShape(z: ZoneMatchFields): ZoneShapeInput | null {
  const shape: ZoneShapeInput = {
    mode: z.geo_match_mode ?? "zip",
    polygon: z.boundary ?? null,
    centerLat: z.center_latitude == null ? null : Number(z.center_latitude),
    centerLng: z.center_longitude == null ? null : Number(z.center_longitude),
    radiusMeters: z.radius_meters ?? null,
    driveTimeMinutes: z.drive_time_minutes ?? null,
  };
  return zoneFromShape(shape) ? shape : null;
}

/** What a shape holds, from the ZIP centers its search box returned.
 *  `capped` is true when the lookup hit its row limit, so some centers in
 *  the box were never seen. */
export function drawnZoneZips(
  shape: ZoneShapeInput,
  centroids: ZipCentroid[],
  capped: boolean,
): DrawnZoneZips {
  const c = classifyZipCentroids(shape, centroids, Number.MAX_SAFE_INTEGER);
  return { inside: new Set(c.inside), edge: new Set(c.edge), complete: !capped };
}

export function leadServiceArea(
  location: string | null | undefined,
  zones: readonly ZoneMatchFields[],
  drawn: ReadonlyMap<string, DrawnZoneZips | null> = new Map(),
): LeadAreaVerdict {
  const zip = zipFromLocation(location);
  if (!zip || zones.length === 0) return "unknown";

  // A listed ZIP or prefix. The zones are passed without geometry: a lead
  // has no point, and the shapes are asked below through the ZIP's center.
  const byZip = zones.map((z) => ({ ...z, geo_match_mode: "zip", boundary: null }));
  if (matchZone(byZip, { postalCode: zip })) return "inside";

  let unsure = false;
  for (const z of zones) {
    if (!zoneShape(z)) continue;
    const held = drawn.get(z.id);
    if (!held) unsure = true;
    else if (held.inside.has(zip)) return "inside";
    else if (held.edge.has(zip) || !held.complete) unsure = true;
  }
  return unsure ? "unknown" : "outside";
}
