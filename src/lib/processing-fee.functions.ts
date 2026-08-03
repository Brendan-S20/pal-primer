import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import {
  quoteProcessingFee,
  SURCHARGE_BANNED_REGIONS,
  stripeCostCents,
} from "@/lib/processing-fee";

// Who pays Stripe's cost of acceptance — the tenant's own setting, and the
// attestation that makes a card surcharge lawful for them specifically.
//
// Gated on `manage_org_billing`, the same permission as connecting Stripe at
// all. Turning this on changes what a homeowner is charged, so it belongs with
// the other money decisions and not with general settings.

/** A worked example, so the screen shows real numbers rather than a percentage. */
function exampleFor(
  baseCents: number,
  passThroughEnabled: boolean,
  attested: boolean,
  region: string | null,
) {
  const card = quoteProcessingFee({
    baseCents,
    rail: "card",
    funding: "credit",
    merchantRegion: region,
    passThroughEnabled,
    attested,
  });
  const ach = quoteProcessingFee({
    baseCents,
    rail: "ach",
    passThroughEnabled,
    attested,
    merchantRegion: region,
  });
  return {
    baseCents,
    card: {
      surchargeCents: card.surchargeCents,
      totalCents: card.totalCents,
      shortfallCents: card.shortfallCents,
      suppressed: card.suppressed,
    },
    ach: {
      surchargeCents: ach.surchargeCents,
      totalCents: ach.totalCents,
      shortfallCents: ach.shortfallCents,
      suppressed: ach.suppressed,
    },
  };
}

export const getProcessingFeeSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { orgId } = await requirePermission(
      context.supabase,
      context.userId,
      "manage_org_billing",
    );
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await (supabaseAdmin as any)
      .from("organizations")
      .select("payment_fee_pass_through, card_surcharge_attested_at, stripe_merchant_region")
      .eq("id", orgId)
      .maybeSingle();

    const passThroughEnabled = !!data?.payment_fee_pass_through;
    const attestedAt: string | null = data?.card_surcharge_attested_at ?? null;
    const region: string | null = data?.stripe_merchant_region ?? null;

    return {
      passThroughEnabled,
      attestedAt,
      merchantRegion: region,
      /**
       * Whether a card surcharge could ever apply here. Separate from whether
       * one currently does, because "your state forbids this" and "you have not
       * switched it on" need different words on the screen.
       */
      regionAllowsCardSurcharge: region ? !SURCHARGE_BANNED_REGIONS.includes(region) : null,
      bannedRegions: SURCHARGE_BANNED_REGIONS,
      // $60 is close to the median HoundStack invoice, and it is below the $300
      // where the 3% cap stops binding — so the example shows the shortfall
      // rather than hiding it behind a flattering number.
      example: exampleFor(6_000, passThroughEnabled, !!attestedAt, region),
      /** What the tenant pays Stripe today on that example, absorbing it all. */
      absorbedCostCents: stripeCostCents(6_000, "card"),
    };
  });

export const setProcessingFeePassThrough = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ enabled: z.boolean() }))
  .handler(async ({ context, data }) => {
    const { orgId } = await requirePermission(
      context.supabase,
      context.userId,
      "manage_org_billing",
    );
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await (supabaseAdmin as any)
      .from("organizations")
      .update({ payment_fee_pass_through: data.enabled })
      .eq("id", orgId);
    if (error) throw new Error(error.message);
    return { passThroughEnabled: data.enabled };
  });

/**
 * Record that the tenant notified the card networks and their acquirer.
 *
 * We cannot do this for them. On a direct charge the connected account is the
 * merchant of record, so Visa's and Mastercard's 30-days-notice requirement
 * falls on each tenant individually — a platform cannot file one notice
 * covering everybody. This stores the date they said they had, which is the
 * fact worth holding if a network ever asks.
 *
 * Clearing it (`attested: false`) turns card surcharging off immediately and is
 * deliberately always allowed, so a tenant who relocates or changes their mind
 * is never stuck surcharging.
 */
export const attestCardSurcharge = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ attested: z.boolean() }))
  .handler(async ({ context, data }) => {
    const { orgId } = await requirePermission(
      context.supabase,
      context.userId,
      "manage_org_billing",
    );
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    if (data.attested) {
      // Refuse in a state where surcharging is prohibited outright, rather than
      // storing an attestation that could never be acted on. `quoteProcessingFee`
      // would suppress it anyway; failing here means the tenant is told why
      // instead of wondering why the fee never appears.
      const { data: org } = await (supabaseAdmin as any)
        .from("organizations")
        .select("stripe_merchant_region")
        .eq("id", orgId)
        .maybeSingle();
      const region: string | null = org?.stripe_merchant_region ?? null;
      if (!region) {
        throw new Error(
          "We don't have your business's state yet. Finish Stripe onboarding, then try again.",
        );
      }
      if (SURCHARGE_BANNED_REGIONS.includes(region)) {
        throw new Error(
          `Card surcharging is prohibited in ${region}. You can still pass bank (ACH) fees through.`,
        );
      }
    }

    const { error } = await (supabaseAdmin as any)
      .from("organizations")
      .update({ card_surcharge_attested_at: data.attested ? new Date().toISOString() : null })
      .eq("id", orgId);
    if (error) throw new Error(error.message);
    return { attested: data.attested };
  });
