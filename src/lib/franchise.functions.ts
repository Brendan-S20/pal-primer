import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";

// Franchise rollup is owner-only — every function in this file is gated on
// manage_franchise, matching the /franchise route boundary.
async function resolveOrgId(supabase: any, userId: string): Promise<string> {
  return (await requirePermission(supabase, userId, "manage_franchise")).orgId;
}

export type FranchiseRow = {
  organization_id: string;
  organization_name: string;
  active_clients: number;
  visits_today: number;
  visits_completed_today: number;
  revenue_mtd_cents: number;
  ar_open_cents: number;
  tech_count: number;
};

export const getFranchiseContext = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { data: org, error } = await context.supabase
      .from("organizations")
      .select("id, name, is_franchise_parent, parent_organization_id")
      .eq("id", orgId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const { data: children } = await context.supabase
      .from("organizations")
      .select("id, name")
      .eq("parent_organization_id", orgId)
      .order("name");
    return {
      org,
      isParent: !!org?.is_franchise_parent || (children ?? []).length > 0,
      children: children ?? [],
    };
  });

async function computeRowForOrg(supabase: any, orgId: string, name: string): Promise<FranchiseRow> {
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const [clients, techs, visitsToday, visitsDone, mtdPayments, arInvoices] = await Promise.all([
    supabase.from("clients").select("id", { count: "exact", head: true })
      .eq("organization_id", orgId).eq("active", true),
    supabase.from("staff").select("id", { count: "exact", head: true })
      .eq("organization_id", orgId).eq("active", true),
    supabase.from("visits").select("id", { count: "exact", head: true })
      .eq("organization_id", orgId).eq("scheduled_on", today),
    supabase.from("visits").select("id", { count: "exact", head: true })
      .eq("organization_id", orgId).eq("scheduled_on", today).eq("status", "completed"),
    supabase.from("payments").select("amount_cents")
      .eq("organization_id", orgId).eq("status", "succeeded")
      .gte("created_at", monthStart.toISOString()),
    supabase.from("invoices").select("total_cents")
      .eq("organization_id", orgId).in("status", ["open", "overdue", "sent"]),
  ]);

  const revenue = (mtdPayments.data ?? []).reduce((s: number, r: any) => s + Number(r.amount_cents ?? 0), 0);
  const ar = (arInvoices.data ?? []).reduce((s: number, r: any) => s + Number(r.total_cents ?? 0), 0);

  return {
    organization_id: orgId,
    organization_name: name,
    active_clients: clients.count ?? 0,
    tech_count: techs.count ?? 0,
    visits_today: visitsToday.count ?? 0,
    visits_completed_today: visitsDone.count ?? 0,
    revenue_mtd_cents: revenue,
    ar_open_cents: ar,
  };
}

export const getFranchiseRollup = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { data: children, error } = await context.supabase
      .from("organizations")
      .select("id, name")
      .eq("parent_organization_id", orgId)
      .order("name");
    if (error) throw new Error(error.message);
    const rows = await Promise.all(
      (children ?? []).map((c: any) => computeRowForOrg(context.supabase, c.id, c.name)),
    );
    return { rows };
  });

export const getFranchiseTrend = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { data: children } = await context.supabase
      .from("organizations")
      .select("id, name")
      .eq("parent_organization_id", orgId)
      .order("name");
    const kids = (children ?? []) as Array<{ id: string; name: string }>;
    if (kids.length === 0) return { weeks: [] as any[], locations: [] as any[] };

    // Last 8 weeks (Mon-Sun)
    const weeks: { key: string; start: Date; end: Date }[] = [];
    const today = new Date();
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

    const earliest = weeks[0].start.toISOString();
    const latest = weeks[weeks.length - 1].end.toISOString();

    const { data: pays } = await context.supabase
      .from("payments")
      .select("organization_id, amount_cents, created_at")
      .in("organization_id", kids.map((k) => k.id))
      .eq("status", "succeeded")
      .gte("created_at", earliest)
      .lt("created_at", latest);

    // Build week buckets: [{ week: "MM-DD", [orgId]: cents, ... }]
    const bucket: Record<string, Record<string, number>> = {};
    for (const w of weeks) bucket[w.key] = {};
    for (const p of pays ?? []) {
      const t = new Date(p.created_at as string).getTime();
      const w = weeks.find((x) => t >= x.start.getTime() && t < x.end.getTime());
      if (!w) continue;
      const oid = p.organization_id as string;
      bucket[w.key][oid] = (bucket[w.key][oid] ?? 0) + Number(p.amount_cents ?? 0);
    }
    const series = weeks.map((w) => {
      const row: Record<string, any> = { week: w.key };
      for (const k of kids) row[k.id] = (bucket[w.key][k.id] ?? 0) / 100;
      return row;
    });
    return { weeks: series, locations: kids };
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
    const orgId = await resolveOrgId(context.supabase, context.userId);
    // Confirm the target really is a child of the caller's org.
    const { data: child } = await context.supabase
      .from("organizations")
      .select("id, parent_organization_id")
      .eq("id", data.childOrgId)
      .maybeSingle();
    if (!child || child.parent_organization_id !== orgId) {
      throw new Error("That location isn't part of your franchise.");
    }
    const { error } = await (context.supabase.from("organizations") as any)
      .update({ franchise_royalty_percent: data.percent })
      .eq("id", data.childOrgId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Child orgs with their configured royalty rate, for the settings UI. */
export const getFranchiseRoyaltySettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { data, error } = await (context.supabase.from("organizations") as any)
      .select("id, name, franchise_royalty_percent")
      .eq("parent_organization_id", orgId)
      .order("name");
    if (error) throw new Error(error.message);
    return { children: data ?? [] };
  });

/**
 * Generate (or refresh) royalty invoices for every child for a period —
 * defaults to the previous full calendar month. Royalty = collected revenue in
 * the period × the child's rate. Idempotent per child+period (upsert on the
 * unique key). Can be called manually here and from the nightly cron.
 */
export const generateRoyaltyInvoices = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ periodStart: z.string().optional(), periodEnd: z.string().optional() }).parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { start, end } =
      data.periodStart && data.periodEnd
        ? { start: data.periodStart, end: data.periodEnd }
        : lastMonthRange();

    const { data: children, error: cErr } = await (context.supabase.from("organizations") as any)
      .select("id, name, franchise_royalty_percent")
      .eq("parent_organization_id", orgId);
    if (cErr) throw new Error(cErr.message);

    let generated = 0;
    for (const child of (children ?? []) as any[]) {
      const percent = Number(child.franchise_royalty_percent ?? 0);
      // Collected (succeeded) revenue in the period.
      const { data: pays } = await context.supabase
        .from("payments")
        .select("amount_cents")
        .eq("organization_id", child.id)
        .eq("status", "succeeded")
        .gte("created_at", `${start}T00:00:00Z`)
        .lt("created_at", `${end}T00:00:00Z`);
      const revenue = (pays ?? []).reduce((s: number, r: any) => s + Number(r.amount_cents ?? 0), 0);
      const amount = Math.round((revenue * percent) / 100);

      const { error: upErr } = await (context.supabase as any).from("franchise_royalty_invoices")
        .upsert(
          {
            parent_organization_id: orgId,
            child_organization_id: child.id,
            period_start: start,
            period_end: end,
            revenue_cents: revenue,
            royalty_percent: percent,
            amount_cents: amount,
            status: "draft",
            created_by: context.userId,
          },
          { onConflict: "child_organization_id,period_start,period_end" },
        );
      if (upErr) throw new Error(upErr.message);
      generated += 1;
    }
    return { generated, periodStart: start, periodEnd: end };
  });

/** List generated royalty invoices, newest period first. Parent-only. */
export const listRoyaltyInvoices = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { data, error } = await (context.supabase as any).from("franchise_royalty_invoices")
      .select(
        "id, child_organization_id, period_start, period_end, revenue_cents, royalty_percent, amount_cents, status, created_at, organizations!franchise_royalty_invoices_child_organization_id_fkey(name)",
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
    z.object({ invoiceId: z.string().uuid(), status: z.enum(["draft", "issued", "paid", "void"]) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { error } = await (context.supabase as any).from("franchise_royalty_invoices")
      .update({ status: data.status })
      .eq("id", data.invoiceId)
      .eq("parent_organization_id", orgId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
