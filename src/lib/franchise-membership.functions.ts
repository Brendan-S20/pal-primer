import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import type { AdjustmentLedgerRow } from "@/lib/franchise-adjustments";
import type { SettlementRow } from "@/lib/franchise-settlement";

// BUILD-6 — franchise MEMBERSHIP: how a location's place in a franchise starts
// and how it ends.
//
// Mostly the CHILD side — joining, and reading what the franchise bills you —
// plus the one parent-side act that belongs with them rather than with the
// rollup: removing a location (`removeFranchiseLocation`, at the foot of this
// file). Everything here is deliberately NOT in franchise.functions.ts and
// deliberately NOT behind the `franchise_structure` entitlement, for two
// different reasons that are each written where they apply.
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

    // ── WAS THIS ORGANIZATION EVER IN A FRANCHISE? ──────────────────────────
    //
    // `unlink_franchise_child` clears `parent_organization_id` and deliberately
    // preserves everything already raised: "Royalty invoices already raised are
    // intentionally preserved — unlinking is not a way to erase what was owed."
    // The SETTINGS PAGE then erased them anyway, because both ledgers on it
    // were mounted behind `isChild`. The server functions kept returning the
    // rows the whole time — `getMyFranchiseSettlements` filters on
    // `child_organization_id` and `franchise_adjustment_ledger` matches either
    // side of the relationship, neither of which reads
    // `parent_organization_id` — so this was the UI contradicting the database
    // about a statement the location may still owe money on.
    //
    // Only asked when the organization is NOT currently a child, so an org that
    // has never been near a franchise pays for two head counts and nothing
    // else, and the two ledger panels are not mounted at all for it.
    let hasFranchiseHistory = false;
    if (!me?.parent_organization_id) {
      const [statements, adjustments] = await Promise.all([
        (supabaseAdmin as any)
          .from("franchise_royalty_invoices")
          .select("id", { count: "exact", head: true })
          .eq("child_organization_id", orgId)
          .neq("status", "draft"),
        (supabaseAdmin as any)
          .from("franchise_adjustments")
          .select("id", { count: "exact", head: true })
          .eq("child_organization_id", orgId),
      ]);
      hasFranchiseHistory =
        Number(statements?.count ?? 0) > 0 || Number(adjustments?.count ?? 0) > 0;
    }

    return {
      orgId,
      isChild: !!me?.parent_organization_id,
      isParent: !!me?.is_franchise_parent,
      parentOrganizationId: (me?.parent_organization_id as string | null) ?? null,
      parentName,
      /** Not a member now, but was: there are settlements or adjustments on
       *  record from a franchise link that has ended. */
      hasFranchiseHistory,
      // The child can SEE what they owe. The parent sets it (BUG-19 protects the
      // column), but a franchisee being unable to see their own royalty rate in
      // a product that bills them for it would be indefensible.
      royaltyPercent: Number(me?.franchise_royalty_percent ?? 0),
    };
  });

/**
 * The bounds a link code can actually have, and what counts as one character
 * of it.
 *
 * `franchise_link_codes.code` carries `CHECK (char_length(code) BETWEEN 8 AND
 * 24)` and `create_franchise_link_code` mints exactly ten characters from a
 * Crockford-ish alphabet with no I, L, O or U. So no code of six or seven
 * characters has ever existed or can ever be issued — and this validator said
 * `min(6)`, with the button on the settings page enabled at the same six.
 *
 * That is the same shape as the ZIP fault found on 2026-08-19: the UI accepted
 * a value the matcher could never honour. It matters more than it looks,
 * because `redeem_franchise_link_code` answers every failure with ONE message
 * — "That code is not valid. Ask the franchise owner for a new one." — and it
 * has to, or it becomes an oracle for guessing codes. A franchisee who typed
 * six of the ten characters was therefore told to go and ask for a new code
 * rather than that they had not finished typing this one. The cases that can
 * be ruled out without asking the database should not reach that message.
 */
export const FRANCHISE_CODE_MIN_LENGTH = 8;
export const FRANCHISE_CODE_MAX_LENGTH = 24;

/**
 * A pasted or dictated code, reduced to the characters a code is made of.
 *
 * The SQL matches on `upper(trim(code))`, which trims the ENDS only. A code
 * read out over the phone and written down as "7K2Z Q9M4 XB", or pasted with a
 * hyphen, therefore cannot match anything however it is cased — and gets the
 * same "ask for a new one" answer as a code that was revoked.
 *
 * Safe because the alphabet is closed: a code contains digits and capitals and
 * nothing else, so a character outside that set is always separator and never
 * content. Deliberately NOT Crockford's letter folding (O→0, I→1) — that would
 * be this layer inventing a match the database does not perform, and the
 * letters it would fold are absent from the alphabet precisely so nobody has
 * to.
 */
export function normalizeFranchiseCode(raw: string): string {
  return raw.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

export const joinFranchise = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        code: z
          .string()
          .transform(normalizeFranchiseCode)
          .refine(
            (c) =>
              c.length >= FRANCHISE_CODE_MIN_LENGTH && c.length <= FRANCHISE_CODE_MAX_LENGTH,
            {
              message:
                "That doesn't look like an invitation code. They are 8 to 24 letters and numbers — check you have the whole thing.",
            },
          ),
      })
      .parse(d),
  )
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

// ── Ending a membership ─────────────────────────────────────────────────────
//
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
//
// THE PARENT'S HALF OF THAT SENTENCE WAS NEVER BUILT. `unlink_franchise_child`
// has been granted to `authenticated` since 2026-07-30 and callable by nobody:
// its only wrapper was deleted on 2026-08-07 as one of the 28 unwired server
// functions, correctly — the removal had been hung off a row in the royalty
// ROLLUP table, which is a reporting surface and the wrong place for an
// operation this size. So "membership is the parent's to end" was true of the
// database and false of the product, and the only way to end a franchise link
// at all was to ask HoundStack support to run the RPC by hand.
//
// This is the wrapper, built back deliberately rather than bare. What makes it
// not a re-add of what was deleted is where it is CALLED from and what it asks
// for: the per-location drawer, which is a screen about one named location
// rather than a row in a table of eight, and a confirmation that states the
// consequences and requires the location's name to be typed — the same bar
// platform tenant deletion sets, for a comparable blast radius.

/**
 * Remove one location from this franchise. The parent's act, never the child's.
 *
 * ── WHY THIS IS NOT BEHIND THE ENTERPRISE ENTITLEMENT ─────────────────────
 *
 * Every other PARENT-side franchise function runs through
 * `requirePermission('manage_franchise')` + `requireEntitlement('franchise_
 * structure')`. This one deliberately stops at the permission, and the SQL
 * agrees — `unlink_franchise_child` has no `has_plan_entitlement` check where
 * `create_franchise_link_code` and `provision_franchise_location` both do.
 *
 * A paywall may withhold a capability. It must not lock somebody INSIDE a
 * relationship. A franchise whose plan lapses from Enterprise loses the
 * rollup, the royalty billing and the ability to recruit — all of which are
 * the things it stopped paying for — but it must still be able to let a
 * location go, and the location must not be left attached to an organization
 * that can no longer administer it. Gating removal would also put this layer
 * in disagreement with the RPC underneath it, which is the fault class this
 * whole area keeps producing.
 *
 * ── THE TYPED NAME IS CHECKED HERE, NOT ONLY IN THE DIALOG ────────────────
 *
 * Guardrail 10.4: a confirmation a caller can skip by posting to the server
 * function directly is a confirmation in name only. Same shape, and the same
 * reason, as `softDeleteTenant`'s `confirm_name`.
 *
 * ── WHAT IS DELIBERATELY NOT DONE HERE ────────────────────────────────────
 *
 * Nothing is written from this layer. The row read below is to authorize the
 * caller against the real relationship and to check the typed name; the write
 * is `unlink_franchise_child` on the CALLER's client, so `auth.uid()` inside
 * the SECURITY DEFINER routine is the real person and it re-authorizes
 * independently rather than trusting anything decided here.
 */
export const removeFranchiseLocation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        organizationId: z.string().uuid(),
        /** The location's name, typed by the person doing this. */
        confirmName: z.string().trim().min(1),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { orgId } = await requirePermission(
      context.supabase,
      context.userId,
      "manage_franchise",
    );

    // Service-role, and pinned to the relationship: a parent is not a member of
    // its locations, so no tenant-scoped client can read this row at all. The
    // parentage check below is what keeps that narrow — a caller can name any
    // uuid and only ever learn about an organization that is already theirs.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: child, error } = await (supabaseAdmin as any)
      .from("organizations")
      .select("id, name, parent_organization_id")
      .eq("id", data.organizationId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!child || child.parent_organization_id !== orgId) {
      throw new Error("That location is not part of your franchise.");
    }

    const name = String(child.name ?? "");
    if (name.trim() !== data.confirmName.trim()) {
      throw new Error(
        `Type the location's name exactly — "${name}" — to confirm removing it.`,
      );
    }

    const { error: rpcError } = await (context.supabase as any).rpc("unlink_franchise_child", {
      _child_org_id: data.organizationId,
    });
    if (rpcError) throw new Error(rpcError.message);

    // The name is returned so the toast can say which location left, on a
    // screen whose drawer has just closed behind it.
    return { ok: true as const, name };
  });
