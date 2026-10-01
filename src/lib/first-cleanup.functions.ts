import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission, resolveCaller } from "@/lib/authz.server";
import {
  MAX_EXTRA_DOG_CENTS,
  MAX_TIERS,
  MAX_TIER_LABEL,
  MAX_TIER_PRICE_CENTS,
  TIER_ID_PATTERN,
  firstCleanupPricingProblem,
  parseFirstCleanupPricing,
  toStoredFirstCleanupPricing,
  type FirstCleanupPricing,
} from "@/lib/first-cleanup";

// The owner's first-cleanup pricing, read and written. See src/lib/first-cleanup.ts
// for the three modes and why the public signup never trusts a price from the
// browser.

export type FirstCleanupSettings = {
  pricing: FirstCleanupPricing;
  /** Every zone and its own flat price, for "flat" mode: the settings card
   *  lists them, and the quote helper offers them. */
  zones: Array<{ id: string; name: string; initialCleanupCents: number }>;
};

/** Any member may read it: the new-client wizard and the quote editor are used
 *  by people who cannot edit pricing, and both prefill from it. */
export const getFirstCleanupPricing = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<FirstCleanupSettings> => {
    const { orgId } = await resolveCaller(context.supabase, context.userId);
    const [{ data: org, error: oErr }, { data: zones, error: zErr }] = await Promise.all([
      context.supabase
        .from("organizations")
        .select("first_cleanup_pricing")
        .eq("id", orgId)
        .maybeSingle(),
      context.supabase
        .from("zones")
        .select("id, name, initial_cleanup_cents")
        .eq("organization_id", orgId)
        .order("name"),
    ]);
    if (oErr) throw new Error(oErr.message);
    if (zErr) throw new Error(zErr.message);
    return {
      pricing: parseFirstCleanupPricing(
        (org as { first_cleanup_pricing?: unknown } | null)?.first_cleanup_pricing,
      ),
      zones: (zones ?? []).map((z: any) => ({
        id: z.id as string,
        name: z.name as string,
        initialCleanupCents: Number(z.initial_cleanup_cents ?? 0),
      })),
    };
  });

const pricingSchema = z.object({
  mode: z.enum(["off", "flat", "by_last_cleaned"]),
  tiers: z
    .array(
      z.object({
        id: z.string().regex(TIER_ID_PATTERN),
        label: z.string().trim().min(1).max(MAX_TIER_LABEL),
        priceCents: z.number().int().min(0).max(MAX_TIER_PRICE_CENTS),
      }),
    )
    .max(MAX_TIERS),
  perExtraDogCents: z.number().int().min(0).max(MAX_EXTRA_DOG_CENTS),
});

/** Same permission as editing a zone's rates: this is a price list. The CHECK
 *  on the column holds the same limits, so the owner reads a sentence here
 *  rather than a constraint name there. */
export const setFirstCleanupPricing = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => pricingSchema.parse(d))
  .handler(async ({ data, context }) => {
    const problem = firstCleanupPricingProblem(data);
    if (problem) throw new Error(problem);
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_pricing");
    const { updateOwnOrg } = await import("@/lib/org-write.server");
    await updateOwnOrg(context.supabase, orgId, {
      first_cleanup_pricing: toStoredFirstCleanupPricing(data),
    });
    return { ok: true as const, pricing: data };
  });
