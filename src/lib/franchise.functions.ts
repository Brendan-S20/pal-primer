import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { AuthedContext } from "@/lib/server-fn-context";
import { requirePermission } from "@/lib/authz.server";
import { paymentWasReceived, receivedPaymentStatuses } from "@/lib/revenue";
import { REVERSAL_KINDS, reducesIncome } from "@/lib/cpa-reports";
import type { AdjustmentLedgerRow } from "@/lib/franchise-adjustments";

// Franchise rollup is owner-only — every function in this file is gated on
// manage_franchise, matching the /franchise route boundary.
//
// BUILD-1: and on the plan. The pricing page sells "Parent and child
// organization structure with full rollup" and "Franchise management, royalty
// billing, and regional dashboards" at Enterprise only; the app was serving
// both to any owner on any plan, including $79 Launch. Both checks run on every
// call, in this one funnel (guardrail 10.4).
//
// Q-9 said to grandfather existing multi-entity tenants indefinitely. There are
// none — no organization in the database has a parent or a child (verified
// live), so nothing is being taken away from anyone. If that changes before
// this ships, the grandfather clause belongs here, as a bypass keyed on the org
// already having children, not as a hole in the matrix.
async function resolveOrgId(supabase: any, userId: string): Promise<string> {
  const { orgId } = await requirePermission(supabase, userId, "manage_franchise");
  const { requireEntitlement } = await import("@/lib/entitlements.server");
  await requireEntitlement(orgId, "franchise_structure");
  return orgId;
}

export type FranchiseRow = {
  organization_id: string;
  organization_name: string;
  active_clients: number;
  visits_today: number;
  visits_completed_today: number;
  /** NET: gross less the refunds and chargebacks recorded this month.
   *
   *  It became net in SQL without the two component columns being carried up
   *  here, which would have left this screen showing one shrunken figure while
   *  a location's settlement statement shows gross, refunds and net side by
   *  side. A franchise owner reads both — they have to reconcile. */
  revenue_mtd_cents: number;
  revenue_mtd_gross_cents: number;
  refunds_mtd_cents: number;
  ar_open_cents: number;
  tech_count: number;
};

export const getFranchiseContext = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => loadFranchiseContext(context));

/** getFranchiseContext's answer, also asked by getShellContext. */
export const loadFranchiseContext = createServerOnlyFn(
  async (context: AuthedContext) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { data: org, error } = await context.supabase
      .from("organizations")
      .select("id, name, is_franchise_parent, parent_organization_id")
      .eq("id", orgId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    // BUILD-6: was .eq("parent_organization_id", orgId) on the caller's own
    // client, which returns nothing for every caller — a parent is not a member
    // of its children, so RLS filters them all out. That is why the page always
    // said "No child organizations linked yet."
    const { data: children } = await (context.supabase as any).rpc("franchise_children", {
      _parent_org: orgId,
    });
    const kids = (children ?? []) as Array<{ id: string; name: string }>;
    return {
      org,
      isParent: !!org?.is_franchise_parent || kids.length > 0,
      children: kids,
    };
  },
);

// BUILD-6: computeRowForOrg was removed here. It recomputed each location's
// numbers in TypeScript on the caller's RLS-bound client, so it returned zeros
// for every caller — and its AR used statuses that are not in the invoice_status
// enum ("overdue", "sent") while ignoring credit_applied_cents entirely. Leaving
// a dead function that produces plausible-looking wrong numbers is worse than
// leaving nothing. franchise_rollup() is the single implementation now.

export const getFranchiseRollup = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);

    // BUILD-6: this used to list children on the caller's own RLS-bound client
    // and compute each row in TypeScript. Both halves were impossible. A parent
    // is not a member of its children, so "Members read own org" filtered every
    // child out — the list came back EMPTY for every possible caller, and the
    // page rendered "No child organizations linked yet" no matter what. Even
    // given rows, the per-child counts hit the same wall.
    //
    // franchise_rollup() is SECURITY DEFINER and does its own authorization
    // (owner or office_manager OF THE PARENT), which is the only shape that can
    // answer this question. It existed all along and nothing ever called it.
    // Its body needed repair first — see the migration — but the authorization
    // was always right.
    const { data, error } = await (context.supabase as any).rpc("franchise_rollup", {
      _parent_org: orgId,
    });
    if (error) throw new Error(error.message);

    const rows: FranchiseRow[] = (data ?? []).map((r: any) => ({
      organization_id: r.organization_id,
      organization_name: r.organization_name,
      active_clients: r.active_clients ?? 0,
      visits_today: r.visits_today ?? 0,
      visits_completed_today: r.visits_completed_today ?? 0,
      revenue_mtd_cents: Number(r.revenue_mtd_cents ?? 0),
      revenue_mtd_gross_cents: Number(r.revenue_mtd_gross_cents ?? 0),
      refunds_mtd_cents: Number(r.refunds_mtd_cents ?? 0),
      ar_open_cents: Number(r.ar_open_cents ?? 0),
      tech_count: r.tech_count ?? 0,
    }));

    // The parent's own row is first (the function orders it so). The UI needs to
    // tell "my own numbers" from "a location's".
    return { rows, parentOrgId: orgId };
  });

export type TrendLine = { id: string; name: string };
export type TrendWeek = { key: string; start: Date; end: Date };

/**
 * The lines the franchise revenue chart plots — the franchise's OWN operation
 * first, then its locations.
 *
 * `franchise_children()` returns children only, correctly: it is the membership
 * helper. This chart used that list directly while every other figure on the
 * same page comes from `franchise_rollup()`, which includes the parent's own
 * row on purpose — "so a rollup reads as the whole franchise rather than
 * 'everyone but me'". So the headline "Net revenue MTD" counted the parent's
 * trucks and the trend line under it did not, with nothing on the screen to say
 * which of the two was the franchise.
 *
 * Measured live on 2026-08-19 against the one franchise in the database: over
 * the eight weeks the chart covers, the parent took $3,728.00 of the
 * franchise's $10,402.00 — more than either location — and none of it was
 * plotted. The chart showed 64% of the money and was labelled as if it showed
 * all of it.
 *
 * Parent first, matching franchise_rollup's ordering, so the legend and the
 * table below it read in the same order.
 */
export function franchiseTrendLines(
  parentOrgId: string,
  parentName: string | null | undefined,
  children: TrendLine[],
): TrendLine[] {
  return [{ id: parentOrgId, name: parentName || "This organization" }, ...children];
}

/** The last 8 Monday-to-Sunday weeks ending with the week `now` falls in.
 *
 *  Boundaries are UTC, which does NOT match the rest of this page —
 *  franchise_rollup cuts its month in the parent org's timezone, and
 *  cpa-reports files every day with orgLocalDay. For an org west of UTC a
 *  Monday boundary here is Sunday evening locally, so a payment taken Sunday
 *  night lands in the following week's bar. Reported 2026-08-19; left as it was
 *  because moving it changes plotted history and is a bigger change than the
 *  two faults this pass is fixing. */
export function franchiseTrendWeeks(now: Date): TrendWeek[] {
  const weeks: TrendWeek[] = [];
  const today = new Date(now.getTime());
  today.setUTCHours(0, 0, 0, 0);
  const dow = today.getUTCDay(); // 0=Sun
  const mondayOffset = (dow + 6) % 7;
  const thisMonday = new Date(today);
  thisMonday.setUTCDate(today.getUTCDate() - mondayOffset);
  for (let i = 7; i >= 0; i--) {
    const start = new Date(thisMonday);
    start.setUTCDate(thisMonday.getUTCDate() - i * 7);
    const end = new Date(start);
    end.setUTCDate(start.getUTCDate() + 7);
    weeks.push({ key: start.toISOString().slice(5, 10), start, end });
  }
  return weeks;
}

export type TrendPayment = {
  organization_id: string;
  amount_cents: number | string | null;
  /** Sales-tax share inside amount_cents: not revenue, so not on the chart.
   *  Absent is 0. */
  tax_cents?: number | string | null;
  status: string | null;
  created_at: string;
};
export type TrendReversal = {
  organization_id: string;
  kind: string;
  detected_at: string;
  detail: { amount_cents?: number | string | null; revenue_cents?: number | string | null } | null;
};

/**
 * What a reversal takes off REVENUE — which is not always what moved.
 *
 * A reversal carries two figures. `amount_cents` is what MOVED: base plus card
 * surcharge, what the customer got back, what reconciles against Stripe.
 * `revenue_cents` is what comes off INCOME: base only, because the surcharge
 * was fee recovery and was never revenue. `loadOrgReversals` prefers
 * `revenue_cents`, and `franchise_rollup` was corrected to prefer it on
 * 2026-08-04. This chart was the third copy of the expression and kept reading
 * `amount_cents`.
 *
 * Both then subtract their figure from a gross built the same way, out of
 * `payments.amount_cents`, which is base only. So for a pass-through location
 * with $10,000 collected in a week and one $100 invoice charged as $103 and
 * refunded, the table read $9,900.00 and the line directly above it plotted
 * $9,897.00 — same money, same week, one screen, $3.00 apart. That is exactly
 * the shape migration 20260804080000 was written to kill, reintroduced by
 * fixing two of the three call sites.
 *
 * The fallback is not decoration: every reversal filed before the split has no
 * `revenue_cents`, and `amount_cents` is exactly right for those — they predate
 * pass-through, so the two figures were equal.
 */
export function reversalRevenueCents(detail: TrendReversal["detail"]): number {
  return Number(detail?.revenue_cents ?? detail?.amount_cents ?? 0);
}

/** Week buckets for the chart: `[{ week: "MM-DD", [orgId]: dollars, ... }]`. */
export function franchiseTrendSeries(
  lines: TrendLine[],
  weeks: TrendWeek[],
  pays: TrendPayment[],
  reversals: TrendReversal[],
): Array<Record<string, string | number>> {
  const bucket: Record<string, Record<string, number>> = {};
  for (const w of weeks) bucket[w.key] = {};
  const weekFor = (iso: string) => {
    const t = new Date(iso).getTime();
    return weeks.find((x) => t >= x.start.getTime() && t < x.end.getTime());
  };
  for (const p of pays) {
    if (!paymentWasReceived(p.status as string)) continue;
    const w = weekFor(p.created_at);
    if (!w) continue;
    bucket[w.key][p.organization_id] =
      (bucket[w.key][p.organization_id] ?? 0) +
      Number(p.amount_cents ?? 0) -
      Math.max(0, Number(p.tax_cents ?? 0));
  }
  for (const r of reversals) {
    const w = weekFor(r.detected_at);
    if (!w) continue;
    const cents = reversalRevenueCents(r.detail);
    // A won dispute is a recovery, so it adds back rather than deducting.
    // Counting it as a loss would move the line the wrong way twice.
    const delta = reducesIncome(r.kind) ? -cents : cents;
    bucket[w.key][r.organization_id] = (bucket[w.key][r.organization_id] ?? 0) + delta;
  }
  return weeks.map((w) => {
    const row: Record<string, string | number> = { week: w.key };
    for (const k of lines) row[k.id] = (bucket[w.key][k.id] ?? 0) / 100;
    return row;
  });
}

export const getFranchiseTrend = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    // BUILD-6: same RLS wall as the rollup — see getFranchiseContext.
    const { data: children } = await (context.supabase as any).rpc("franchise_children", {
      _parent_org: orgId,
    });
    const kids = (children ?? []) as TrendLine[];
    if (kids.length === 0) return { weeks: [] as any[], locations: [] as any[] };

    const { data: ownOrg } = await context.supabase
      .from("organizations")
      .select("name")
      .eq("id", orgId)
      .maybeSingle();
    const lines = franchiseTrendLines(orgId, ownOrg?.name as string | undefined, kids);

    const weeks = franchiseTrendWeeks(new Date());
    const earliest = weeks[0].start.toISOString();
    const latest = weeks[weeks.length - 1].end.toISOString();

    // BUILD-6: this hit the SAME RLS wall — payments belong to the children, and
    // the parent is not a member of them, so the caller's client returned an
    // empty set and the chart was blank even once the location list was fixed.
    // Service-role is safe here precisely because `lines` is the caller's own
    // organization plus what franchise_children() returned, and that routine
    // authorized the caller against the parent first; the query can only ever
    // touch organizations already proven to be this parent's or the parent.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: pays } = await (supabaseAdmin as any)
      .from("payments")
      .select("organization_id, amount_cents, tax_cents, status, created_at")
      .in(
        "organization_id",
        lines.map((k) => k.id),
      )
      // IMP-10: money that ARRIVED. Filtering on 'succeeded' would make a
      // refund rewrite an earlier week of the trend line, so the chart would
      // change shape retroactively with nothing to explain it.
      .in("status", receivedPaymentStatuses())
      .gte("created_at", earliest)
      .lt("created_at", latest);

    // IMP-10, the other half. Counting money that ARRIVED is only honest if
    // reversals are deducted where they happened — otherwise this chart is
    // confidently wrong in the flattering direction, and it sits directly above
    // a "Net revenue MTD" figure that IS net. Two numbers on one screen that
    // cannot be reconciled is worse than either being wrong alone.
    //
    // Read from review_items, the same source as everywhere else. Same
    // service-role justification as the payments query above.
    const { data: reversals } = await (supabaseAdmin as any)
      .from("review_items")
      .select("organization_id, kind, detected_at, detail")
      .in(
        "organization_id",
        lines.map((k) => k.id),
      )
      .in("kind", [...REVERSAL_KINDS])
      .gte("detected_at", earliest)
      .lt("detected_at", latest);

    const series = franchiseTrendSeries(
      lines,
      weeks,
      (pays ?? []) as TrendPayment[],
      (reversals ?? []) as TrendReversal[],
    );
    return { weeks: series, locations: lines };
  });

export const markSelfAsFranchiseParent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { error } = await context.supabase.rpc("mark_franchise_parent", { _org_id: orgId });
    if (error) throw new Error(error.message);
    return { ok: true, orgId };
  });

// ── Royalty billing (finding #16) ────────────────────────────────────────────
// houndstack.com markets "automatic royalty billing" as live; this implements
// it: a per-child royalty rate, and royalty invoices computed against each
// child's rolled-up (collected) revenue for a period.

/** Previous full calendar month as [start, end] date strings (UTC). */
function lastMonthRange(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

/** Set a child org's royalty percentage (0–100). Parent-only. */
export const setChildRoyaltyRate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ childOrgId: z.string().uuid(), percent: z.number().min(0).max(100) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    // Keeps the role + entitlement gate (owner, Enterprise plan) so the app
    // layer still refuses early with a good message.
    await resolveOrgId(context.supabase, context.userId);

    // BUG-19: this used to read the CHILD org and then update it through the
    // caller's own RLS-bound client. Both halves were impossible —
    // "Members read own org" made the read return null, so this function threw
    // "That location isn't part of your franchise" for every caller, always.
    // It had never worked.
    //
    // Setting a child's royalty rate is inherently a CROSS-org write, which no
    // tenant-scoped client can perform. It now goes through
    // set_child_royalty_percent(), which re-derives the parent from the child's
    // own row and requires the caller to own THAT parent — so authorization is
    // decided against the real relationship rather than anything the caller
    // supplied. The column is now protected by the platform-columns trigger,
    // and that function is the one sanctioned way through it.
    const { error } = await (context.supabase as any).rpc("set_child_royalty_percent", {
      _child_org_id: data.childOrgId,
      _percent: data.percent,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Child orgs with their configured royalty rate, for the settings UI. */
export const getFranchiseRoyaltySettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    // BUILD-6: same RLS wall — the caller's client cannot see its own children,
    // so this returned an empty list and the royalty settings page had nothing
    // to configure. Authorized above; service-role read scoped to this parent.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await (supabaseAdmin as any)
      .from("organizations")
      .select("id, name, franchise_royalty_percent")
      .eq("parent_organization_id", orgId)
      .order("name");
    if (error) throw new Error(error.message);
    return { children: data ?? [] };
  });

/**
 * Generate (or refresh) each location's settlement for a period — defaults to
 * the previous full calendar month. Idempotent per child+period.
 *
 * IMP-10: this used to be its own implementation of the royalty calculation,
 * and the nightly cron had a THIRD. All three computed revenue as
 * `payments where status = 'succeeded'`, which BUG-21 showed is wrong, and the
 * two TypeScript copies knew nothing about who collected the money or about
 * refunds — they wrote a royalty amount and left `direction` and
 * `net_due_cents` at their defaults, producing a statement whose headline
 * contradicted its own arithmetic.
 *
 * So the calculation now lives in exactly one place, generate_franchise_
 * settlements, and this is a thin caller. The server function keeps its name
 * and return shape so nothing above it had to change.
 *
 * Run on the CALLER's client so auth.uid() inside the SECURITY DEFINER routine
 * is the real person — it re-checks franchise ownership independently rather
 * than trusting resolveOrgId above.
 */
export const generateRoyaltyInvoices = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({ periodStart: z.string().optional(), periodEnd: z.string().optional() })
      .parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { start, end } =
      data.periodStart && data.periodEnd
        ? { start: data.periodStart, end: data.periodEnd }
        : lastMonthRange();

    // The RPC returns how many statements it actually WROTE, and that is the
    // only number entitled to be called "generated".
    //
    // This used to discard the return and head-count the statements existing
    // for the period, which answers a different question. The RPC's
    // ON CONFLICT … DO UPDATE is guarded by `status = 'draft'`, so once a
    // period's statements are issued it recalculates nothing at all — and the
    // head count still came back full, so the button reported a successful
    // regeneration of numbers it had not touched. An owner who changed a
    // royalty rate and pressed Generate was told it had taken effect.
    const { data: written, error } = await (context.supabase as any).rpc(
      "generate_franchise_settlements",
      { _parent: orgId, _start: start, _end: end },
    );
    if (error) throw new Error(error.message);

    return { generated: Number(written ?? 0), periodStart: start, periodEnd: end };
  });

/** List generated royalty invoices, newest period first. Parent-only. */
export const listRoyaltyInvoices = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { data, error } = await (context.supabase as any)
      .from("franchise_royalty_invoices")
      // `direction` and `net_due_cents` were missing here, and they are the two
      // columns that say what actually happens. The royalty is not what changes
      // hands — under parent-collection the franchise is holding the location's
      // money and owes it back — so a statement billing the location $100 and
      // one owing the location $900 both rendered as "Royalty $100", on the
      // screen that has the Issue and Mark paid buttons on it. The CPA report
      // pack has selected both all along.
      //
      // `revenue_collected_by_parent_cents` for the same reason one step on:
      // the net is |collected_by_franchise − royalty − adjustments|, so on a
      // period the franchise collected part of, a reader given only revenue,
      // royalty and adjustments cannot arrive at the net from them. The
      // generator has written the split since 2026-07-30 and no screen has ever
      // shown it.
      .select(
        "id, child_organization_id, period_start, period_end, revenue_cents, royalty_percent, amount_cents, royalty_cents, adjustments_applied_cents, revenue_collected_by_parent_cents, revenue_collected_by_location_cents, sales_tax_collected_by_parent_cents, direction, net_due_cents, status, created_at, organizations!franchise_royalty_invoices_child_organization_id_fkey(name)",
      )
      .eq("parent_organization_id", orgId)
      .order("period_start", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return { invoices: data ?? [] };
  });

/** Mark a royalty invoice issued/paid. Parent-only. */
export const setRoyaltyInvoiceStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({ invoiceId: z.string().uuid(), status: z.enum(["draft", "issued", "paid", "void"]) })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    // resolveOrgId in THIS file is not the bare org lookup the name has
    // elsewhere in the repo — it is requirePermission('manage_franchise') plus
    // the Enterprise entitlement, so this server function was already gated to
    // the franchise owner. (I first read the name and reported it as ungated.
    // It was not.)
    //
    // What was genuinely missing is below: the table's own RLS used to admit
    // dispatchers, so this update was the only real gate, and PostgREST reports
    // an UPDATE that RLS refused as a plain success with zero rows. Whoever
    // gets past a future policy change would be told the invoice was marked
    // paid while nothing moved. BUG-30 was exactly that.
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { data: rows, error } = await (context.supabase as any)
      .from("franchise_royalty_invoices")
      .update({ status: data.status })
      .eq("id", data.invoiceId)
      .eq("parent_organization_id", orgId)
      .select("id");
    if (error) throw new Error(error.message);
    if (!rows?.length) {
      throw new Error("That royalty invoice is not yours to change, or no longer exists.");
    }
    return { ok: true };
  });

/**
 * The adjustment lines behind the settlement statements — every refund and
 * chargeback, and for each reversed deduction the repayment that cancelled it.
 *
 * BUG-26 gave a won dispute a compensating adjustment so the money actually
 * goes back, and recorded `reversed_at` and `reversed_by_adjustment_id` to say
 * which repayment answered which deduction. Nothing read either column, so the
 * statement showed a credit the product could not explain — the deduction on
 * one statement, the repayment on another, joined by a foreign key no screen
 * followed. `franchise_adjustment_ledger` follows it, in both directions.
 *
 * Runs on the CALLER's client: the routine is SECURITY DEFINER and authorizes
 * `view_financials` against the org id passed in, so auth.uid() has to be the
 * real person.
 */
export const getFranchiseAdjustments = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { data, error } = await (context.supabase as any).rpc("franchise_adjustment_ledger", {
      _org_id: orgId,
    });
    if (error) throw new Error(error.message);
    return { rows: (data ?? []) as AdjustmentLedgerRow[] };
  });

// ── Recruiting locations (BUILD-6) ──────────────────────────────────────────
//
// Issuing a code is a PARENT capability, so it sits behind the same Enterprise
// funnel as the rest of this file. Redeeming one is not — see
// franchise-membership.functions.ts for why the child side is ungated.

export const createFranchiseLinkCode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await resolveOrgId(context.supabase, context.userId);
    // Caller's client, so auth.uid() inside the function is the real owner.
    const { data, error } = await (context.supabase as any).rpc("create_franchise_link_code");
    if (error) throw new Error(error.message);
    return { code: data as string };
  });

export type FranchiseLinkCode = {
  id: string;
  code: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  usedByName: string | null;
  revokedAt: string | null;
  state: "active" | "used" | "expired" | "revoked";
};

export const listFranchiseLinkCodes = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await (supabaseAdmin as any)
      .from("franchise_link_codes")
      .select("id, code, created_at, expires_at, used_at, used_by_org_id, revoked_at")
      .eq("parent_organization_id", orgId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);

    // Resolve who redeemed each code. The parent is entitled to know which
    // organization took the invitation they issued.
    const usedIds = (data ?? []).map((r: any) => r.used_by_org_id).filter(Boolean);
    const names = new Map<string, string>();
    if (usedIds.length) {
      const { data: orgs } = await (supabaseAdmin as any)
        .from("organizations")
        .select("id, name")
        .in("id", usedIds);
      for (const o of orgs ?? []) names.set(o.id, o.name);
    }

    const now = Date.now();
    const codes: FranchiseLinkCode[] = (data ?? []).map((r: any) => ({
      id: r.id as string,
      code: r.code as string,
      createdAt: r.created_at as string,
      expiresAt: r.expires_at as string,
      usedAt: (r.used_at as string | null) ?? null,
      usedByName: r.used_by_org_id ? (names.get(r.used_by_org_id) ?? null) : null,
      revokedAt: (r.revoked_at as string | null) ?? null,
      // Derived once here so three surfaces don't each re-derive it slightly
      // differently.
      state: r.revoked_at
        ? ("revoked" as const)
        : r.used_at
          ? ("used" as const)
          : Date.parse(r.expires_at) <= now
            ? ("expired" as const)
            : ("active" as const),
    }));
    return { codes };
  });

export const revokeFranchiseLinkCode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ codeId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // Scoped to this parent AND to unused codes: revoking one that was already
    // redeemed would imply it undoes the link, which it does not — unlinking is
    // a separate, deliberate act.
    const { data: updated, error } = await (supabaseAdmin as any)
      .from("franchise_link_codes")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", data.codeId)
      .eq("parent_organization_id", orgId)
      .is("used_at", null)
      .is("revoked_at", null)
      .select("id")
      .maybeSingle();
    if (error) throw new Error(error.message);
    return { ok: true as const, alreadyClosed: !updated };
  });
