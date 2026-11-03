// The rows behind lead-service-area.ts's verdict (#439), read once for a list
// of lead locations. Two callers: /leads, which marks each row, and the public
// quote request, which tells the visitor when no zone lists their ZIP
// (R2-25: a 10001 ZIP was thanked and heard nothing, while the office saw
// "Outside your service area").
//
// Every failure reads as "unknown", never "outside": a zone read that fails
// leaves every answer unknown, and a shape whose ZIP centers cannot be looked
// up leaves that zone unsure. A false "outside" costs more than a missing one.

import type { ZoneMatchFields } from "@/lib/zone-match";
import {
  drawnZoneZips,
  leadServiceArea,
  zipFromLocation,
  zoneShape,
  type DrawnZoneZips,
  type LeadAreaVerdict,
} from "@/lib/lead-service-area";
import { MAX_CANDIDATES, searchBox } from "@/lib/zone-zip-fill";

function prefixed(b: { south: number; west: number; north: number; east: number }) {
  return { _south: b.south, _west: b.west, _north: b.north, _east: b.east };
}

/** One verdict per location, in order. `db` is whoever may read the org's
 *  zones: the signed-in office, or the service role for the public form. */
export async function leadServiceAreas(
  db: any,
  orgId: string,
  locations: ReadonlyArray<string | null | undefined>,
): Promise<LeadAreaVerdict[]> {
  const { data: zones, error: zonesErr } = await db
    .from("zones")
    .select(
      "id, priority, account_type, postal_prefix, zip_codes, geo_match_mode, boundary, center_latitude, center_longitude, radius_meters, drive_time_minutes, enabled",
    )
    .eq("organization_id", orgId);
  if (zonesErr) {
    console.error("leads service area lookup failed", orgId, zonesErr);
    return locations.map(() => "unknown");
  }
  // A zone that is turned off (#449) serves nobody new, so it does not make a
  // lead "inside".
  const zoneRows = ((zones ?? []) as unknown as ZoneMatchFields[]).filter(
    (z) => z.enabled !== false,
  );
  const drawn = new Map<string, DrawnZoneZips | null>();
  const anyZip = locations.some((l) => zipFromLocation(l) != null);
  if (anyZip) {
    await Promise.all(
      zoneRows.map(async (z) => {
        const shape = zoneShape(z);
        if (!shape) return;
        const box = searchBox(shape);
        if (!box || box.north - box.south > 10 || box.east - box.west > 10) {
          drawn.set(z.id, null);
          return;
        }
        const { data: rows, error: cErr } = await db.rpc("zip_centroids_in_box", {
          _org_id: orgId,
          ...prefixed(box),
          _limit: MAX_CANDIDATES,
        });
        if (cErr) {
          console.error("leads zone ZIP centers lookup failed", z.id, cErr);
          drawn.set(z.id, null);
          return;
        }
        const centroids = (
          (rows ?? []) as Array<{ zip: string; lat: number; lng: number; radius_m: number }>
        ).map((r) => ({
          zip: r.zip,
          lat: Number(r.lat),
          lng: Number(r.lng),
          radiusM: Number(r.radius_m),
        }));
        drawn.set(z.id, drawnZoneZips(shape, centroids, centroids.length >= MAX_CANDIDATES));
      }),
    );
  }
  return locations.map((l) => leadServiceArea(l, zoneRows, drawn));
}
