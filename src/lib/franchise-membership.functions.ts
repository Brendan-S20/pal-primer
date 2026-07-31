import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";

// BUILD-6 — the CHILD side of a franchise relationship.
//
// Deliberately NOT in franchise.functions.ts, and deliberately NOT behind the
// `franchise_structure` entitlement.
//
// Everything in franchise.functions.ts runs through a funnel that requires
// Enterprise, which is correct for the PARENT: "parent and child organization
// structure with full rollup" is what the pricing page sells at that tier. But
// the child is not buying that capability — they are a location someone else
// recruited. Gating redemption behind Enterprise would mean a franchisee on
// Launch could never join, so the feature would only work if every location
// independently bought the most expensive plan. That is not the product.
//
// Leaving, by contrast, is NOT the child's to do — see the note at the bottom
// of this file.
//
// Owner-only on both sides, enforced in SQL as well as here — joining a
// franchise changes who can see this organization's numbers, which is not a
// decision an office manager should make alone.

export const getMyFranchiseMembership = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { orgId } = await requirePermission(
      context.supabase,
      context.userId,
      "manage_settings",
    );
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Service-role on purpose: the whole point is reading the PARENT's name,
    // which the child cannot see under RLS — a child is not a member of its
    // parent any more than the reverse. Scoped to this org's own row, so
    // nothing beyond the one relationship it is party to is exposed.
    const { data: me, error } = await (supabaseAdmin as any)
      .from("organizations")
      .select("id, name, parent_organization_id, franchise_royalty_percent, is_franchise_parent")
      .eq("id", orgId)
      .maybeSingle();
    if (error) throw new Error(error.message);

    let parentName: string | null = null;
    if (me?.parent_organization_id) {
      const { data: parent } = await (supabaseAdmin as any)
        .from("organizations")
        .select("name")
        .eq("id", me.parent_organization_id)
        .maybeSingle();
      parentName = parent?.name ?? null;
    }

    return {
      orgId,
      isChild: !!me?.parent_organization_id,
      isParent: !!me?.is_franchise_parent,
      parentOrganizationId: (me?.parent_organization_id as string | null) ?? null,
      parentName,
      // The child can SEE what they owe. The parent sets it (BUG-19 protects the
      // column), but a franchisee being unable to see their own royalty rate in
      // a product that bills them for it would be indefensible.
      royaltyPercent: Number(me?.franchise_royalty_percent ?? 0),
    };
  });

export const joinFranchise = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ code: z.string().trim().min(6).max(24) }).parse(d))
  .handler(async ({ data, context }) => {
    // Ungated by plan — see the file header. Still owner-only, and the SQL
    // re-checks that independently rather than trusting this layer.
    await requirePermission(context.supabase, context.userId, "manage_settings");

    // Runs on the CALLER's client so auth.uid() inside the SECURITY DEFINER
    // function is the real person consenting. Using the service-role client
    // here would make the function unable to tell who was joining, which is the
    // one fact it exists to establish.
    const { data: parentId, error } = await (context.supabase as any).rpc(
      "redeem_franchise_link_code",
      { _code: data.code },
    );
    if (error) throw new Error(error.message);
    return { ok: true as const, parentOrganizationId: parentId as string };
  });

// BUILD-6: leaveFranchise was removed here (owner decision, 2026-07-30).
//
// I had built it so a franchisee could detach themselves, reasoning that a
// relationship you can enter and cannot exit is a trap. That is wrong for
// franchising: a franchisee is contractually bound, and exit is governed by the
// franchise agreement rather than by a button. A location that could silently
// detach — stopping the royalty accrual its parent depends on — would let the
// product override the contract.
//
// Membership is the parent's to grant and to end. The abandonment case the
// button was protecting against is covered by platform support, who can unlink
// on request; see unlink_franchise_child.
