// Zone matching shared by quoting (New Client wizard) and property
// auto-assignment (client detail refactor). Pure math: callers load the
// org's zones and pass them in.
//
// Precedence: polygon containment beats radius/drive-time proximity, which
// beats an exact ZIP match, which beats a postal-prefix match (longest
// prefix wins). Mirrors the original getInternalQuote behavior exactly.

export interface ZoneMatchFields {
  id: string;
  postal_prefix?: string | null;
  zip_codes?: string[] | null;
  geo_match_mode?: string | null;
  boundary?: { coordinates?: number[][][] } | null;
  center_latitude?: number | string | null;
  center_longitude?: number | string | null;
  radius_meters?: number | null;
  drive_time_minutes?: number | null;
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

/** Rough urban driving speed used to turn drive-time into a radius. */
const DRIVE_M_PER_MIN = 800;

export function matchZone<Z extends ZoneMatchFields>(
  zones: Z[],
  input: { postalCode?: string | null; point?: { lat: number; lng: number } | null },
): Z | null {
  const pc = (input.postalCode ?? "").trim();
  const pt = input.point ?? null;

  const best = zones
    .map((z) => {
      const mode = (z.geo_match_mode ?? "zip") as string;
      // Geo match takes precedence when configured and we have a point
      if (pt) {
        if (mode === "polygon" && z.boundary?.coordinates?.[0]) {
          const ring = z.boundary.coordinates[0] as number[][];
          if (pointInPolygon(pt, ring)) return { z, rank: -2, prefLen: 0 };
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
            return { z, rank: -1, prefLen: 0 };
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
            return { z, rank: -1, prefLen: 0 };
        }
      }
      if (!pc) return null;
      const exact = Array.isArray(z.zip_codes) && z.zip_codes.includes(pc);
      const prefix = z.postal_prefix && pc.startsWith(z.postal_prefix);
      if (!exact && !prefix) return null;
      return { z, rank: exact ? 0 : 1, prefLen: (z.postal_prefix ?? "").length };
    })
    .filter((m): m is { z: Z; rank: number; prefLen: number } => m !== null)
    .sort((a, b) => a.rank - b.rank || b.prefLen - a.prefLen)[0];

  return best ? best.z : null;
}
