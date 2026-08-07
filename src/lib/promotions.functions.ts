import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import { assertValidPromoCode } from "@/lib/dna-linkage";

// Promo codes and gift cards are marketing/discount configuration living under
// Settings; creating/deleting/voiding them is an office action, not something a
// technician or dispatcher token may do (I7). RLS alone only tenant-scopes the
// write — it does not check role — so gate every write on manage_settings.
async function resolveManagerOrgId(supabase: any, userId: string): Promise<string> {
  return (await requirePermission(supabase, userId, "manage_settings")).orgId;
}

// ---------- Promo codes ----------

// `appliesTo` has no "recurring" any more. One redemption posts one credit, and
// a lump credit is not a discount repeated over N cycles — `portal_redeem_promo`
// refuses recurring codes outright (migration 20260807030000), so accepting one
// here would only mint something the customer gets turned away from. The column
// still permits it and legacy rows still read back; this closes the writer.
// `recurringCycles` went with it: it was the count of cycles nothing counted.
const promoFields = z.object({
  code: z.string().min(2).max(40),
  description: z.string().max(400).optional(),
  discountType: z.enum(["percent", "fixed"]),
  discountValueCents: z.number().int().min(0).optional(),
  // Mirrors promo_codes_percent_range_chk. 100 is allowed on purpose: a free
  // first visit is a promotion people actually run. 0 is not a discount.
  discountPercent: z.number().gt(0).max(100).optional(),
  appliesTo: z.enum(["first_visit", "one_time"]).default("first_visit"),
  maxRedemptions: z.number().int().min(1).optional(),
  expiresAt: z.string().optional(), // ISO
  active: z.boolean().default(true),
});

// Mirrors promo_codes_discount_shape_chk. Without it a percent code could be
// saved with no percent on it, and the constraint would come back as a Postgres
// error string instead of something an office manager can act on.
//
// Written as a standalone refiner rather than chained onto `promoFields`
// because `.superRefine()` returns a ZodEffects, which has no `.extend()` — the
// upsert validator below needs to add `id` to the same shape.
function checkDiscountShape(
  v: z.infer<typeof promoFields>,
  ctx: z.RefinementCtx,
): void {
  if (v.discountType === "percent" && v.discountPercent === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["discountPercent"],
      message: "A percentage code needs a percentage.",
    });
  }
  if (v.discountType === "fixed" && v.discountValueCents === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["discountValueCents"],
      message: "A fixed-amount code needs an amount.",
    });
  }
}

const promoUpsertSchema = promoFields
  .extend({ id: z.string().uuid().optional() })
  .superRefine(checkDiscountShape);

export const listPromoCodes = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    // Reads are office-only too (the file's doctrine above): the promo/gift
    // catalog with balances and purchaser PII is Settings data, not something
    // a technician token may enumerate.
    const orgId = await resolveManagerOrgId(context.supabase, context.userId);
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
  .inputValidator((d) => promoUpsertSchema.parse(d))
  .handler(async ({ data, context }) => {
    const orgId = await resolveManagerOrgId(context.supabase, context.userId);
    // Reject bare-number / placeholder codes like "10" (G8, I11).
    const validCode = assertValidPromoCode(data.code);
    const isPercent = data.discountType === "percent";
    const row = {
      organization_id: orgId,
      code: validCode.toUpperCase(),
      description: data.description ?? null,
      discount_type: data.discountType,
      // Exactly one of these carries the discount, and the other is explicitly
      // nulled rather than left at whatever an edit used to hold. A row with
      // both set would redeem off the type alone and read as a contradiction
      // to anyone auditing it later.
      discount_value_cents: isPercent ? null : (data.discountValueCents ?? 0),
      discount_percent: isPercent ? (data.discountPercent ?? null) : null,
      applies_to: data.appliesTo,
      // The column stays for legacy rows; nothing counts cycles, and the
      // `recurring` value that gave it meaning is no longer accepted.
      recurring_cycles: null,
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
    const orgId = await resolveManagerOrgId(context.supabase, context.userId);
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
    // Office-only read — codes + remaining balances are redeemable money.
    const orgId = await resolveManagerOrgId(context.supabase, context.userId);
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
    const orgId = await resolveManagerOrgId(context.supabase, context.userId);
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
    const orgId = await resolveManagerOrgId(context.supabase, context.userId);
    const { error } = await context.supabase
      .from("gift_cards")
      .update({ status: "void", remaining_balance_cents: 0 })
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
        // Required: a redemption credits a specific client's account balance
        // (the RPC posts a credit_ledger entry via post_credit_entry, same as
        // addClientCredit). A redemption without a client moved no money.
        clientId: z.string().uuid(),
        invoiceId: z.string().uuid().optional(),
        note: z.string().max(500).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    // Crediting a client account is a billing action — same gate as
    // addClientCredit. The RPC re-checks manage_client_billing in-database.
    const { orgId } = await requirePermission(
      context.supabase,
      context.userId,
      "manage_client_billing",
    );
    // Org-scoped client check for a clear error before the RPC runs.
    const { data: client, error: cErr } = await context.supabase
      .from("clients")
      .select("id, organization_id, display_name, credit_balance_cents")
      .eq("id", data.clientId)
      .maybeSingle();
    if (cErr) throw new Error(cErr.message);
    if (!client || client.organization_id !== orgId) throw new Error("Client not found");

    const { data: res, error } = await context.supabase.rpc("redeem_gift_card", {
      _org_id: orgId,
      _code: data.code.trim().toUpperCase(),
      _amount_cents: data.amountCents,
      _client_id: data.clientId,
      _invoice_id: data.invoiceId,
      _note: data.note,
    });
    if (error) throw new Error(error.message);
    const row = Array.isArray(res) ? res[0] : res;
    const redeemedCents = row?.redeemed_cents ?? 0;
    // Same activity trail as addClientCredit — credit appeared on the account.
    try {
      const { logActivity } = await import("@/lib/activity.server");
      await logActivity(context.supabase, {
        orgId,
        clientId: data.clientId,
        actorUserId: context.userId,
        kind: "client.credit_adjusted",
        summary: `Redeemed gift card ${data.code.trim().toUpperCase()} for $${(redeemedCents / 100).toFixed(2)} credit`,
        meta: { amount_cents: redeemedCents, gift_card_code: data.code.trim().toUpperCase() },
      });
    } catch {
      /* best-effort */
    }
    return {
      redeemedCents,
      remainingCents: row?.remaining_cents ?? 0,
    };
  });

export const listGiftCardRedemptions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ giftCardId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    // Office-only read (file doctrine): redemption history names clients.
    const orgId = await resolveManagerOrgId(context.supabase, context.userId);
    const { data: rows, error } = await context.supabase
      .from("gift_card_redemptions")
      .select("id, amount_cents, note, created_at, clients(display_name), invoice_id")
      .eq("organization_id", orgId)
      .eq("gift_card_id", data.giftCardId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return { redemptions: rows ?? [] };
  });
