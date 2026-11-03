// The owner-facing operations report.
//
// ── BASIS, BECAUSE THIS PAGE GOT IT WRONG ──────────────────────────────────
//
// Every money figure here now states which basis it is on, because the ones
// that did not were provably wrong against the pack an accountant gets:
//
//   • Revenue read $3,200.00 for July while the CPA cash sheet read $3,185.00.
//     The $15.00 was one invoice settled entirely from account credit. It was
//     'paid', so this page counted it as revenue — but no money arrived, and
//     nothing in the bank matched. The same expression also never subtracted
//     credit_applied_cents, so credit-settled billing inflated it a second
//     time, and it then subtracted refunds — a CASH contra — from an
//     issue-dated ACCRUAL base, producing a "net revenue" on no basis at all.
//
//   • Outstanding read $2,655.00 for July while the pack read $2,550.00,
//     because AR was never bounded by the period: three invoices issued on
//     1 August were in one figure and not the other.
//
// So there are now two money questions on this page and they are kept apart:
//
//   COLLECTED   cash      money that arrived, from revenue.server.ts
//   BILLED      accrual   invoices issued, net of credit applied, from ar.ts
//
// and refunds are deducted only from the cash figure, where they belong. The
// receivables position is a point in time — as at the range's `to` day, the
// same day and the same `outstandingAsOf` the pack uses, so the two agree on
// the total open balance.
//
// This claim used to be made in a comment and was not true. It is now true by
// construction: every money figure below comes from a shared module that the
// CPA pack also calls, and there is no arithmetic in this file that the pack
// does not do the same way.

import { createServerFn } from "@tanstack/react-start";
// There is no date arithmetic left in this file — every money figure is dated
// by a shared module, in the org's own calendar, from the timezone resolved
// below. This import is the org's default, and the guard in
// tests/org-day.test.ts that this page never takes its day from the server.
import { DEFAULT_ORG_TIMEZONE } from "@/lib/org-day";
import { reportZoneId } from "@/lib/report-zone";
import { completionRate } from "@/lib/visit-lifecycle";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import { arPositionAsOf, billedInPeriod } from "@/lib/ar";
import type { Database } from "@/integrations/supabase/types";

/** The invoice columns this report reads, taken straight from the generated
 * types so a renamed or dropped column is a compile error here. */
type ReportInvoice = Pick<
  Database["public"]["Tables"]["invoices"]["Row"],
  | "id"
  | "client_id"
  | "status"
  | "total_cents"
  // Sales tax inside total_cents: kept in receivables, taken out of billed
  // revenue by billedInPeriod.
  | "tax_cents"
  | "credit_applied_cents"
  | "amount_paid_cents"
  | "due_on"
  | "issued_at"
  | "paid_at"
  // voided_at and updated_at are what make the receivables figure point-in-
  // time: an invoice's CURRENT status only ever describes today, and this page
  // is asked about closed periods.
  | "voided_at"
  | "updated_at"
  | "kind"
>;

const rangeSchema = z.object({
  from: z.string(), // YYYY-MM-DD
  to: z.string(),
});

// Reports are aggregate financial data — every function in this file is
// gated on view_financials, matching the /reports route boundary.
async function resolveOrgId(supabase: any, userId: string): Promise<string> {
  return (await requirePermission(supabase, userId, "view_financials")).orgId;
}

export const getReports = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => rangeSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);
    const { from, to } = data;

    // Visits in range
    const { data: visits, error: vErr } = await supabase
      .from("visits")
      .select(
        // properties(...): the zone fallback for a visit that carries none of
        // its own (lib/report-zone.ts, #437). Plain columns, not a zones
        // embed: properties has two foreign keys to zones, and a bare embed
        // through it is ambiguous (see pricing-drift.functions.ts).
        "id, status, scheduled_on, assigned_staff_id, zone_id, subscription_id, client_id, skip_reason_code, skip_charge_cents, properties(zone_id, auto_zone_id)",
      )
      .eq("organization_id", orgId)
      .gte("scheduled_on", from)
      .lte("scheduled_on", to);
    if (vErr) throw new Error(vErr.message);

    const visitCounts = {
      completed: 0,
      skipped: 0,
      missed: 0,
      scheduled: 0,
      in_progress: 0,
      cancelled: 0,
    } as Record<string, number>;
    const perTech: Record<string, { completed: number; skipped: number; total: number }> = {};
    const perZone: Record<string, { completed: number; skipped: number; total: number }> = {};
    const skipReasons: Record<string, number> = {};

    for (const v of visits ?? []) {
      visitCounts[v.status] = (visitCounts[v.status] ?? 0) + 1;
      const tid = v.assigned_staff_id ?? "unassigned";
      perTech[tid] ??= { completed: 0, skipped: 0, total: 0 };
      perTech[tid].total++;
      if (v.status === "completed") perTech[tid].completed++;
      if (v.status === "skipped") perTech[tid].skipped++;
      const zid = reportZoneId(v);
      perZone[zid] ??= { completed: 0, skipped: 0, total: 0 };
      perZone[zid].total++;
      if (v.status === "completed") perZone[zid].completed++;
      if (v.status === "skipped") perZone[zid].skipped++;
      if (v.status === "skipped" && v.skip_reason_code) {
        skipReasons[v.skip_reason_code] = (skipReasons[v.skip_reason_code] ?? 0) + 1;
      }
    }

    // Why customers left: services that ended in range, by reason. A service
    // ended with a future date is still counted on the day it ends, which is
    // when the customer is actually gone.
    const { data: endedSubs } = await supabase
      .from("subscriptions")
      .select("end_reason")
      .eq("organization_id", orgId)
      .not("end_reason", "is", null)
      .gte("ends_on", from)
      .lte("ends_on", to);
    const { tallyChurnReasons } = await import("@/lib/churn-reasons");
    const churnReasons = tallyChurnReasons((endedSubs ?? []).map((x) => x.end_reason));

    // Staff names + field-worker flag. Tech productivity is a FIELD-worker
    // report (C3/I4): non-field roles (owner/office_manager/dispatcher) that
    // happen to own visits are excluded by the capability flag, not by
    // role-name checks. "Unassigned" is not a tech and is dropped too — the
    // overall completion picture stays in visitCounts.
    const staffIds = Object.keys(perTech).filter((x) => x !== "unassigned");
    const { data: staffRows } = staffIds.length
      ? await supabase.from("staff").select("id, display_name, is_field_tech").in("id", staffIds)
      : { data: [] as { id: string; display_name: string; is_field_tech: boolean }[] };
    const staffName = new Map((staffRows ?? []).map((s) => [s.id, s.display_name]));
    const fieldStaffIds = new Set(
      (staffRows ?? []).filter((s: any) => s.is_field_tech).map((s) => s.id),
    );

    // Zone names
    const zoneIds = Object.keys(perZone).filter((x) => x !== "no_zone");
    const { data: zoneRows } = zoneIds.length
      ? await supabase.from("zones").select("id, name").in("id", zoneIds)
      : { data: [] as { id: string; name: string }[] };
    const zoneName = new Map((zoneRows ?? []).map((z) => [z.id, z.name]));

    // The whole invoice ledger. It has to be the whole thing rather than the
    // range: what was BILLED is range-bounded by issued_at, but receivables are
    // a POSITION, and an invoice issued three years ago and still open is part
    // of it. Bounding the position is done by date arithmetic below, not by the
    // query — an invoice that fell out of the window would silently drop out of
    // the opening balance too.
    //
    // BUG-23: this was previously a bare select with no paging. PostgREST caps
    // a response at 1000 rows silently, so past a thousand invoices every
    // figure on this page — revenue, outstanding, aging, top clients — was
    // quietly low, and got worse the longer the business ran.
    const { fetchAllPages } = await import("@/lib/supabase-paging.server");
    const invoices = await fetchAllPages<ReportInvoice>((a, b) =>
      supabase
        .from("invoices")
        .select(
          "id, client_id, status, total_cents, tax_cents, credit_applied_cents, amount_paid_cents, deposit_for_invoice_id, due_on, issued_at, paid_at, voided_at, updated_at, kind",
        )
        .eq("organization_id", orgId)
        .order("id")
        .range(a, b),
    );

    const { data: orgRow } = await supabase
      .from("organizations")
      .select("timezone")
      .eq("id", orgId)
      .maybeSingle();
    // Falling back to UTC here while every other layer falls back to
    // America/Chicago is itself a disagreement: the same org would be dated
    // one way on this page and another in the CPA pack. The timezone is passed
    // explicitly into every module below for the same reason — none of them
    // gets to guess.
    const timezone =
      (orgRow as { timezone?: string | null } | null)?.timezone || DEFAULT_ORG_TIMEZONE;

    // ── CASH: the money that arrived ────────────────────────────────────────
    //
    // Payments, through the shared money model (IMP-10), NOT paid invoices.
    // An invoice settled entirely from account credit is 'paid' and produced no
    // deposit; counting it here is how this page reported $3,200.00 against the
    // pack's $3,185.00 for the same July.
    //
    // Deliberately NOT passing includeOpenDisputes: the tax pack reads the
    // reversal ledger unfiltered, and this is the page held up next to it. A
    // display preference must not be the reason two sheets disagree.
    const { collectedInPeriod } = await import("@/lib/revenue.server");
    const collected = await collectedInPeriod(supabase, { orgId, from, to, timezone });

    const { totalReversals, reversalsByClient } = await import("@/lib/reversals.server");
    const reversals = totalReversals(collected.reversals);
    const refundsByClient = await reversalsByClient(supabase, orgId, collected.reversals);

    // ── ACCRUAL: what was billed ────────────────────────────────────────────
    //
    // Net of credit applied, because a $15.00 invoice covered by a $15.00
    // credit billed the customer nothing new. Same rule, same helper, as the
    // pack's accrual income sheet.
    const billed = billedInPeriod(invoices ?? [], from, to, timezone);

    // ── POSITION: receivables as at the end of the range ────────────────────
    //
    // As at `to`, not as at today. An unbounded "outstanding" answers a
    // question nobody asked — it is neither the period's closing balance nor
    // anything an accountant can tie to — and it is why July read $2,655.00
    // here and $2,550.00 in the pack.
    // Dated partial payments, so a part paid after `to` does not shrink it.
    const { attachDatedPartialPayments } = await import("@/lib/partial-payments.server");
    const ar = arPositionAsOf(
      await attachDatedPartialPayments(supabase, orgId, invoices ?? []),
      to,
      timezone,
    );

    // ── Top clients, on the CASH basis ──────────────────────────────────────
    //
    // The same money as the "Collected" tile, split by customer, so the column
    // adds up to the headline instead of approximating it. Refunds are a cash
    // contra and are subtracted from a cash figure here — the old table
    // subtracted them from issue-dated billing, which is the same
    // mixed-basis subtraction the headline used to make.
    const clientOfInvoice = new Map((invoices ?? []).map((inv) => [inv.id, inv.client_id]));
    const collectedByClient: Record<string, number> = {};
    for (const r of collected.receipts) {
      const clientId = clientOfInvoice.get(r.invoiceId ?? "");
      if (!clientId) continue; // a receipt with no invoice — in the headline only
      collectedByClient[clientId] = (collectedByClient[clientId] ?? 0) + r.amountCents;
    }
    const netByClient: Record<string, number> = { ...collectedByClient };
    for (const [clientId, totals] of refundsByClient) {
      if (!clientId) continue; // unattributed — counted in the headline only
      netByClient[clientId] = (netByClient[clientId] ?? 0) - totals.netCents;
    }
    const topClientIds = Object.entries(netByClient)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id]) => id);
    const { data: clientRows } = topClientIds.length
      ? await supabase.from("clients").select("id, display_name").in("id", topClientIds)
      : { data: [] as { id: string; display_name: string }[] };
    const clientName = new Map((clientRows ?? []).map((c) => [c.id, c.display_name]));

    // Client churn: created vs deactivated in range
    const { count: newClients } = await supabase
      .from("clients")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .gte("created_at", `${from}T00:00:00`)
      .lte("created_at", `${to}T23:59:59`);

    const { count: activeClients } = await supabase
      .from("clients")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("active", true);

    return {
      range: { from, to },
      timezone,

      // ── CASH ────────────────────────────────────────────────────────────
      // Gross is kept alongside net and NOT netted in place. A single
      // "revenue" figure that silently shrinks when a dispute lands is what
      // three tiles replace.
      //
      // The old `revenuePaidCents` / `revenueNetCents` are GONE rather than
      // renamed in place. They were paid invoices dated by issue, gross of
      // credit, minus a cash contra — no basis names that, so no name here
      // could have kept meaning it.
      collectedGrossCents: collected.grossCents,
      collectedNetCents: collected.netCents,
      paymentCount: collected.paymentCount,
      refundsDeductedCents: reversals.deductedCents,
      refundsRecoveredCents: reversals.recoveredCents,
      refundsNetCents: reversals.netCents,
      refundsCount: reversals.count,

      // ── ACCRUAL ─────────────────────────────────────────────────────────
      billedCents: billed.billedCents,
      taxBilledCents: billed.taxBilledCents,
      creditsAppliedCents: billed.creditsAppliedCents,
      netBilledCents: billed.netBilledCents,
      invoiceCount: billed.invoiceCount,

      // ── POSITION (accrual, point-in-time) ───────────────────────────────
      // `arAsOf` travels with the figure rather than being implied by the
      // range, because "outstanding" with no date on it is the ambiguity that
      // let this page and the pack print different totals.
      arAsOf: ar.asOf,
      outstandingCents: ar.outstandingCents,
      openInvoiceCount: ar.openCount,
      aging: ar.aging,

      visitCounts,
      // A missed visit is a terminal service failure and counts against the
      // completion rate alongside skips (B6 finding 5) — otherwise a month of
      // missed visits would still read 100% complete.
      completionRate: completionRate(visits ?? []),
      perTech: Object.entries(perTech)
        .filter(([id]) => fieldStaffIds.has(id))
        .map(([id, s]) => ({
          id,
          name: staffName.get(id) ?? "-",
          ...s,
        }))
        .sort((a, b) => b.completed - a.completed),
      perZone: Object.entries(perZone)
        .map(([id, s]) => ({
          id,
          name: id === "no_zone" ? "No zone" : (zoneName.get(id) ?? "-"),
          ...s,
        }))
        .sort((a, b) => b.total - a.total),
      skipReasons: Object.entries(skipReasons)
        .map(([code, n]) => ({ code, count: n }))
        .sort((a, b) => b.count - a.count),
      churnReasons,
      topClients: topClientIds.map((id) => ({
        id,
        name: clientName.get(id) ?? "-",
        // Gross and refunded shown separately, same reasoning as the headline:
        // "$4,000, of which $1,500 came back" is a different customer from
        // "$2,500", and the table should not flatten the two into one number.
        collectedCents: collectedByClient[id] ?? 0,
        refundsCents: refundsByClient.get(id)?.netCents ?? 0,
        netCollectedCents: netByClient[id] ?? 0,
      })),
      newClients: newClients ?? 0,
      activeClients: activeClients ?? 0,
    };
  });
