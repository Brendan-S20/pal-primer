import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import { paymentWasReceived, receivedPaymentStatuses } from "@/lib/revenue";

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
  });

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
      ar_open_cents: Number(r.ar_open_cents ?? 0),
      tech_count: r.tech_count ?? 0,
    }));

    // The parent's own row is first (the function orders it so). The UI needs to
    // tell "my own numbers" from "a location's".
    return { rows, parentOrgId: orgId };
  });

export const getFranchiseTrend = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    // BUILD-6: same RLS wall as the rollup — see getFranchiseContext.
    const { data: children } = await (context.supabase as any).rpc("franchise_children", {
      _parent_org: orgId,
    });
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

    // BUILD-6: this hit the SAME RLS wall — payments belong to the children, and
    // the parent is not a member of them, so the caller's client returned an
    // empty set and the chart was blank even once the location list was fixed.
    // Service-role is safe here precisely because `kids` came from
    // franchise_children(), which authorized the caller against the parent
    // first; the query can only ever touch organizations already proven to be
    // this parent's.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: pays } = await (supabaseAdmin as any)
      .from("payments")
      .select("organization_id, amount_cents, status, created_at")
      .in(
        "organization_id",
        kids.map((k) => k.id),
      )
      // IMP-10: money that ARRIVED. Filtering on 'succeeded' would make a
      // refund rewrite an earlier week of the trend line, so the chart would
      // change shape retroactively with nothing to explain it.
      .in("status", receivedPaymentStatuses())
      .gte("created_at", earliest)
      .lt("created_at", latest);

    // Build week buckets: [{ week: "MM-DD", [orgId]: cents, ... }]
    const bucket: Record<string, Record<string, number>> = {};
    for (const w of weeks) bucket[w.key] = {};
    for (const p of pays ?? []) {
      if (!paymentWasReceived(p.status as string)) continue;
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

    const { error } = await (context.supabase as any).rpc("generate_franchise_settlements", {
      _parent: orgId,
      _start: start,
      _end: end,
    });
    if (error) throw new Error(error.message);

    // The RPC returns the number of adjustments it consumed, which is not what
    // this function has always reported. Count the statements themselves so the
    // caller's "Generated N" stays true to what it means.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { count } = await (supabaseAdmin as any)
      .from("franchise_royalty_invoices")
      .select("id", { count: "exact", head: true })
      .eq("parent_organization_id", orgId)
      .eq("period_start", start)
      .eq("period_end", end);

    return { generated: count ?? 0, periodStart: start, periodEnd: end };
  });

/** List generated royalty invoices, newest period first. Parent-only. */
export const listRoyaltyInvoices = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { data, error } = await (context.supabase as any)
      .from("franchise_royalty_invoices")
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
    z
      .object({ invoiceId: z.string().uuid(), status: z.enum(["draft", "issued", "paid", "void"]) })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { error } = await (context.supabase as any)
      .from("franchise_royalty_invoices")
      .update({ status: data.status })
      .eq("id", data.invoiceId)
      .eq("parent_organization_id", orgId);
    if (error) throw new Error(error.message);
    return { ok: true };
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

export const unlinkFranchiseLocation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ childOrgId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await resolveOrgId(context.supabase, context.userId);
    const { error } = await (context.supabase as any).rpc("unlink_franchise_child", {
      _child_org_id: data.childOrgId,
    });
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });
