import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import { DEFAULT_ORG_TIMEZONE } from "@/lib/org-day";

// Revenue by service, for /reports (#410). Its own file so reports.functions.ts
// is unchanged: a pet-waste-only business gets { show: false } and the page
// draws nothing new. The grouping is revenue-by-service.ts.
//
// Billed (accrual) basis: invoice lines, before tax, on invoices issued in the
// range by the org's calendar, which is the rule the Billed tile uses. Gated on
// view_financials like every figure on the page, and read through the caller's
// own RLS-scoped client.

const rangeSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const CHUNK = 200;

function chunks<T>(xs: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK));
  return out;
}

/** A day either side of the range, so an invoice issued late in the evening in
 *  a zone west of UTC is still fetched; billedDay then dates it exactly. */
function widen(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

export const getRevenueByService = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => rangeSchema.parse(d))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase as any;
    const { orgId } = await requirePermission(supabase, context.userId, "view_financials");

    const [{ data: org }, { count: serviceCount }] = await Promise.all([
      supabase.from("organizations").select("timezone, service_lines").eq("id", orgId).maybeSingle(),
      supabase
        .from("services")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId),
    ]);
    const { revenueByService, showsRevenueByService } = await import("@/lib/revenue-by-service");
    if (!showsRevenueByService(serviceCount ?? 0, org?.service_lines)) {
      return { show: false as const, rows: [] };
    }
    const timezone = (org?.timezone as string | null) || DEFAULT_ORG_TIMEZONE;

    const { fetchAllPages } = await import("@/lib/supabase-paging.server");
    const invoices = await fetchAllPages<{ id: string; status: string | null; issued_at: string | null }>(
      (a, b) =>
        supabase
          .from("invoices")
          .select("id, status, issued_at")
          .eq("organization_id", orgId)
          .gte("issued_at", widen(data.from, -1))
          .lt("issued_at", widen(data.to, 2))
          .order("id")
          .range(a, b),
    );

    const lines: Array<{
      invoice_id: string;
      amount_cents: number;
      visit_id: string | null;
      subscription_id: string | null;
    }> = [];
    for (const ids of chunks(invoices.map((i) => i.id))) {
      lines.push(
        ...(await fetchAllPages<(typeof lines)[number]>((a, b) =>
          supabase
            .from("invoice_line_items")
            .select("invoice_id, amount_cents, visit_id, subscription_id")
            .in("invoice_id", ids)
            .order("id")
            .range(a, b),
        )),
      );
    }

    const visitService = new Map<string, string | null>();
    const visitIds = [...new Set(lines.map((l) => l.visit_id).filter((x): x is string => !!x))];
    for (const ids of chunks(visitIds)) {
      const { data: rows } = await supabase.from("visits").select("id, service_id").in("id", ids);
      for (const r of (rows ?? []) as Array<{ id: string; service_id: string | null }>) {
        visitService.set(r.id, r.service_id);
      }
    }
    const subscriptionService = new Map<string, string | null>();
    const subIds = [
      ...new Set(lines.map((l) => l.subscription_id).filter((x): x is string => !!x)),
    ];
    for (const ids of chunks(subIds)) {
      const { data: rows } = await supabase
        .from("subscriptions")
        .select("id, service_id")
        .in("id", ids);
      for (const r of (rows ?? []) as Array<{ id: string; service_id: string | null }>) {
        subscriptionService.set(r.id, r.service_id);
      }
    }
    const { data: services } = await supabase
      .from("services")
      .select("id, name")
      .eq("organization_id", orgId);
    const serviceName = new Map(
      ((services ?? []) as Array<{ id: string; name: string }>).map((s) => [s.id, s.name]),
    );

    return {
      show: true as const,
      rows: revenueByService({
        lines,
        invoices,
        from: data.from,
        to: data.to,
        timezone,
        visitService,
        subscriptionService,
        serviceName,
      }),
    };
  });
