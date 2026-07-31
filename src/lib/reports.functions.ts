import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import { invoiceOutstandingCents, isOutstanding } from "@/lib/ar";
import type { Database } from "@/integrations/supabase/types";

/** The invoice columns this report reads, taken straight from the generated
 * types so a renamed or dropped column is a compile error here. */
type ReportInvoice = Pick<
  Database["public"]["Tables"]["invoices"]["Row"],
  | "id"
  | "client_id"
  | "status"
  | "total_cents"
  | "credit_applied_cents"
  | "due_on"
  | "issued_at"
  | "paid_at"
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
        "id, status, scheduled_on, assigned_staff_id, zone_id, subscription_id, client_id, skip_reason_code, skip_charge_cents",
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
      const zid = v.zone_id ?? "no_zone";
      perZone[zid] ??= { completed: 0, skipped: 0, total: 0 };
      perZone[zid].total++;
      if (v.status === "completed") perZone[zid].completed++;
      if (v.status === "skipped") perZone[zid].skipped++;
      if (v.status === "skipped" && v.skip_reason_code) {
        skipReasons[v.skip_reason_code] = (skipReasons[v.skip_reason_code] ?? 0) + 1;
      }
    }

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
    // range: revenue is range-bounded by issued_at, but outstanding and aging
    // are a POSITION, and an invoice issued three years ago and still open is
    // part of it.
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
          "id, client_id, status, total_cents, credit_applied_cents, due_on, issued_at, paid_at, kind",
        )
        .eq("organization_id", orgId)
        .order("id")
        .range(a, b),
    );

    // Refunds and chargebacks in range (IMP-10).
    //
    // Invoice-based revenue cannot see a reversal: the invoice stays 'paid'
    // forever, because the work WAS done and the money DID arrive. So the
    // reversal is shown as its own dated line rather than by rewriting the
    // original figure — which would silently change every historical period the
    // moment a dispute landed.
    //
    // Read through the shared module so this page and the CPA pack cannot
    // disagree; an owner will hand one to their accountant and read the other
    // over coffee.
    const { data: orgRow } = await supabase
      .from("organizations")
      .select("timezone")
      .eq("id", orgId)
      .maybeSingle();
    const timezone = (orgRow as { timezone?: string | null } | null)?.timezone || "UTC";

    const { loadOrgReversals, totalReversals, reversalsByClient } =
      await import("@/lib/reversals.server");
    const reversalRows = await loadOrgReversals(supabase, { orgId, timezone, from, to });
    const reversals = totalReversals(reversalRows);
    const refundsByClient = await reversalsByClient(supabase, orgId, reversalRows);

    let revenuePaidCents = 0;
    let outstandingCents = 0;
    const perClient: Record<string, number> = {};
    const aging = { current: 0, d30: 0, d60: 0, d90: 0 };
    const today = new Date();

    for (const inv of invoices ?? []) {
      const issued = inv.issued_at ? inv.issued_at.slice(0, 10) : null;
      const inRange = issued && issued >= from && issued <= to;
      if (inv.status === "paid" && inRange) {
        revenuePaidCents += inv.total_cents ?? 0;
        perClient[inv.client_id] = (perClient[inv.client_id] ?? 0) + (inv.total_cents ?? 0);
      }
      if (isOutstanding(inv)) {
        // Shared AR math (finding #7/B1) so this matches Clients + Dashboard
        // + Invoices exactly: open balance net of applied credit (B7).
        const owed = invoiceOutstandingCents(inv);
        outstandingCents += owed;
        const ref = inv.issued_at;
        if (ref) {
          const days = Math.floor((today.getTime() - new Date(ref).getTime()) / 86400000);
          if (days <= 0) aging.current += owed;
          else if (days <= 30) aging.d30 += owed;
          else if (days <= 60) aging.d60 += owed;
          else aging.d90 += owed;
        } else {
          aging.current += owed;
        }
      }
    }

    // Top clients, net of what came back.
    //
    // The contra line above and this table are on the same screen, so they have
    // to agree. Ranking on gross while the headline shows net is how a customer
    // who refunded everything stays top of the list.
    const perClientNet: Record<string, number> = { ...perClient };
    for (const [clientId, totals] of refundsByClient) {
      if (!clientId) continue; // unattributed — counted in the headline only
      perClientNet[clientId] = (perClientNet[clientId] ?? 0) - totals.netCents;
    }
    const topClientIds = Object.entries(perClientNet)
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
      // Gross is kept as-is and NOT netted in place. A figure that changes
      // meaning without changing name is how a report starts lying: anything
      // that read `revenuePaidCents` before still gets what it asked for.
      revenuePaidCents,
      refundsDeductedCents: reversals.deductedCents,
      refundsRecoveredCents: reversals.recoveredCents,
      refundsNetCents: reversals.netCents,
      refundsCount: reversals.count,
      revenueNetCents: revenuePaidCents - reversals.netCents,
      outstandingCents,
      aging,
      visitCounts,
      // A missed visit is a terminal service failure and counts against the
      // completion rate alongside skips (B6 finding 5) — otherwise a month of
      // missed visits would still read 100% complete.
      completionRate:
        visitCounts.completed + visitCounts.skipped + visitCounts.missed > 0
          ? visitCounts.completed /
            (visitCounts.completed + visitCounts.skipped + visitCounts.missed)
          : null,
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
      topClients: topClientIds.map((id) => ({
        id,
        name: clientName.get(id) ?? "-",
        // Gross and refunded shown separately, same reasoning as the headline:
        // "$4,000, of which $1,500 came back" is a different customer from
        // "$2,500", and the table should not flatten the two into one number.
        revenueCents: perClient[id] ?? 0,
        refundsCents: refundsByClient.get(id)?.netCents ?? 0,
        netRevenueCents: perClientNet[id] ?? 0,
      })),
      newClients: newClients ?? 0,
      activeClients: activeClients ?? 0,
    };
  });
