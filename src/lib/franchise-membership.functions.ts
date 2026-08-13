import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import type { AdjustmentLedgerRow } from "@/lib/franchise-adjustments";
import type { SettlementRow } from "@/lib/franchise-settlement";

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
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_settings");
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

/**
 * The location's own side of the settlement: every deduction taken from it, and
 * for a reversed one, the repayment that cancelled it and the statement it came
 * back on.
 *
 * This is the surface BUG-26 was missing. A franchisee reads a statement and
 * reconciles it against their bank; when a chargeback they were deducted for is
 * later won, the money returns as a credit on a LATER statement, and until now
 * nothing in the product connected the two. "Both sides can READ an adjustment.
 * A deduction a franchisee cannot look up is indistinguishable from an error,
 * and they will assume the worst" — that was the rule when the table was built;
 * this is it applied to the reversal trail.
 *
 * Ungated by plan, like the rest of the child side: a location is not buying
 * franchise management, it is being billed by one.
 *
 * `view_financials` rather than `manage_settings`: these are money lines. The
 * SQL re-checks it independently against the org id, so nothing here is load
 * bearing for authorization.
 */
export const getMyFranchiseAdjustments = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "view_financials");
    const { data, error } = await (context.supabase as any).rpc("franchise_adjustment_ledger", {
      _org_id: orgId,
    });
    if (error) throw new Error(error.message);
    return { rows: (data ?? []) as AdjustmentLedgerRow[] };
  });

/**
 * The settlement statements this location has been issued.
 *
 * ── THE GAP THIS CLOSES ───────────────────────────────────────────────────
 *
 * A franchise owner generated statements, pressed Issue, and pressed Mark
 * paid. All three happened on the parent's screen. The location — the party
 * the statement bills — had no way to read one. RLS on
 * `franchise_royalty_invoices` is `can_write_org(auth.uid(),
 * parent_organization_id)`: the parent's office and nobody else. There was no
 * server function for the child side and no screen for it.
 *
 * So "Issue" moved a status column and delivered nothing. The location learned
 * what it owed by being told out of band, which makes the software a private
 * notebook rather than a shared record.
 *
 * This is the same rule the rest of this file already runs on, applied to the
 * document instead of the rate: "a franchisee being unable to see their own
 * royalty rate in a product that bills them for it would be indefensible", and
 * "a deduction a franchisee cannot look up is indistinguishable from an error,
 * and they will assume the worst". A whole statement they cannot look up is
 * that fault at full size.
 *
 * ── WHY SERVICE-ROLE, AND WHY THAT IS NARROW ──────────────────────────────
 *
 * A location is not a member of its franchise, so no tenant-scoped client can
 * read a row whose other party is the parent — the same wall every cross-org
 * read in BUILD-6 hits. The read is pinned to `child_organization_id = orgId`,
 * so it can only ever return statements this organization is itself the
 * subject of. This is not a new pattern: `buildFranchiseSettlements` in the CPA
 * pack has read the same table the same way, for the same reason, since the
 * report pack shipped.
 *
 * ── DRAFTS ARE NOT DELIVERED ──────────────────────────────────────────────
 *
 * `settlementIsDelivered` is the predicate and `franchise-settlement.ts`
 * carries the argument: the generator rewrites drafts freely, so a draft is a
 * figure still moving. Issuing is what turns it into a bill, and that is what
 * makes the Issue button mean something. The CPA pack deliberately differs —
 * it includes drafts, labelled, because a tax pack that omits rows is
 * incomplete — and that difference is intentional rather than drift.
 *
 * Ungated by plan, like the rest of the child side: a location is not buying
 * franchise management, it is being billed by one. `view_financials` because
 * these are money lines.
 */
export const getMyFranchiseSettlements = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "view_financials");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data, error } = await (supabaseAdmin as any)
      .from("franchise_royalty_invoices")
      .select(
        "id, period_start, period_end, revenue_cents, royalty_percent, royalty_cents, amount_cents, adjustments_applied_cents, direction, net_due_cents, status",
      )
      .eq("child_organization_id", orgId)
      .neq("status", "draft")
      .order("period_start", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);

    return { statements: (data ?? []) as SettlementRow[] };
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
