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
//
// QA round 3 (I6, audit integrity): a zone save can silently move many
// properties' effective zone. Every change to the effective zone_id writes a
// zone.reassigned activity entry (client timeline) so the move is explainable
// later, mirroring the manual-override path in updateProperty.

import { matchZone } from "@/lib/zone-match";

export async function redetectZonesForOrg(
  supabase: any,
  orgId: string,
  actorUserId?: string | null,
): Promise<number> {
  const { data: zones, error: zErr } = await supabase
    .from("zones")
    .select(
      "id, name, priority, account_type, postal_prefix, zip_codes, geo_match_mode, boundary, center_latitude, center_longitude, radius_meters, drive_time_minutes",
    )
    .eq("organization_id", orgId);
  if (zErr) throw new Error(zErr.message);
  const zoneName = new Map<string, string>(
    ((zones ?? []) as Array<{ id: string; name: string | null }>).map((z) => [z.id, z.name ?? "a zone"]),
  );

  const { data: props, error: pErr } = await supabase
    .from("properties")
    .select(
      "id, client_id, postal_code, latitude, longitude, account_type, auto_zone_id, zone_id, zone_override_reason, clients(account_type)",
    )
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
      // Type-appropriateness tie-break: property type, falling back to the
      // client's account type when the property doesn't set one.
      accountType: (p.account_type ?? (p.clients as any)?.account_type ?? null) as any,
    });
    const autoZoneId = match ? (match.id as string) : null;
    const hasOverride = !!p.zone_override_reason;
    const patch: Record<string, any> = {};
    if (p.auto_zone_id !== autoZoneId) patch.auto_zone_id = autoZoneId;
    const effectiveChanged = !hasOverride && p.zone_id !== autoZoneId;
    if (effectiveChanged) patch.zone_id = autoZoneId;
    if (Object.keys(patch).length === 0) continue;

    const { error: uErr } = await supabase.from("properties").update(patch).eq("id", p.id);
    if (uErr) throw new Error(uErr.message);
    updated += 1;

    // Audit only the effective (zone_id) reassignment — auto_zone_id tracking
    // is bookkeeping, but the effective zone drives routing and is what staff
    // and clients see. Best-effort: never fail the redetect over a log write.
    if (effectiveChanged) {
      try {
        const { logActivity } = await import("@/lib/activity.server");
        const from = p.zone_id ? (zoneName.get(p.zone_id) ?? "a removed zone") : "no zone";
        const to = autoZoneId ? (zoneName.get(autoZoneId) ?? "a zone") : "no zone";
        await logActivity(supabase, {
          orgId,
          clientId: p.client_id ?? null,
          propertyId: p.id,
          actorUserId: actorUserId ?? null,
          actorLabel: actorUserId ? null : "Zone update",
          kind: "property.zone_reassigned",
          summary: `Service zone re-detected: ${from} to ${to}`,
          meta: { from_zone_id: p.zone_id ?? null, to_zone_id: autoZoneId },
        });
      } catch (e) {
        console.warn("[zones] reassignment activity log failed", (e as Error).message);
      }
    }
  }
  return updated;
}
