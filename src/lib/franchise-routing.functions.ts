import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";

// BUILD-6 — payment routing setup, the parent's side.
//
// Owner: "The parent should be able to control the percentages, which stripe
// accounts are attached to each child."
//
// The SQL for all of this already existed and is REUSED, not rebuilt:
// set_child_royalty_percent, set_location_payment_routing and
// set_chargeback_responsibility were written alongside the money plumbing and
// have been unreachable from the product ever since. What was missing was a
// read — a parent is not a member of its locations, so every RLS-bound query
// for them comes back empty — and a screen. So this file is thin on purpose.
//
// Everything runs on the CALLER's client so auth.uid() inside each SECURITY
// DEFINER routine is the real person. Those routines re-check franchise
// ownership themselves; the checks here are the first gate, not the only one.

async function requireFranchiseParent(supabase: any, userId: string): Promise<string> {
  // Same funnel as the rest of the franchise surface: owner-level permission
  // AND the Enterprise entitlement (BUILD-1). Routing decides whose bank
  // account receives customer money — it is not an office-manager setting, and
  // the SQL agrees independently.
  const { orgId } = await requirePermission(supabase, userId, "manage_franchise");
  const { requireEntitlement } = await import("@/lib/entitlements.server");
  await requireEntitlement(orgId, "franchise_structure");
  return orgId;
}

export type LocationRouting = {
  organizationId: string;
  name: string;
  royaltyPercent: number;
  collectedByParent: boolean;
  chargebackResponsibility: "location" | "split" | "franchise";
  hasOwnAccount: boolean;
  ownAccountReady: boolean;
};

export type PaymentRoutingView = {
  parentOrganizationId: string;
  parentName: string;
  /** Whether the FRANCHISE can accept charges. Everything on this screen that
   *  routes money to the parent depends on it, so it is stated once at the top
   *  rather than repeated as a failure per row. */
  parentHasAccount: boolean;
  parentAccountReady: boolean;
  locations: LocationRouting[];
};

export const getPaymentRouting = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<PaymentRoutingView> => {
    const orgId = await requireFranchiseParent(context.supabase, context.userId);

    const { data: rows, error } = await (context.supabase as any).rpc("franchise_payment_routing");
    if (error) throw new Error(error.message);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: parent } = await (supabaseAdmin as any)
      .from("organizations")
      .select("name, stripe_connect_account_id, stripe_connect_charges_enabled")
      .eq("id", orgId)
      .maybeSingle();

    return {
      parentOrganizationId: orgId,
      parentName: parent?.name ?? "Your franchise",
      parentHasAccount: !!parent?.stripe_connect_account_id,
      parentAccountReady: !!parent?.stripe_connect_charges_enabled,
      locations: (rows ?? []).map((r: any) => ({
        organizationId: r.child_organization_id,
        name: r.child_name,
        royaltyPercent: Number(r.royalty_percent ?? 0),
        collectedByParent: !!r.payments_collected_by_parent,
        chargebackResponsibility: (r.chargeback_responsibility ?? "location") as
          "location" | "split" | "franchise",
        hasOwnAccount: !!r.child_account_id,
        ownAccountReady: !!r.child_charges_enabled,
      })),
    };
  });

export const setLocationCollection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ organizationId: z.string().uuid(), collectedByParent: z.boolean() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireFranchiseParent(context.supabase, context.userId);
    // The SQL refuses to switch this ON unless the franchise's Stripe account
    // can actually take charges. That guard is not duplicated here on purpose:
    // re-implementing it would give two answers to one question, and the one
    // that matters is the one next to the UPDATE.
    const { error } = await (context.supabase as any).rpc("set_location_payment_routing", {
      _child_org_id: data.organizationId,
      _collected_by_parent: data.collectedByParent,
    });
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

export const setLocationChargebackPolicy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        organizationId: z.string().uuid(),
        responsibility: z.enum(["location", "split", "franchise"]),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireFranchiseParent(context.supabase, context.userId);
    const { error } = await (context.supabase as any).rpc("set_chargeback_responsibility", {
      _child_org_id: data.organizationId,
      _responsibility: data.responsibility,
    });
    if (error) throw new Error(error.message);
    // Deliberately NOT retroactive. Each adjustment freezes the policy in force
    // when the reversal happened, so changing this never rewrites a split that
    // has already been agreed — verified live when adjustments were built.
    return { ok: true as const };
  });

export const setLocationRoyaltyPercent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ organizationId: z.string().uuid(), percent: z.number().min(0).max(100) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireFranchiseParent(context.supabase, context.userId);
    const { error } = await (context.supabase as any).rpc("set_child_royalty_percent", {
      _child_org_id: data.organizationId,
      _percent: data.percent,
    });
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });
