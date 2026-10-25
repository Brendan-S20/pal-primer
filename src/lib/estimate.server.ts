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
import { liveServiceOrFilter } from "@/lib/subscription-form";
import { orgToday } from "@/lib/org-day";

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

  // The org resolves FIRST: the live-service filter below judges "still
  // running" by a date, and this code runs on a UTC worker, where the old
  // todayLocalISO() was the UTC day — tomorrow every US evening, so a
  // service ending today was dropped from the estimate a few hours early.
  // One extra sequential read on a recompute path nobody is waiting on.
  const { data: org } = await supabase
    .from("organizations")
    .select("est_time_config, timezone")
    .eq("id", prop.organization_id)
    .single()
    .then((r: any) => r);

  const [{ count: dogCount }, { data: subs }] = await Promise.all([
    supabase
      .from("dogs")
      .select("id", { count: "exact", head: true })
      .eq("property_id", propertyId)
      .eq("active", true)
      // Dogs only: a sitting client's cat leaves nothing in the yard (#411).
      .eq("species", "dog"),
    // The property's routine service time must come from the RECURRING service
    // that defines its routine — not from whatever row was created last.
    //
    // Two filters, both load-bearing:
    //   * ends_on — a service the tenant ENDED keeps status 'active' in this
    //     schema, so status alone picks up finished work.
    //   * frequency — computeEstimatedMinutes multiplies by initialCleanupFactor
    //     (default 2) for one_time. A single call-out is genuinely a
    //     cleanup-sized job, but it is not this property's ongoing cadence, and
    //     booking one used to make it the newest active subscription for ever.
    //     The estimate would then DOUBLE — not at booking time, but silently on
    //     the next dog change or property edit that triggered a recompute — and
    //     service_duration_min drives routing, ETAs and capacity.
    supabase
      .from("subscriptions")
      .select("frequency, interval_weeks, interval_days, status, ends_on")
      .eq("property_id", propertyId)
      .eq("status", "active")
      .neq("frequency", "one_time")
      // A stay's plans (#411) run every day for a week or two; they are not
      // the property's routine.
      .is("stay_id", null)
      // A training package's lesson plan is booked at its own start and
      // length; it is not the property's routine.
      .is("client_package_id", null)
      .or(liveServiceOrFilter(orgToday(org?.timezone || undefined)))
      .order("created_at", { ascending: false })
      .limit(1),
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
