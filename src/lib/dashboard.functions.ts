import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { resolveCaller } from "@/lib/authz.server";
import { hasPermission } from "@/lib/permissions";

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function firstOfMonthISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

export const getDashboardSummary = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { orgId, role } = await resolveCaller(supabase, userId);
    // Financial KPIs are scoped server-side: roles without view_financials
    // (e.g. dispatcher) get null for these fields, and the queries never run.
    const canViewFinancials = hasPermission(role, "view_financials");
    const today = todayISO();
    const monthStart = firstOfMonthISO();
    const emptyRes = { data: [] as any[], error: null as any };

    const [activeClientsRes, todayVisitsRes, mtdInvoicesRes, openInvoicesRes, staffRes, openTicketsRes] =
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
        canViewFinancials
          ? supabase
              .from("invoices")
              .select("total_cents, status, issued_at")
              .eq("organization_id", orgId)
              .eq("status", "paid")
              .gte("issued_at", `${monthStart}T00:00:00`)
          : Promise.resolve(emptyRes),
        canViewFinancials
          ? supabase
              .from("invoices")
              .select("id, total_cents, issued_at, client_id, clients(display_name)")
              .eq("organization_id", orgId)
              .eq("status", "open")
              .order("issued_at", { ascending: true })
          : Promise.resolve(emptyRes),
        supabase
          .from("staff")
          .select("id, display_name")
          .eq("organization_id", orgId)
          .eq("active", true),
        supabase
          .from("qc_tickets")
          .select("id, category, message, created_at, client_id, visit_id, clients(display_name)")
          .eq("organization_id", orgId)
          .eq("status", "open")
          .order("created_at", { ascending: false })
          .limit(10),
      ]);


    if (todayVisitsRes.error) throw new Error(todayVisitsRes.error.message);
    if (mtdInvoicesRes.error) throw new Error(mtdInvoicesRes.error.message);
    if (openInvoicesRes.error) throw new Error(openInvoicesRes.error.message);

    const visits = todayVisitsRes.data ?? [];
    const visitCounts = { total: visits.length, completed: 0, skipped: 0, in_progress: 0, scheduled: 0, cancelled: 0 } as Record<string, number>;
    let unassigned = 0;
    let weatherFlagged = 0;
    for (const v of visits) {
      visitCounts[v.status] = (visitCounts[v.status] ?? 0) + 1;
      if (!v.assigned_staff_id) unassigned++;
      if (v.weather_flagged) weatherFlagged++;
    }

    const mtdRevenueCents = (mtdInvoicesRes.data ?? []).reduce(
      (s: number, r: any) => s + (r.total_cents ?? 0),
      0,
    );

    const openInvoices = openInvoicesRes.data ?? [];
    // Shared AR math (finding #7) so this matches Clients + Reports exactly.
    const { sumOutstandingCents } = await import("@/lib/ar");
    const arOpenCents = sumOutstandingCents(openInvoices as any[]);
    const now = Date.now();
    const overdueInvoices = openInvoices
      .filter((r: any) => r.issued_at && (now - new Date(r.issued_at).getTime()) / 86400000 > 30)
      .slice(0, 5)
      .map((r: any) => ({
        id: r.id,
        clientName: r.clients?.display_name ?? "-",
        totalCents: r.total_cents ?? 0,
        issuedAt: r.issued_at,
      }));

    return {
      today,
      activeClients: activeClientsRes.count ?? 0,
      // null (not 0) when the caller can't view financials, so the UI can
      // distinguish "hidden for this role" from a real zero.
      mtdRevenueCents: canViewFinancials ? mtdRevenueCents : null,
      arOpenCents: canViewFinancials ? arOpenCents : null,
      overdueCount: canViewFinancials
        ? openInvoices.filter(
            (r: any) => r.issued_at && (now - new Date(r.issued_at).getTime()) / 86400000 > 30,
          ).length
        : null,
      visitCounts,
      unassignedToday: unassigned,
      weatherFlaggedToday: weatherFlagged,
      todayVisits: visits,
      staff: staffRes.data ?? [],
      overdueInvoices: canViewFinancials ? overdueInvoices : [],
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

export const resolveConcern = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context, data }: any) => {
    const { supabase } = context;
    const { error } = await supabase
      .from("qc_tickets")
      .update({ status: "resolved", resolved_at: new Date().toISOString(), resolved_by: context.userId })
      .eq("id", data.ticketId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

