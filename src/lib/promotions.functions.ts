import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
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

// ---------- Promo codes ----------

const promoSchema = z.object({
  code: z.string().min(2).max(40),
  description: z.string().max(400).optional(),
  discountType: z.enum(["percent", "fixed"]),
  discountValueCents: z.number().int().min(0).optional(),
  discountPercent: z.number().min(0).max(100).optional(),
  appliesTo: z.enum(["first_visit", "recurring", "one_time"]).default("first_visit"),
  recurringCycles: z.number().int().min(1).max(60).optional(),
  maxRedemptions: z.number().int().min(1).optional(),
  expiresAt: z.string().optional(), // ISO
  active: z.boolean().default(true),
});

export const listPromoCodes = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { data, error } = await context.supabase
      .from("promo_codes")
      .select("*")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return { promos: data ?? [] };
  });

export const upsertPromoCode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => promoSchema.extend({ id: z.string().uuid().optional() }).parse(d))
  .handler(async ({ data, context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const row = {
      organization_id: orgId,
      code: data.code.trim().toUpperCase(),
      description: data.description ?? null,
      discount_type: data.discountType,
      discount_value_cents:
        data.discountType === "fixed" ? (data.discountValueCents ?? 0) : null,
      discount_percent:
        data.discountType === "percent" ? (data.discountPercent ?? 0) : null,
      applies_to: data.appliesTo,
      recurring_cycles: data.appliesTo === "recurring" ? (data.recurringCycles ?? null) : null,
      max_redemptions: data.maxRedemptions ?? null,
      expires_at: data.expiresAt ? new Date(data.expiresAt).toISOString() : null,
      active: data.active,
    };
    if (data.id) {
      const { error } = await context.supabase
        .from("promo_codes")
        .update(row)
        .eq("id", data.id)
        .eq("organization_id", orgId);
      if (error) throw new Error(error.message);
      return { id: data.id };
    }
    const { data: ins, error } = await context.supabase
      .from("promo_codes")
      .insert({ ...row, created_by: context.userId })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: ins.id as string };
  });

export const deletePromoCode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { error } = await context.supabase
      .from("promo_codes")
      .delete()
      .eq("id", data.id)
      .eq("organization_id", orgId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ---------- Gift cards ----------

function randomGiftCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const rand = (n: number) =>
    Array.from({ length: n }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  return `GC-${rand(4)}-${rand(4)}-${rand(4)}`;
}

const giftSchema = z.object({
  code: z.string().min(4).max(40).optional(),
  initialBalanceCents: z.number().int().min(500),
  purchaserEmail: z.string().email().optional(),
  purchaserName: z.string().max(120).optional(),
  recipientEmail: z.string().email().optional(),
  recipientName: z.string().max(120).optional(),
  message: z.string().max(1000).optional(),
  expiresAt: z.string().optional(),
});

export const listGiftCards = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { data, error } = await context.supabase
      .from("gift_cards")
      .select("*")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return { cards: data ?? [] };
  });

export const createGiftCard = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => giftSchema.parse(d))
  .handler(async ({ data, context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const code = (data.code ?? randomGiftCode()).trim().toUpperCase();
    const { data: ins, error } = await context.supabase
      .from("gift_cards")
      .insert({
        organization_id: orgId,
        code,
        initial_balance_cents: data.initialBalanceCents,
        remaining_balance_cents: data.initialBalanceCents,
        purchaser_email: data.purchaserEmail ?? null,
        purchaser_name: data.purchaserName ?? null,
        recipient_email: data.recipientEmail ?? null,
        recipient_name: data.recipientName ?? null,
        message: data.message ?? null,
        expires_at: data.expiresAt ? new Date(data.expiresAt).toISOString() : null,
      })
      .select("id, code")
      .single();
    if (error) throw new Error(error.message);
    return { id: ins.id as string, code: ins.code as string };
  });

export const voidGiftCard = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { error } = await context.supabase
      .from("gift_cards")
      .update({ status: "void" })
      .eq("id", data.id)
      .eq("organization_id", orgId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const redeemGiftCard = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        code: z.string().min(4),
        amountCents: z.number().int().min(1),
        clientId: z.string().uuid().optional(),
        invoiceId: z.string().uuid().optional(),
        note: z.string().max(500).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { data: res, error } = await context.supabase.rpc("redeem_gift_card", {
      _org_id: orgId,
      _code: data.code.trim().toUpperCase(),
      _amount_cents: data.amountCents,
      _client_id: data.clientId ?? null,
      _invoice_id: data.invoiceId ?? null,
      _note: data.note ?? null,
    });
    if (error) throw new Error(error.message);
    const row = Array.isArray(res) ? res[0] : res;
    return {
      redeemedCents: row?.redeemed_cents ?? 0,
      remainingCents: row?.remaining_cents ?? 0,
    };
  });

export const listGiftCardRedemptions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ giftCardId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { data: rows, error } = await context.supabase
      .from("gift_card_redemptions")
      .select("id, amount_cents, note, created_at, clients(display_name), invoice_id")
      .eq("organization_id", orgId)
      .eq("gift_card_id", data.giftCardId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return { redemptions: rows ?? [] };
  });
