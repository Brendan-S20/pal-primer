// Zone matching shared by quoting (New Client wizard), address resolution,
// property auto-assignment, and org-wide redetection. Pure math: callers load
// the org's zones and pass them in.
//
// Precedence (QA round 3, finding B3 — a huge radius on one zone must never
// swallow another zone's home ZIP):
//   1. Specificity level:
//        polygon containment (a drawn boundary is an exact claim on the area)
//      > exact ZIP match
//      > postal-prefix match
//      > radius / drive-time containment (proximity only)
//      Address-derived signals (ZIP, prefix) always beat proximity-only
//      matches. This is the B3 fix: 78701 belongs to the zone that names
//      78701, not to whichever zone drew the biggest circle.
//   2. `priority` (higher wins) breaks ties among zones matching at the
//      SAME specificity level.
//   3. Type-appropriateness: when the property's account type is known, a
//      zone typed for it beats an untyped zone, which beats a mismatched
//      one. A commercial property prefers the commercial zone; the manual
//      per-property zone override (zone_override_reason) remains the
//      escape hatch when the business wants something else.
//   4. Longest postal prefix among equal candidates, then id so the result
//      is deterministic regardless of caller sort order.
// Mirrored in the public_quote RPC (ZIP levels only — signups have no point).
//
// A zone that is turned off (`enabled === false`, #449) never matches here or
// in public_quote. A row read without the column (undefined) counts as on, so
// a caller that forgets to select it behaves as it did before the column
// existed rather than matching nothing.

export interface ZoneMatchFields {
  id: string;
  priority?: number | null;
  account_type?: string | null;
  postal_prefix?: string | null;
  zip_codes?: string[] | null;
  geo_match_mode?: string | null;
  boundary?: { coordinates?: number[][][] } | null;
  center_latitude?: number | string | null;
  center_longitude?: number | string | null;
  radius_meters?: number | null;
  drive_time_minutes?: number | null;
  /** False when an owner has turned the zone off (#449). */
  enabled?: boolean | null;
}

/** On unless explicitly turned off. */
export function zoneIsOn(z: { enabled?: boolean | null }): boolean {
  return z.enabled !== false;
}

export interface ZoneMatchInput {
  postalCode?: string | null;
  point?: { lat: number; lng: number } | null;
  /** Property/client account type, when known. Used as a late tie-breaker. */
  accountType?: "residential" | "commercial" | null;
}

export function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function pointInPolygon(point: { lat: number; lng: number }, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect =
      yi > point.lat !== yj > point.lat &&
      point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Rough urban driving speed used to turn drive-time into a radius. The ONE
 *  definition: the coverage map draws with it, and the ZIP fill
 *  (zone-zip-fill.ts) asks matchZone itself, so a drive-time zone's circle,
 *  its auto-filled ZIPs and the properties it claims are the same circle. */
export const DRIVE_M_PER_MIN = 800;

/** Specificity levels — lower is more specific. */
const LEVEL_POLYGON = 0;
const LEVEL_EXACT_ZIP = 1;
const LEVEL_PREFIX = 2;
const LEVEL_PROXIMITY = 3;

export function matchZone<Z extends ZoneMatchFields>(zones: Z[], input: ZoneMatchInput): Z | null {
  const pc = (input.postalCode ?? "").trim();
  const pt = input.point ?? null;
  const acct = input.accountType ?? null;

  const best = zones
    .filter(zoneIsOn)
    .map((z) => {
      const mode = (z.geo_match_mode ?? "zip") as string;
      // A zone can match on several criteria at once (e.g. a radius zone
      // that also lists the exact ZIP). Score it at its BEST level so the
      // ZIP listing counts even when the geometry also contains the point.
      let level: number | null = null;
      const consider = (l: number) => {
        if (level === null || l < level) level = l;
      };

      if (pt) {
        if (mode === "polygon" && z.boundary?.coordinates?.[0]) {
          const ring = z.boundary.coordinates[0] as number[][];
          if (pointInPolygon(pt, ring)) consider(LEVEL_POLYGON);
        }
        if (
          mode === "radius" &&
          z.center_latitude != null &&
          z.center_longitude != null &&
          z.radius_meters
        ) {
          if (
            haversineMeters(pt, {
              lat: Number(z.center_latitude),
              lng: Number(z.center_longitude),
            }) <= z.radius_meters
          )
            consider(LEVEL_PROXIMITY);
        }
        if (
          mode === "drive_time" &&
          z.center_latitude != null &&
          z.center_longitude != null &&
          z.drive_time_minutes
        ) {
          if (
            haversineMeters(pt, {
              lat: Number(z.center_latitude),
              lng: Number(z.center_longitude),
            }) <=
            z.drive_time_minutes * DRIVE_M_PER_MIN
          )
            consider(LEVEL_PROXIMITY);
        }
      }
      if (pc) {
        if (Array.isArray(z.zip_codes) && z.zip_codes.includes(pc)) consider(LEVEL_EXACT_ZIP);
        else if (z.postal_prefix && pc.startsWith(z.postal_prefix)) consider(LEVEL_PREFIX);
      }
      if (level === null) return null;

      // 0 = typed for this property, 1 = untyped (serves both), 2 = typed
      // for the other kind. Neutral when the property's type is unknown.
      const typeScore = acct == null ? 0 : !z.account_type ? 1 : z.account_type === acct ? 0 : 2;

      return { z, level: level as number, typeScore, prefLen: (z.postal_prefix ?? "").length };
    })
    .filter((m): m is { z: Z; level: number; typeScore: number; prefLen: number } => m !== null)
    .sort(
      (a, b) =>
        a.level - b.level ||
        (b.z.priority ?? 0) - (a.z.priority ?? 0) ||
        a.typeScore - b.typeScore ||
        b.prefLen - a.prefLen ||
        String(a.z.id).localeCompare(String(b.z.id)),
    )[0];

  return best ? best.z : null;
}
