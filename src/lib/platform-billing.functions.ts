import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

async function assertAdmin(supabase: any, userId: string) {
  const { data, error } = await supabase.rpc("is_platform_admin", { _user_id: userId });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden");
}

// ─────────── Coupons ───────────

export type PlatformCoupon = {
  id: string;
  code: string;
  stripe_coupon_id: string | null;
  percent_off: number | null;
  amount_off_cents: number | null;
  currency: string | null;
  duration: string;
  duration_in_months: number | null;
  max_redemptions: number | null;
  times_redeemed: number;
  expires_at: string | null;
  applies_to_plan_ids: string[] | null;
  is_active: boolean;
  created_at: string;
};

export const listPlatformCoupons = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { data, error } = await context.supabase
      .from("platform_coupons")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return { rows: (data ?? []) as PlatformCoupon[] };
  });

const createCouponSchema = z.object({
  code: z.string().min(2).max(50).transform((s) => s.toUpperCase().replace(/\s+/g, "")),
  percent_off: z.number().min(1).max(100).nullable().optional(),
  amount_off_cents: z.number().int().min(1).nullable().optional(),
  currency: z.string().length(3).default("usd"),
  duration: z.enum(["once", "repeating", "forever"]),
  duration_in_months: z.number().int().min(1).max(60).nullable().optional(),
  max_redemptions: z.number().int().min(1).nullable().optional(),
  expires_at: z.string().nullable().optional(),
  applies_to_plan_ids: z.array(z.string().uuid()).nullable().optional(),
});

export const createPlatformCoupon = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => createCouponSchema.parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    if (!data.percent_off && !data.amount_off_cents) {
      throw new Error("Provide percent_off or amount_off_cents");
    }
    if (data.duration === "repeating" && !data.duration_in_months) {
      throw new Error("duration_in_months required when duration is repeating");
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Best-effort Stripe mirroring
    let stripeCouponId: string | null = null;
    const secret = process.env.PLATFORM_STRIPE_SECRET_KEY ?? process.env.STRIPE_SECRET_KEY;
    if (secret) {
      try {
        const Stripe = (await import("stripe")).default;
        const stripe = new Stripe(secret);
        const c = await stripe.coupons.create({
          id: data.code,
          name: data.code,
          duration: data.duration,
          ...(data.percent_off ? { percent_off: data.percent_off } : {}),
          ...(data.amount_off_cents ? { amount_off: data.amount_off_cents, currency: data.currency } : {}),
          ...(data.duration === "repeating" ? { duration_in_months: data.duration_in_months! } : {}),
          ...(data.max_redemptions ? { max_redemptions: data.max_redemptions } : {}),
          ...(data.expires_at ? { redeem_by: Math.floor(new Date(data.expires_at).getTime() / 1000) } : {}),
        });
        stripeCouponId = c.id;
      } catch (e) {
        console.warn("Stripe coupon mirror failed", (e as Error).message);
      }
    }

    const { error } = await supabaseAdmin.from("platform_coupons").insert({
      code: data.code,
      stripe_coupon_id: stripeCouponId,
      percent_off: data.percent_off ?? null,
      amount_off_cents: data.amount_off_cents ?? null,
      currency: data.currency,
      duration: data.duration,
      duration_in_months: data.duration_in_months ?? null,
      max_redemptions: data.max_redemptions ?? null,
      expires_at: data.expires_at ?? null,
      applies_to_plan_ids: data.applies_to_plan_ids ?? null,
      is_active: true,
      created_by: context.userId,
    });
    if (error) throw new Error(error.message);

    try {
      await supabaseAdmin.from("platform_admin_audit").insert({
        actor_user_id: context.userId,
        organization_id: null,
        action: "create_coupon",
        after_json: { code: data.code, stripe_coupon_id: stripeCouponId },
      });
    } catch {}

    return { ok: true, stripe_mirrored: !!stripeCouponId };
  });

export const setPlatformCouponActive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid(), is_active: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("platform_coupons")
      .update({ is_active: data.is_active })
      .eq("id", data.id);
    if (error) throw new Error(error.message);

    try {
      await supabaseAdmin.from("platform_admin_audit").insert({
        actor_user_id: context.userId,
        organization_id: null,
        action: data.is_active ? "enable_coupon" : "disable_coupon",
        after_json: { id: data.id },
      });
    } catch {}
    return { ok: true };
  });

// ─────────── SaaS invoices ───────────

export type PlatformInvoiceRow = {
  id: string;
  organization_id: string | null;
  organization_name: string | null;
  stripe_invoice_id: string;
  number: string | null;
  amount_due_cents: number;
  amount_paid_cents: number;
  currency: string;
  status: string;
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
  period_start: string | null;
  period_end: string | null;
  issued_at: string | null;
  due_at: string | null;
  paid_at: string | null;
};

export const listPlatformInvoices = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({
      status: z.enum(["all", "open", "paid", "void", "uncollectible"]).default("all"),
      limit: z.number().int().min(1).max(500).default(200),
    }).parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    let q = supabaseAdmin
      .from("platform_invoices")
      .select("*")
      .order("issued_at", { ascending: false, nullsFirst: false })
      .limit(data.limit);
    if (data.status !== "all") q = q.eq("status", data.status);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);

    const orgIds = Array.from(new Set((rows ?? []).map((r) => r.organization_id).filter(Boolean))) as string[];
    const nameMap = new Map<string, string>();
    if (orgIds.length) {
      const { data: orgs } = await supabaseAdmin.from("organizations").select("id, name").in("id", orgIds);
      for (const o of orgs ?? []) nameMap.set(o.id, o.name);
    }

    const totals = { count: rows?.length ?? 0, due_cents: 0, paid_cents: 0 };
    const list: PlatformInvoiceRow[] = (rows ?? []).map((r) => {
      totals.due_cents += r.amount_due_cents ?? 0;
      totals.paid_cents += r.amount_paid_cents ?? 0;
      return {
        id: r.id,
        organization_id: r.organization_id,
        organization_name: r.organization_id ? nameMap.get(r.organization_id) ?? null : null,
        stripe_invoice_id: r.stripe_invoice_id,
        number: r.number,
        amount_due_cents: r.amount_due_cents,
        amount_paid_cents: r.amount_paid_cents,
        currency: r.currency,
        status: r.status,
        hosted_invoice_url: r.hosted_invoice_url,
        invoice_pdf: r.invoice_pdf,
        period_start: r.period_start,
        period_end: r.period_end,
        issued_at: r.issued_at,
        due_at: r.due_at,
        paid_at: r.paid_at,
      };
    });
    return { rows: list, totals };
  });

// ─────────── Tier engine ───────────

export const reassignAllBillingTiers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin.rpc("reassign_all_billing_tiers");
    if (error) throw new Error(error.message);
    try {
      await supabaseAdmin.from("platform_admin_audit").insert({
        actor_user_id: context.userId,
        organization_id: null,
        action: "reassign_all_billing_tiers",
        after_json: { count: data },
      });
    } catch {}
    return { count: data as number };
  });

export const reassignBillingTierForOrg = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ organization_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: slug, error } = await supabaseAdmin.rpc("assign_billing_tier_for_org", {
      _org_id: data.organization_id,
    });
    if (error) throw new Error(error.message);
    return { slug: slug as string | null };
  });
