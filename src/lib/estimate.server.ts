// Recompute a property's effective on-site minutes (client detail refactor).
//
// properties.service_duration_min stays NOT NULL because routing/ETA math
// reads it directly. Semantics after the refactor:
//   est_override_at set   -> the value is an authorized manual override
//   est_override_at null  -> the value is auto-calculated; call this helper
//                            after anything that feeds the formula changes
//                            (boundary, dogs, service cadence, hazards).

import {
  computeEstimatedMinutes,
  countPropertyHazards,
  resolveEstTimeConfig,
} from "@/lib/estimated-time";

export async function recomputePropertyEstimate(
  supabase: any,
  propertyId: string,
): Promise<number | null> {
  const { data: prop, error } = await supabase
    .from("properties")
    .select(
      "id, organization_id, boundary_area_sqm, est_override_at, invisible_fence, escape_risk, dog_in_yard_during_service, aggressive_dog, bees_wasps, sharp_objects, slippery_surfaces, do_not_enter_if_dog_out",
    )
    .eq("id", propertyId)
    .single();
  if (error || !prop) return null;
  if (prop.est_override_at) return null; // manual override wins

  const [{ count: dogCount }, { data: subs }, { data: org }] = await Promise.all([
    supabase
      .from("dogs")
      .select("id", { count: "exact", head: true })
      .eq("property_id", propertyId)
      .eq("active", true),
    supabase
      .from("subscriptions")
      .select("frequency, interval_weeks, interval_days, status")
      .eq("property_id", propertyId)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1),
    supabase
      .from("organizations")
      .select("est_time_config")
      .eq("id", prop.organization_id)
      .single()
      .then((r: any) => r),
  ]);

  const sub = subs?.[0];
  const minutes = computeEstimatedMinutes(
    {
      boundaryAreaSqm: prop.boundary_area_sqm ? Number(prop.boundary_area_sqm) : null,
      dogCount: dogCount ?? 0,
      frequency: sub?.frequency ?? "weekly",
      intervalWeeks: sub?.interval_weeks ?? null,
      intervalDays: sub?.interval_days ?? null,
      hazardCount: countPropertyHazards(prop),
    },
    resolveEstTimeConfig(org?.est_time_config),
  );
  if (minutes == null) return null;

  const { error: uErr } = await supabase
    .from("properties")
    .update({ service_duration_min: minutes })
    .eq("id", propertyId);
  if (uErr) {
    console.warn("estimate recompute failed:", uErr.message);
    return null;
  }
  return minutes;
}
