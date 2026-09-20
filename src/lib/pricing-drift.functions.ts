// The server side of the rate-card drift report.
//
// Reads only. This file has no mutation and is not a step towards one being
// hidden here later: repricing writes prices, and that belongs in a function
// whose name says so.
//
// The join is subscriptions -> properties -> zones, and the zone taken is the
// PROPERTY's, because that is the one `redetectZonesForOrg` keeps current. See
// the long note at the top of pricing-drift.ts for why the subscription's own
// zone_id is the wrong input even though it looks like the obvious one.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { resolveCaller } from "@/lib/authz.server";
import { computePricingDrift, sortBySeverity, type DriftSubscription } from "@/lib/pricing-drift";

export const getPricingDrift = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { orgId } = await resolveCaller(supabase, userId);

    const { data: org, error: oErr } = await (supabase as any)
      .from("organizations")
      .select("currency, frequency_multipliers")
      .eq("id", orgId)
      .single();
    if (oErr) throw new Error(oErr.message);

    // Only active services. A cancelled subscription's price is history and
    // nobody is going to reprice it, so including them would pad every count
    // in the summary with rows no action can apply to.
    const { data: subs, error: sErr } = await (supabase as any)
      .from("subscriptions")
      .select(
        `id, client_id, frequency, price_cents, dog_count,
         priced_at, priced_from_zone_id, price_overridden_at,
         clients!inner ( id, display_name ),
         properties!inner (
           id, boundary_area_sqm,
           zone:zones!properties_zone_id_fkey ( id, name, base_price_cents, per_dog_addl_cents,
                   pricing_mode, price_per_sqft_cents, price_per_acre_cents,
                   area_min_charge_cents, area_max_charge_cents ),
           auto_zone:zones!properties_auto_zone_id_fkey ( id, name, base_price_cents,
                   per_dog_addl_cents, pricing_mode, price_per_sqft_cents,
                   price_per_acre_cents, area_min_charge_cents, area_max_charge_cents )
         )`,
      )
      .eq("organization_id", orgId)
      .eq("status", "active");
    if (sErr) throw new Error(sErr.message);

    const shaped: DriftSubscription[] = (subs ?? []).map((s: any) => {
      const prop = s.properties;
      // The bare `zones ( … )` embed this replaces became AMBIGUOUS the day
      // properties grew a second FK to zones (auto_zone_id, the detector's
      // column) — PostgREST refused every request with "more than one
      // relationship", and the page rendered its error card for every org.
      // Found 2026-09-20 by the drift E2E spec; invisible to the render-only
      // sweep because a politely-rendered error is still a rendered page.
      // Both relationships are now named, and the effective zone follows the
      // rule the product already keeps at visits.functions.ts:271 — the
      // dispatcher's assignment wins, the detector's guess fills the gap.
      const z = prop?.zone ?? prop?.auto_zone ?? null;
      return {
        id: s.id as string,
        clientId: s.client_id as string,
        // display_name, because clients has no `name` column — the second of
        // two faults stacked on this one query (the ambiguous zones embed hid
        // this one until it was fixed). Between them the page had never built
        // a report for anyone.
        clientName: (s.clients?.display_name as string) ?? "Unnamed client",
        frequency: String(s.frequency),
        priceCents: Number(s.price_cents ?? 0),
        dogCount: s.dog_count == null ? null : Number(s.dog_count),
        zone: z
          ? {
              id: z.id as string,
              name: z.name as string,
              base_price_cents: z.base_price_cents,
              per_dog_addl_cents: z.per_dog_addl_cents,
              pricing_mode: z.pricing_mode,
              // numeric(…) comes back as a string from PostgREST, and
              // `"0.7500" * n` would be a silent NaN in the area maths.
              price_per_sqft_cents: Number(z.price_per_sqft_cents ?? 0),
              price_per_acre_cents: z.price_per_acre_cents,
              area_min_charge_cents: z.area_min_charge_cents,
              area_max_charge_cents: z.area_max_charge_cents,
            }
          : null,
        boundaryAreaSqm: prop?.boundary_area_sqm == null ? null : Number(prop.boundary_area_sqm),
        pricedAt: s.priced_at ?? null,
        pricedFromZoneId: s.priced_from_zone_id ?? null,
        priceOverriddenAt: s.price_overridden_at ?? null,
      };
    });

    const report = computePricingDrift(
      shaped,
      (org?.frequency_multipliers ?? {}) as Record<string, number>,
    );
    return {
      currency: (org?.currency as string) ?? "usd",
      summary: report.summary,
      rows: sortBySeverity(report.rows),
    };
  });
