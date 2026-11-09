// What the quote editor needs to price a service line without being told:
// the org's zones with their rates, its standard price, and what the app
// already knows about the person being quoted. The arithmetic and the rules
// for which price applies live in src/lib/quote-pricing.ts; this only reads.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import { propertyDogTally } from "@/lib/pets";
import type {
  QuoteCurrentPlan,
  QuotePricingZone,
  QuoteStandardPricing,
  QuoteSubject,
} from "@/lib/quote-pricing";

const ZONE_COLUMNS =
  "id, name, priority, postal_prefix, zip_codes, account_type, geo_match_mode, boundary, center_latitude, center_longitude, radius_meters, drive_time_minutes, base_price_cents, per_dog_addl_cents, pricing_mode, price_per_sqft_cents, price_per_acre_cents, area_min_charge_cents, area_max_charge_cents, commercial_base_cents, commercial_per_unit_cents, commercial_per_acre_cents, commercial_per_station_cents, enabled";

export const getQuotePricing = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        clientId: z.string().uuid().nullable().optional(),
        leadId: z.string().uuid().nullable().optional(),
      })
      .parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    // The same permission as writing the quote this prices.
    const { orgId } = await requirePermission(supabase, userId, "manage_client_billing");

    const [zonesRes, orgRes] = await Promise.all([
      (supabase as any)
        .from("zones")
        .select(ZONE_COLUMNS)
        .eq("organization_id", orgId)
        .order("name"),
      supabase
        .from("organizations")
        .select(
          "std_base_price_cents, std_per_dog_addl_cents, frequency_multipliers, one_off_price_cents",
        )
        .eq("id", orgId)
        .single(),
    ]);
    if (zonesRes.error) throw new Error(zonesRes.error.message);
    if (orgRes.error) throw new Error(orgRes.error.message);

    const standard: QuoteStandardPricing = {
      basePriceCents: orgRes.data.std_base_price_cents ?? null,
      perDogAddlCents: orgRes.data.std_per_dog_addl_cents ?? null,
      frequencyMultipliers: (orgRes.data.frequency_multipliers ?? {}) as Record<string, number>,
    };

    let subject: QuoteSubject | null = null;
    let subjectLabel: string | null = null;
    let currentPlan: QuoteCurrentPlan | null = null;

    if (data.clientId) {
      const { data: client, error } = await (supabase as any)
        .from("clients")
        .select("id, account_type")
        .eq("id", data.clientId)
        .eq("organization_id", orgId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (client) {
        // The first property still in use. A client with several is quoted
        // from the oldest; the picker lists every zone for the rest.
        const { data: props, error: pErr } = await (supabase as any)
          .from("properties")
          .select(
            "id, street, postal_code, latitude, longitude, zone_id, boundary_area_sqm, account_type, has_units, total_units",
          )
          .eq("client_id", client.id)
          .eq("organization_id", orgId)
          .is("archived_at", null)
          .order("created_at", { ascending: true })
          .limit(1);
        if (pErr) throw new Error(pErr.message);
        const p = (props ?? [])[0] ?? null;
        let dogRecords = 0;
        if (p) {
          const { count } = await (supabase as any)
            .from("dogs")
            .select("id", { count: "exact", head: true })
            .eq("property_id", p.id)
            .eq("active", true)
            .eq("species", "dog");
          dogRecords = count ?? 0;
        }
        // A client already on a plan is most often quoted for a change to it,
        // so the plan's frequency is the better guess than weekly.
        const { data: subs } = await (supabase as any)
          .from("subscriptions")
          .select("property_id, account_type, frequency, dog_count, price_cents, stay_id")
          .eq("client_id", client.id)
          .eq("organization_id", orgId)
          .eq("status", "active")
          .order("created_at", { ascending: true });
        const active = ((subs ?? []) as any[]).filter((x) => !x.stay_id);
        // The plan on the property being quoted, else the client's oldest.
        const sub = (p && active.find((x) => x.property_id === p.id)) ?? active[0] ?? null;
        const frequency: string | null = sub?.frequency ?? null;
        // The same count as the Clients list, the client record and My Day
        // (propertyDogTally, #429): the dog records, else what the plan bills.
        const dogCount =
          propertyDogTally(
            dogRecords,
            active
              .filter((x) => x.account_type === "residential" && (!p || x.property_id === p.id))
              .map((x) => x.dog_count),
          ).count || null;
        if (sub && typeof sub.price_cents === "number") {
          currentPlan = {
            priceCents: sub.price_cents,
            frequency: sub.frequency ?? null,
            dogCount: sub.account_type === "residential" ? (sub.dog_count ?? null) : null,
          };
        }

        const acct = (p?.account_type ??
          client.account_type ??
          null) as QuoteSubject["accountType"];
        subject = {
          zoneId: p?.zone_id ?? null,
          postalCode: p?.postal_code ?? null,
          point:
            p?.latitude != null && p?.longitude != null
              ? { lat: Number(p.latitude), lng: Number(p.longitude) }
              : null,
          accountType: acct,
          dogCount,
          unitCount: p?.has_units && p?.total_units != null ? Number(p.total_units) : null,
          boundaryAreaSqm: p?.boundary_area_sqm != null ? Number(p.boundary_area_sqm) : null,
          frequency,
        };
        subjectLabel = p?.street || p?.postal_code || null;
      }
    } else if (data.leadId) {
      // A lead's "Service address or ZIP" is free text; the ZIP at its end
      // is the one thing parsed from it. A lead the caller cannot read is
      // simply not used: the quote still opens, with the picker.
      try {
        const { loadLeadForConversion } = await import("@/lib/lead-conversion.server");
        const { parseLeadLocation, normalizeLeadFrequency } = await import("@/lib/lead-conversion");
        const lead = await loadLeadForConversion(supabase, orgId, data.leadId);
        const loc = parseLeadLocation(lead.location);
        subject = {
          postalCode: loc.postalCode || null,
          accountType: "residential",
          dogCount: lead.dog_count ?? null,
          frequency: normalizeLeadFrequency(lead.frequency),
        };
        subjectLabel = loc.postalCode || null;
      } catch {
        subject = null;
      }
    }

    return {
      zones: (zonesRes.data ?? []) as QuotePricingZone[],
      standard,
      subject,
      subjectLabel,
      currentPlan,
      // A one-time cleanup's visit (D12): the owner's extra-visit price,
      // Settings → Client portal. Null when they price each one by hand.
      oneTimeVisitCents: (orgRes.data.one_off_price_cents as number | null | undefined) ?? null,
    };
  });
