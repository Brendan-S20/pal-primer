import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function resolveOrgId(supabase: any, userId: string): Promise<string> {
  const { data, error } = await supabase
    .from("user_roles")
    .select("organization_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("No organization for user");
  return data.organization_id as string;
}

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
    const orgId = await resolveOrgId(supabase, userId);
    const today = todayISO();
    const monthStart = firstOfMonthISO();

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
        supabase
          .from("invoices")
          .select("total_cents, status, issued_at")
          .eq("organization_id", orgId)
          .eq("status", "paid")
          .gte("issued_at", `${monthStart}T00:00:00`),
        supabase
          .from("invoices")
          .select("id, total_cents, issued_at, client_id, clients(display_name)")
          .eq("organization_id", orgId)
          .eq("status", "open")
          .order("issued_at", { ascending: true }),
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
    const arOpenCents = openInvoices.reduce((s: number, r: any) => s + (r.total_cents ?? 0), 0);
    const now = Date.now();
    const overdueInvoices = openInvoices
      .filter((r: any) => r.issued_at && (now - new Date(r.issued_at).getTime()) / 86400000 > 30)
      .slice(0, 5)
      .map((r: any) => ({
        id: r.id,
        clientName: r.clients?.display_name ?? "—",
        totalCents: r.total_cents ?? 0,
        issuedAt: r.issued_at,
      }));

    return {
      today,
      activeClients: activeClientsRes.count ?? 0,
      mtdRevenueCents,
      arOpenCents,
      overdueCount: openInvoices.filter(
        (r: any) => r.issued_at && (now - new Date(r.issued_at).getTime()) / 86400000 > 30,
      ).length,
      visitCounts,
      unassignedToday: unassigned,
      weatherFlaggedToday: weatherFlagged,
      todayVisits: visits,
      staff: staffRes.data ?? [],
      overdueInvoices,
    };
  });
