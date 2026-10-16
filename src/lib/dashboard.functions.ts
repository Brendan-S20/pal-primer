import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { resolveCaller } from "@/lib/authz.server";
import { hasPermission } from "@/lib/permissions";
import { invoiceOutstandingCents, isInvoiceOverdue, summarizeAr } from "@/lib/ar";
import { orgToday } from "@/lib/org-day";

// `new Date().toISOString()` is the SERVER's day. For an org in
// America/Chicago that is tomorrow from 19:00 local, so "visits today" and
// every overdue figure on this dashboard flipped five hours early. See
// src/lib/org-day.ts.

export const getDashboardSummary = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { orgId, role } = await resolveCaller(supabase, userId);
    // Financial KPIs are scoped server-side: roles without view_financials
    // (e.g. dispatcher) get null for these fields, and the queries never run.
    const canViewFinancials = hasPermission(role, "view_financials");
    const { data: orgRow, error: orgError } = await supabase
      .from("organizations")
      .select("timezone, disputes_in_analytics")
      .eq("id", orgId)
      .maybeSingle();
    if (orgError) throw new Error(orgError.message);
    const timezone = orgRow?.timezone || "UTC";
    const today = orgToday((orgRow as { timezone?: string | null } | null)?.timezone || undefined);
    const emptyRes = { data: [] as any[], error: null as any };

    const [activeClientsRes, todayVisitsRes, collected, openInvoicesRes, staffRes, openTicketsRes] =
      await Promise.all([
        supabase
          .from("clients")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", orgId)
          .eq("active", true),
        supabase
          .from("visits")
          .select(
            "id, status, sequence, assigned_staff_id, weather_flagged, weather_note, clients(display_name), properties(street, city, latitude, longitude)",
          )
          .eq("organization_id", orgId)
          .eq("scheduled_on", today)
          .order("assigned_staff_id", { ascending: true, nullsFirst: true })
          .order("sequence", { ascending: true, nullsFirst: false }),
        // IMP-10: this used to sum PAID INVOICES dated by `issued_at`, with the
        // month boundary taken from the SERVER's clock. Three things wrong at
        // once: an invoice issued in March and paid in May counted in March; a
        // refund never appeared, because the invoice stays 'paid' forever; and
        // for any org west of UTC the first hours of a month landed in the
        // previous one. Now one shared cash-basis query — see revenue.server.ts.
        canViewFinancials
          ? import("@/lib/revenue.server").then((m) => m.collectedInPeriod(supabase, {
              orgId,
              ...m.monthToDate(timezone),
              timezone,
              includeOpenDisputes: !!orgRow?.disputes_in_analytics,
            }))
          : Promise.resolve(null),
        canViewFinancials
          ? supabase
              .from("invoices")
              // `status` MUST be selected (B1): the shared AR math keys on it,
              // and dropping it from this select made every row sum to $0
              // while Reports (which selects status) showed the real figure.
              // due_on + credit_applied_cents feed the shared overdue/net math.
              .select(
                "id, status, total_cents, credit_applied_cents, due_on, issued_at, client_id, clients(display_name)",
              )
              .eq("organization_id", orgId)
              .eq("status", "open")
              .order("due_on", { ascending: true, nullsFirst: false })
          : Promise.resolve(emptyRes),
        supabase
          .from("staff")
          // "Techs today" is a FIELD-worker view (C3/I4): non-field roles that
          // own a stray visit are excluded by the capability flag, not a
          // role-name check, matching Routes tech-load and Reports perTech.
          .select("id, display_name")
          .eq("organization_id", orgId)
          .eq("active", true)
          .eq("is_field_tech", true),
        supabase
          .from("qc_tickets")
          .select("id, category, message, created_at, client_id, visit_id, clients(display_name)")
          .eq("organization_id", orgId)
          .eq("status", "open")
          .order("created_at", { ascending: false })
          .limit(10),
      ]);

    for (const result of [activeClientsRes, todayVisitsRes, openInvoicesRes, staffRes, openTicketsRes]) {
      if (result.error) throw new Error(result.error.message);
    }

    const visits = todayVisitsRes.data ?? [];
    const visitCounts = {
      total: visits.length,
      completed: 0,
      skipped: 0,
      in_progress: 0,
      scheduled: 0,
      cancelled: 0,
    } as Record<string, number>;
    let unassigned = 0;
    let weatherFlagged = 0;
    for (const v of visits) {
      visitCounts[v.status] = (visitCounts[v.status] ?? 0) + 1;
      if (!v.assigned_staff_id) unassigned++;
      if (v.weather_flagged) weatherFlagged++;
    }

    // Net of this month's refunds and chargebacks. The components travel with
    // it so the card can show why the figure moved — a number that quietly
    // shrank is the failure mode the review queue exists to prevent.
    const mtdRevenueCents = collected?.netCents ?? 0;

    const openInvoices = (openInvoicesRes.data ?? []) as any[];
    // Shared AR math (B1/finding #7): one authoritative rollup, identical to
    // Reports "Outstanding" and the Invoices index — open balances net of
    // applied credit, overdue = open AND past due_on (not issued_at + 30d).
    const ar = summarizeAr(openInvoices, today);
    const overdueInvoices = openInvoices
      .filter((r: any) => isInvoiceOverdue(r, today))
      .slice(0, 5)
      .map((r: any) => ({
        id: r.id,
        clientName: r.clients?.display_name ?? "-",
        totalCents: invoiceOutstandingCents(r),
        dueOn: r.due_on ?? null,
        issuedAt: r.issued_at,
      }));

    return {
      today,
      activeClients: activeClientsRes.count ?? 0,
      // null (not 0) when the caller can't view financials, so the UI can
      // distinguish "hidden for this role" from a real zero.
      mtdRevenueCents: canViewFinancials ? mtdRevenueCents : null,
      mtdGrossCents: canViewFinancials ? (collected?.grossCents ?? 0) : null,
      mtdRefundsCents: canViewFinancials ? (collected?.refundsCents ?? 0) : null,
      arOpenCents: canViewFinancials ? ar.arOpenCents : null,
      overdueCount: canViewFinancials ? ar.overdueCount : null,
      visitCounts,
      unassignedToday: unassigned,
      weatherFlaggedToday: weatherFlagged,
      todayVisits: visits,
      staff: staffRes.data ?? [],
      // null (not []) for roles without billing visibility (H4): the UI keys
      // the whole "Overdue invoices" card off null so dispatchers don't see
      // an (empty) billing card at all.
      overdueInvoices: canViewFinancials ? overdueInvoices : null,
      openConcerns: (openTicketsRes.data ?? []).map((r: any) => ({
        id: r.id,
        category: r.category,
        message: r.message,
        createdAt: r.created_at,
        clientName: r.clients?.display_name ?? "-",
        visitId: r.visit_id,
      })),
    };
  });

