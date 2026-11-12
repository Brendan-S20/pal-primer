// The database half of zone-zip-backfill.ts (#793): read an organization's
// zones, look up the Census ZIP centers for each empty drawn one, plan, and --
// only when asked -- write.
//
// Runs as the CALLER. zip_centroids_in_box refuses anyone who is not a member
// of the organization (auth.uid() must be set), so this is an owner's action
// in their own session, not something a service-role job can run for every
// tenant. The all-tenant inventory is read-only SQL in
// scripts/backfill/793-zones-with-a-shape-and-no-zips.sql, and any production
// run of its UPDATEs needs Brendan's explicit approval.

import { zipCentroidsForShape } from "@/lib/zone-zip-fill.server";
import { zoneShape } from "@/lib/lead-service-area";
import {
  planZoneZipBackfill,
  zoneNeedsZipBackfill,
  type BackfillZone,
  type ZoneBackfillPlan,
  type ZoneCentroidLookup,
} from "@/lib/zone-zip-backfill";

const ZONE_COLUMNS =
  "id, name, priority, account_type, postal_prefix, zip_codes, geo_match_mode, boundary, center_latitude, center_longitude, radius_meters, drive_time_minutes, enabled";

export async function planOrgZoneZipBackfill(db: any, orgId: string): Promise<ZoneBackfillPlan> {
  const { data, error } = await db.from("zones").select(ZONE_COLUMNS).eq("organization_id", orgId);
  if (error) throw new Error(error.message);
  const zones = (data ?? []) as BackfillZone[];
  const lookups = new Map<string, ZoneCentroidLookup>();
  for (const zone of zones.filter(zoneNeedsZipBackfill)) {
    try {
      lookups.set(zone.id, await zipCentroidsForShape(db, orgId, zoneShape(zone)!));
    } catch (e) {
      console.error(`[zone-zip-backfill] ZIP lookup failed for org ${orgId}:`, e);
      lookups.set(zone.id, { status: "failed", message: (e as Error).message });
    }
  }
  return planZoneZipBackfill(zones, lookups);
}

/** Write the plan. Each update is guarded on the list still being empty, so
 *  a zone an owner filled in another tab between plan and write keeps what
 *  they saved. Returns the ids of the zones actually written. */
export async function applyZoneZipBackfill(
  db: any,
  orgId: string,
  plan: ZoneBackfillPlan,
): Promise<string[]> {
  const written: string[] = [];
  for (const entry of plan.entries) {
    if (entry.zips.length === 0) continue;
    const { data, error } = await db
      .from("zones")
      .update({ zip_codes: entry.zips })
      .eq("id", entry.zoneId)
      .eq("organization_id", orgId)
      .filter("zip_codes", "eq", "{}")
      .select("id");
    if (error) throw new Error(error.message);
    if ((data ?? []).length > 0) written.push(entry.zoneId);
  }
  return written;
}
