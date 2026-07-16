// QA round 8 (zone correctness): retroactive zone detection.
//
// Editing a zone used to leave every existing property on its stale zone —
// only re-saving a property's address re-ran detection. After any zone
// create/update/delete, redetectZonesForOrg re-runs the same matcher over
// every non-archived property in the org and updates:
//   - auto_zone_id: always kept in sync with what the matcher detects.
//   - zone_id: follows auto_zone_id UNLESS the property has a manual
//     override (zone_override_reason set — same rule updateProperty uses).
//     Overridden properties keep their chosen zone_id untouched.
// Returns the number of properties whose row actually changed so the UI
// can toast "Zone saved. N properties re-assigned."

import { matchZone } from "@/lib/zone-match";

export async function redetectZonesForOrg(supabase: any, orgId: string): Promise<number> {
  const { data: zones, error: zErr } = await supabase
    .from("zones")
    .select(
      "id, priority, postal_prefix, zip_codes, geo_match_mode, boundary, center_latitude, center_longitude, radius_meters, drive_time_minutes",
    )
    .eq("organization_id", orgId);
  if (zErr) throw new Error(zErr.message);

  const { data: props, error: pErr } = await supabase
    .from("properties")
    .select("id, postal_code, latitude, longitude, auto_zone_id, zone_id, zone_override_reason")
    .eq("organization_id", orgId)
    .is("archived_at", null);
  if (pErr) throw new Error(pErr.message);

  let updated = 0;
  for (const p of props ?? []) {
    const match = matchZone((zones ?? []) as any[], {
      postalCode: p.postal_code,
      point:
        p.latitude != null && p.longitude != null
          ? { lat: Number(p.latitude), lng: Number(p.longitude) }
          : null,
    });
    const autoZoneId = match ? (match.id as string) : null;
    const hasOverride = !!p.zone_override_reason;
    const patch: Record<string, any> = {};
    if (p.auto_zone_id !== autoZoneId) patch.auto_zone_id = autoZoneId;
    if (!hasOverride && p.zone_id !== autoZoneId) patch.zone_id = autoZoneId;
    if (Object.keys(patch).length === 0) continue;

    const { error: uErr } = await supabase.from("properties").update(patch).eq("id", p.id);
    if (uErr) throw new Error(uErr.message);
    updated += 1;
  }
  return updated;
}
