import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";

export const listInvoices = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    await requirePermission(supabase, context.userId, "manage_client_billing");
    const { data, error } = await supabase
      .from("invoices")
      .select("id, client_id, status, subtotal_cents, total_cents, credit_applied_cents, currency, period_start, period_end, issued_at, paid_at, due_on, send_after, sent_at, public_token, checkout_url, clients(display_name)")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    // due_on/send_after/sent_at/public_token aren't in the generated types yet.
    return (data ?? []) as any[] as Array<{
      id: string;
      client_id: string;
      status: string;
      subtotal_cents: number | null;
      total_cents: number | null;
      credit_applied_cents: number | null;
      currency: string | null;
      period_start: string | null;
      period_end: string | null;
      issued_at: string | null;
      paid_at: string | null;
      due_on: string | null;
      send_after: string | null;
      sent_at: string | null;
      public_token: string;
      checkout_url: string | null;
      clients: { display_name: string | null } | Array<{ display_name: string | null }> | null;
    }>;
  });

export const getInvoice = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await requirePermission(supabase, context.userId, "manage_client_billing");
    const res = await supabase
      .from("invoices")
      .select("*, clients(display_name, primary_email)")
      .eq("id", data.id)
      .single();
    if (res.error) throw new Error(res.error.message);
    let invoice = res.data;
    // Webhook-independent safety net: an open invoice with a checkout session
    // may have been paid without the webhook landing — verify against Stripe
    // and flip it before rendering.
    if (invoice.status === "open" && (invoice.stripe_checkout_session_id || invoice.stripe_payment_intent_id)) {
      const { reconcileInvoicePayment } = await import("@/lib/invoice-reconcile.server");
      if ((await reconcileInvoicePayment(invoice.id)) === "marked_paid") {
        const fresh = await supabase
          .from("invoices")
          .select("*, clients(display_name, primary_email)")
          .eq("id", data.id)
          .single();
        if (!fresh.error) invoice = fresh.data;
      }
    }
    const { data: items, error: iErr } = await supabase
      .from("invoice_line_items")
      .select("id, description, amount_cents, visit_id, subscription_id")
      .eq("invoice_id", data.id)
      .order("created_at");
    if (iErr) throw new Error(iErr.message);
    const { data: payments } = await supabase
      .from("payments")
      .select("id, amount_cents, status, stripe_payment_intent_id, paid_at, created_at")
      .eq("invoice_id", data.id)
      .order("created_at", { ascending: false });
    return { invoice, items: items ?? [], payments: payments ?? [] };
  });

export const generateInvoicesForOrg = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ orgId: z.string().uuid(), through: z.string() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { orgId } = await requirePermission(supabase, context.userId, "manage_client_billing");
    if (orgId !== data.orgId) throw new Error("Not authorized");
    const { data: count, error } = await supabase.rpc("generate_invoices_for_org", {
      _org_id: data.orgId,
      _through: data.through,
    });
    if (error) throw new Error(error.message);
    return { generated: count as number };
  });

export const generateInvoiceForClient = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientId: z.string().uuid(), through: z.string() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await requirePermission(supabase, context.userId, "manage_client_billing");
    const { data: id, error } = await supabase.rpc("generate_invoice_for_client", {
      _client_id: data.clientId,
      _through: data.through,
    });
    if (error) throw new Error(error.message);
    if (id) {
      const { logActivity } = await import("@/lib/activity.server");
      const { data: c } = await supabase
        .from("clients")
        .select("organization_id")
        .eq("id", data.clientId)
        .single();
      if (c)
        await logActivity(supabase, {
          orgId: c.organization_id,
          clientId: data.clientId,
          actorUserId: context.userId,
          kind: "invoice.generated",
          summary: `Generated invoice #${String(id).slice(0, 8)} through ${data.through}`,
        });
    }
    return { invoiceId: id as string };
  });

// P3.1 "quick charge": the only invoice path used to be schedule route →
// complete visit → generate — a solo operator who just did the job had no way
// to say "bill this now." Creates an ordinary open invoice payable through
// every existing path (portal, checkout, saved card).
const manualInvoiceSchema = z.object({
  clientId: z.string().uuid(),
  items: z
    .array(
      z.object({
        description: z.string().min(1).max(300),
        amountCents: z.number().int().min(1).max(10_000_000),
      }),
    )
    .min(1)
    .max(25),
  notes: z.string().max(500).optional(),
});

export const createManualInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => manualInvoiceSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { orgId } = await requirePermission(supabase, context.userId, "manage_client_billing");

    const { data: client, error: cErr } = await supabase
      .from("clients")
      .select("id, organization_id")
      .eq("id", data.clientId)
      .single();
    if (cErr) throw new Error(cErr.message);
    if (client.organization_id !== orgId) throw new Error("Client not found");

    const total = data.items.reduce((s, i) => s + i.amountCents, 0);
    const nowIso = new Date().toISOString();
    const today = nowIso.slice(0, 10);
    // Due date = issued date + the org's payment terms. (A DB trigger also
    // fills due_on for paths that don't set it, e.g. the generate RPCs.)
    const { data: org } = await supabase
      .from("organizations")
      .select("invoice_net_days")
      .eq("id", orgId)
      .single();
    const netDays = (org as any)?.invoice_net_days ?? 15;
    const dueOn = new Date(Date.now() + netDays * 86_400_000).toISOString().slice(0, 10);
    const { data: inv, error: iErr } = await supabase
      .from("invoices")
      .insert({
        organization_id: orgId,
        client_id: data.clientId,
        kind: "postpaid",
        status: "open",
        subtotal_cents: total,
        total_cents: total,
        period_start: today,
        period_end: today,
        issued_at: nowIso,
        due_on: dueOn,
        notes: data.notes ?? "Manual invoice",
      } as any)
      .select("id")
      .single();
    if (iErr) throw new Error(iErr.message);

    const { error: lErr } = await supabase.from("invoice_line_items").insert(
      data.items.map((i) => ({
        invoice_id: inv.id,
        description: i.description,
        amount_cents: i.amountCents,
      })),
    );
    if (lErr) {
      // Don't leave a headless invoice behind if the lines failed.
      await supabase.from("invoices").delete().eq("id", inv.id);
      throw new Error(lErr.message);
    }
    const { logActivity } = await import("@/lib/activity.server");
    await logActivity(supabase, {
      orgId,
      clientId: data.clientId,
      actorUserId: context.userId,
      kind: "invoice.created",
      summary: `Created manual invoice #${String(inv.id).slice(0, 8)} for $${(total / 100).toFixed(2)}`,
    });
    return { invoiceId: inv.id as string, totalCents: total };
  });

export const voidInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await requirePermission(context.supabase, context.userId, "manage_client_billing");
    const { error } = await context.supabase.rpc("void_invoice", { _invoice_id: data.id });
    if (error) throw new Error(error.message);
    const { data: inv } = await context.supabase
      .from("invoices")
      .select("organization_id, client_id")
      .eq("id", data.id)
      .single();
    if (inv) {
      const { logActivity } = await import("@/lib/activity.server");
      await logActivity(context.supabase, {
        orgId: inv.organization_id,
        clientId: inv.client_id,
        actorUserId: context.userId,
        kind: "invoice.voided",
        summary: `Voided invoice #${data.id.slice(0, 8)}`,
      });
    }
    return { ok: true };
  });

export const bulkVoidInvoices = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ ids: z.array(z.string().uuid()).min(1).max(500) }).parse(d))
  .handler(async ({ data, context }) => {
    await requirePermission(context.supabase, context.userId, "manage_client_billing");
    let ok = 0, failed = 0;
    for (const id of data.ids) {
      const { error } = await context.supabase.rpc("void_invoice", { _invoice_id: id });
      if (error) failed++; else ok++;
    }
    return { ok, failed };
  });

export const bulkMarkInvoicesPaid = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ ids: z.array(z.string().uuid()).min(1).max(500), note: z.string().optional() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await requirePermission(supabase, context.userId, "manage_client_billing");
    const nowIso = new Date().toISOString();
    let ok = 0, failed = 0;
    for (const id of data.ids) {
      const { data: inv, error: rErr } = await supabase
        .from("invoices")
        .select("id, status, total_cents, credit_applied_cents, currency, client_id, organization_id")
        .eq("id", id)
        .single();
      if (rErr || !inv) { failed++; continue; }
      if (inv.status === "paid" || inv.status === "void") { failed++; continue; }
      const { error: uErr } = await supabase
        .from("invoices")
        .update({ status: "paid", paid_at: nowIso })
        .eq("id", id);
      if (uErr) { failed++; continue; }
      // Record only the cash actually collected out-of-band: the open amount
      // net of applied credit. The credit portion is already in the credit
      // ledger; recording the gross total would double-count revenue.
      await supabase.from("payments").insert({
        invoice_id: id,
        organization_id: inv.organization_id,
        amount_cents: Math.max(
          (inv.total_cents ?? 0) - ((inv as { credit_applied_cents?: number | null }).credit_applied_cents ?? 0),
          0,
        ),
        currency: inv.currency ?? "usd",
        status: "succeeded",
        paid_at: nowIso,
        raw_event: { source: "manual_mark_paid", note: data.note ?? null },
      });
      ok++;
    }
    return { ok, failed };
  });

// In-app payment (Payment Element): staff take a card or ACH payment right on
// the invoice page. Mirrors the portal's portalCreateInvoicePaymentIntent but
// staff-authenticated, and never saves the client's payment method — only the
// client can consent to that from their portal.
const INVOICE_PM_TYPES = ["card", "us_bank_account"];

// ACH requires activation on the connected account; when it isn't enabled the
// PI create/update fails and we retry card-only.
function isBankDebitUnavailableError(e: unknown): boolean {
  const err = e as { message?: string; param?: string };
  return (
    /us_bank_account/i.test(err?.message ?? "") ||
    /payment_method_types/.test(err?.param ?? "")
  );
}

export const createInvoicePaymentIntent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await requirePermission(supabase, context.userId, "manage_client_billing");
    // Read invoice + verify access via RLS
    // (credit_applied_cents isn't in the generated types yet.)
    const { data: invoiceRow, error } = await supabase
      .from("invoices")
      .select("id, organization_id, client_id, total_cents, credit_applied_cents, currency, status, stripe_checkout_session_id, stripe_payment_intent_id")
      .eq("id", data.id)
      .single();
    if (error) throw new Error(error.message);
    const invoice = invoiceRow as any;
    if (invoice.status === "paid") throw new Error("Invoice already paid");
    if (invoice.status === "void") throw new Error("Invoice is voided");
    // Charge the OPEN amount: total net of applied credit (B7).
    const dueCents = Math.max(
      (invoice.total_cents ?? 0) - ((invoice as any).credit_applied_cents ?? 0),
      0,
    );
    if (dueCents <= 0) throw new Error("Nothing due on this invoice");
    // If a previous session/intent was already paid but the status is stale
    // (webhook missed), reconcile instead of minting a second charge.
    if (invoice.stripe_checkout_session_id || invoice.stripe_payment_intent_id) {
      const { reconcileInvoicePayment } = await import("@/lib/invoice-reconcile.server");
      if ((await reconcileInvoicePayment(invoice.id)) === "marked_paid") {
        throw new Error("Invoice already paid");
      }
    }

    const { data: cRow, error: cErr } = await supabase
      .from("clients")
      .select("id, stripe_customer_id, primary_email, display_name")
      .eq("id", invoice.client_id)
      .single();
    if (cErr) throw new Error(cErr.message);

    // Tenant->client charge: runs on the org's own connected Stripe account.
    const { requireOrgStripeAccount, connectStripe, connectPublishableKey, verifyClientStripeCustomer } = await import("@/lib/stripe-connect.server");
    const acct = await requireOrgStripeAccount(invoice.organization_id);
    const stripe = await connectStripe();
    const opts = { stripeAccount: acct.accountId };

    let customerId = await verifyClientStripeCustomer(stripe, acct.accountId, cRow);
    if (!customerId) {
      const cust = await stripe.customers.create({
        email: cRow.primary_email ?? undefined,
        name: cRow.display_name ?? undefined,
        metadata: { client_id: cRow.id, organization_id: invoice.organization_id },
      }, opts);
      customerId = cust.id;
      await supabase.from("clients").update({ stripe_customer_id: customerId }).eq("id", cRow.id);
    }

    const currency = (invoice.currency ?? "usd").toLowerCase();
    const metadata = {
      invoice_id: invoice.id,
      organization_id: invoice.organization_id,
      source: "staff_inline",
    };

    let pi: import("stripe").Stripe.PaymentIntent | null = null;
    if (invoice.stripe_payment_intent_id) {
      try {
        const existing = await stripe.paymentIntents.retrieve(invoice.stripe_payment_intent_id, {}, opts);
        // An in-flight bank debit means the invoice IS being paid; minting a
        // replacement intent would lose the reference and invite a second
        // charge while the debit clears.
        if (existing.status === "processing") {
          throw new Error(
            "A payment for this invoice is already processing. Bank payments can take a few days to clear.",
          );
        }
        if (
          existing.status === "requires_payment_method" ||
          existing.status === "requires_confirmation" ||
          existing.status === "requires_action"
        ) {
          // Always update the reused intent: syncs amount/currency, pins
          // explicit payment_method_types so previously-minted "automatic"
          // intents stop offering Klarna/Affirm/etc., and CLEARS
          // setup_future_usage — a portal-minted intent saves the client's
          // card by consent, but a card typed by staff must never be saved.
          const updateParams = {
            amount: dueCents,
            currency,
            metadata,
            setup_future_usage: "" as const,
          };
          try {
            pi = await stripe.paymentIntents.update(existing.id, {
              ...updateParams,
              payment_method_types: INVOICE_PM_TYPES,
            }, opts);
          } catch (e) {
            if (!isBankDebitUnavailableError(e)) throw e;
            pi = await stripe.paymentIntents.update(existing.id, {
              ...updateParams,
              payment_method_types: ["card"],
            }, opts);
          }
        }
      } catch (e) {
        // The processing guard is a real answer for the caller, not a
        // retrieve hiccup — let it surface instead of minting a new intent.
        if ((e as Error).message?.startsWith("A payment for this invoice is already processing")) throw e;
        console.warn("retrieve existing PI failed, creating new", e);
      }
    }

    if (!pi) {
      // No setup_future_usage here: staff must not save the client's payment
      // method without the client's own consent (portal flow only).
      const createParams = {
        amount: dueCents,
        currency,
        customer: customerId,
        metadata,
      };
      try {
        pi = await stripe.paymentIntents.create({
          ...createParams,
          payment_method_types: INVOICE_PM_TYPES,
        }, opts);
      } catch (e) {
        if (!isBankDebitUnavailableError(e)) throw e;
        pi = await stripe.paymentIntents.create({
          ...createParams,
          payment_method_types: ["card"],
        }, opts);
      }
      const { error: upErr } = await supabase
        .from("invoices")
        .update({ stripe_payment_intent_id: pi.id, status: "open" })
        .eq("id", invoice.id);
      if (upErr) throw new Error(upErr.message);
    }

    return {
      clientSecret: pi.client_secret as string,
      publishableKey: connectPublishableKey(),
      stripeAccount: acct.accountId,
      amountCents: dueCents,
      currency,
    };
  });

// Public pay links (QA round 8): staff copy a no-login /pay/i/{token} link.
// The client lands on a clean invoice document and pays right there — no
// portal OTP, no checkout.stripe.com. Replaces the old getInvoicePortalLink.
export const getInvoicePayLink = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ invoiceId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await requirePermission(supabase, context.userId, "manage_client_billing");
    const { data: invoice, error } = await supabase
      .from("invoices")
      .select("id, public_token")
      .eq("id", data.invoiceId)
      .single();
    if (error) throw new Error(error.message);
    const token = (invoice as any).public_token as string | null;
    if (!token) throw new Error("This invoice has no pay link yet");
    const base = process.env.APP_URL || "https://app.houndstack.com";
    return { url: `${base}/pay/i/${token}` };
  });

// Shared saved-card charge implementation (B7): the same off-session charge
// autopay/the portal use, on demand from the invoice drawer. Used by BOTH
// chargeInvoiceWithSavedCard and chargeAutopayForInvoice so the
// processing-PI guard, reconcile-before-charge, idempotency key, and activity
// log exist exactly once. Charges the invoice's OPEN amount
// (total_cents - credit_applied_cents), never the gross total.
async function chargeSavedCardCore(
  supabase: any,
  actorUserId: string,
  invoiceId: string,
): Promise<{ chargedCents: number; status: string }> {
  // credit_applied_cents isn't in the generated types yet.
  const { data: invoiceRow, error: iErr } = await supabase
    .from("invoices")
    .select("id, organization_id, client_id, total_cents, credit_applied_cents, currency, status, stripe_checkout_session_id, stripe_payment_intent_id")
    .eq("id", invoiceId)
    .single();
  if (iErr) throw new Error(iErr.message);
  const invoice = invoiceRow as any;
  if (invoice.status === "paid") throw new Error("Invoice already paid");
  if (invoice.status === "void") throw new Error("Invoice is voided");
  // Drafts are unfinalized: send (or finalize) the invoice before collecting.
  // Charging a draft would also skip the credit-first ordering, since
  // apply_credit_to_invoice only touches open invoices.
  if (invoice.status !== "open") throw new Error("Only open invoices can be charged");
  const dueCents = Math.max(
    (invoice.total_cents ?? 0) - ((invoice as any).credit_applied_cents ?? 0),
    0,
  );
  if (dueCents <= 0) throw new Error("Nothing due on this invoice");
  // Stale-open guard: if a prior session/intent already paid this invoice
  // (webhook missed), reconcile instead of charging the saved card too.
  if (invoice.stripe_checkout_session_id || invoice.stripe_payment_intent_id) {
    const { reconcileInvoicePayment } = await import("@/lib/invoice-reconcile.server");
    if ((await reconcileInvoicePayment(invoice.id)) === "marked_paid") {
      throw new Error("Invoice already paid");
    }
  }

  const { data: c, error: cErr } = await supabase
    .from("clients")
    .select("id, stripe_customer_id, default_payment_method_id, default_card_brand, default_card_last4")
    .eq("id", invoice.client_id)
    .single();
  // In-flight bank debit guard (same rule as the minting fns): a stored PI
  // in "processing" means the invoice IS being paid — charging the saved
  // card on top would collect twice when the debit clears.
  if (invoice.stripe_payment_intent_id) {
    const { requireOrgStripeAccount: acctFn, connectStripe: stripeFn } = await import("@/lib/stripe-connect.server");
    const guardAcct = await acctFn(invoice.organization_id);
    const guardStripe = await stripeFn();
    try {
      const existing = await guardStripe.paymentIntents.retrieve(
        invoice.stripe_payment_intent_id, {}, { stripeAccount: guardAcct.accountId },
      );
      if (existing.status === "processing") {
        throw new Error(
          "A payment for this invoice is already processing. Bank payments can take a few days to clear.",
        );
      }
      // A still-confirmable intent may be sitting in a client's open pay page
      // (portal or public link) at the OLD amount. Cancel it before charging
      // here, or the client could confirm it after this charge and pay twice.
      if (
        existing.status === "requires_payment_method" ||
        existing.status === "requires_confirmation" ||
        existing.status === "requires_action"
      ) {
        await guardStripe.paymentIntents.cancel(
          existing.id, {}, { stripeAccount: guardAcct.accountId },
        );
      }
    } catch (e) {
      if ((e as Error).message?.startsWith("A payment for this invoice is already processing")) throw e;
      // Retrieve/cancel hiccups don't block the charge; the reconcile above ran.
    }
  }
  if (cErr) throw new Error(cErr.message);
  if (!c.stripe_customer_id || !c.default_payment_method_id) {
    throw new Error("No saved card on file for this client");
  }

  const { requireOrgStripeAccount, connectStripe, verifyClientStripeCustomer } = await import("@/lib/stripe-connect.server");
  const acct = await requireOrgStripeAccount(invoice.organization_id);
  const stripe = await connectStripe();
  // Saved-card refs can be orphaned by a connected-account cutover; verify
  // before charging so staff get "re-add the card" instead of a raw
  // "No such customer: 'cus_…'".
  const liveCustomerId = await verifyClientStripeCustomer(stripe, acct.accountId, c);
  if (!liveCustomerId) {
    throw new Error("The saved card is no longer on file. Ask the client to add a payment method again.");
  }
  try {
    const pi = await stripe.paymentIntents.create({
      amount: dueCents,
      currency: invoice.currency ?? "usd",
      customer: c.stripe_customer_id,
      payment_method: c.default_payment_method_id,
      off_session: true,
      confirm: true,
      metadata: {
        invoice_id: invoice.id,
        organization_id: invoice.organization_id,
        source: "staff_saved_card",
      },
    }, {
      // Prevent a double-click (or a retried request) from charging twice.
      // The payment-method id is part of the key: after a decline the
      // client may save a NEW card the same day, and replaying the old
      // key with different params would be an idempotency_error. The amount
      // is the OPEN amount, so applying more credit mints a fresh key.
      idempotencyKey: `staff-saved-card-${invoice.id}-${dueCents}-${c.default_payment_method_id}`,
      stripeAccount: acct.accountId,
    });
    await supabase
      .from("invoices")
      .update({ stripe_payment_intent_id: pi.id, status: "open" })
      .eq("id", invoice.id);
    const { logActivity } = await import("@/lib/activity.server");
    await logActivity(supabase, {
      orgId: invoice.organization_id,
      clientId: invoice.client_id,
      actorUserId,
      kind: "invoice.charged_saved_card",
      summary: `Charged saved card (${c.default_card_brand ?? "card"} ····${c.default_card_last4 ?? "????"}) for invoice #${invoice.id.slice(0, 8)}: $${(dueCents / 100).toFixed(2)}`,
    });
    return { chargedCents: dueCents, status: pi.status };
  } catch (e) {
    throw new Error((e as Error).message || "Card charge failed");
  }
}

// Staff "charge saved card": thin wrapper over chargeSavedCardCore.
export const chargeInvoiceWithSavedCard = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ invoiceId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await requirePermission(supabase, context.userId, "manage_client_billing");
    const res = await chargeSavedCardCore(supabase, context.userId, data.invoiceId);
    return { ok: true, status: res.status };
  });

// ── Credit application (B7) ─────────────────────────────────────────────────
// The DB routine public.apply_credit_to_invoice is the single writer: it
// debits the credit ledger ('invoice_application' via post_credit_entry),
// bumps invoices.credit_applied_cents, and flips the invoice to paid only
// when fully covered. It deliberately writes NO payments row — payments is
// the cash ledger (royalties, digests, and platform metrics sum it as
// collected revenue) and a credit application moves no new cash. It is
// idempotent and concurrency-safe (advisory lock + row locks), so a
// double-click can never apply twice.
async function applyCreditViaRpc(
  supabase: any,
  invoiceId: string,
): Promise<{ appliedCents: number; remainingDueCents: number; invoiceStatus: string; reason: string }> {
  const { data, error } = await supabase.rpc("apply_credit_to_invoice", {
    _invoice_id: invoiceId,
  });
  if (error) throw new Error(error.message);
  const r = (data ?? {}) as Record<string, unknown>;
  return {
    appliedCents: Number(r.applied_cents ?? 0),
    remainingDueCents: Number(r.remaining_due_cents ?? 0),
    invoiceStatus: String(r.invoice_status ?? "open"),
    reason: String(r.reason ?? ""),
  };
}

async function logCreditApplied(
  supabase: any,
  actorUserId: string,
  invoiceId: string,
  appliedCents: number,
) {
  const { data: inv } = await supabase
    .from("invoices")
    .select("organization_id, client_id")
    .eq("id", invoiceId)
    .single();
  if (!inv) return;
  const { logActivity } = await import("@/lib/activity.server");
  await logActivity(supabase, {
    orgId: inv.organization_id,
    clientId: inv.client_id,
    actorUserId,
    kind: "invoice.credit_applied",
    summary: `Applied $${(appliedCents / 100).toFixed(2)} credit to invoice #${invoiceId.slice(0, 8)}`,
    meta: { amount_cents: appliedCents, invoice_id: invoiceId },
  });
}

/** Apply the client's available credit balance to an open invoice:
 * min(credit balance, open amount) moves through the credit ledger; the
 * invoice is marked paid when fully covered, else its amount due shrinks. */
export const applyCreditToInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ invoiceId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await requirePermission(supabase, context.userId, "manage_client_billing");
    const { invoiceHasProcessingIntent, syncInvoicePaymentIntentAmount } =
      await import("@/lib/invoice-reconcile.server");
    // An in-flight bank debit is already paying this invoice — applying credit
    // now would collect twice when the debit clears.
    if (await invoiceHasProcessingIntent(data.invoiceId)) {
      throw new Error(
        "A bank payment for this invoice is already processing. Wait for it to clear before applying credit.",
      );
    }
    const res = await applyCreditViaRpc(supabase, data.invoiceId);
    if (res.reason === "prepaid_topup") {
      throw new Error("Credit can't be applied to a prepaid top-up invoice (paying it grants credit).");
    }
    if (res.appliedCents > 0) {
      await logCreditApplied(supabase, context.userId, data.invoiceId, res.appliedCents);
      // A pay page may already hold an intent minted at the pre-credit amount;
      // shrink it (or cancel it when nothing is left due) so the client can't
      // confirm the stale gross charge.
      await syncInvoicePaymentIntentAmount(data.invoiceId);
    }
    return {
      appliedCents: res.appliedCents,
      remainingDueCents: res.remainingDueCents,
      invoiceStatus: res.invoiceStatus,
    };
  });

/** "Charge autopay" for one invoice (B2/B7, I8 "credits auto-applied first"):
 * applies available credit first, then charges only the remaining due to the
 * client's default saved card via the same implementation as
 * chargeInvoiceWithSavedCard (processing-PI guard, reconcile, idempotency,
 * activity log included). */
export const chargeAutopayForInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ invoiceId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await requirePermission(supabase, context.userId, "manage_client_billing");
    // Check for an in-flight bank debit BEFORE applying credit — the core
    // charge fn guards its own step, but by then the credit would already be
    // consumed on an invoice that is being paid.
    const { invoiceHasProcessingIntent } = await import("@/lib/invoice-reconcile.server");
    if (await invoiceHasProcessingIntent(data.invoiceId)) {
      throw new Error(
        "A payment for this invoice is already processing. Bank payments can take a few days to clear.",
      );
    }
    const credit = await applyCreditViaRpc(supabase, data.invoiceId);
    if (credit.invoiceStatus === "void") throw new Error("Invoice is voided");
    if (credit.appliedCents > 0) {
      await logCreditApplied(supabase, context.userId, data.invoiceId, credit.appliedCents);
    }
    // Fully covered by credit — nothing to charge. Cancel any stale
    // confirmable intent (a pay page could still confirm the old amount).
    if (credit.invoiceStatus === "paid" || credit.remainingDueCents <= 0) {
      const { syncInvoicePaymentIntentAmount } = await import("@/lib/invoice-reconcile.server");
      await syncInvoicePaymentIntentAmount(data.invoiceId);
      return {
        appliedCreditCents: credit.appliedCents,
        chargedCents: 0,
        status: credit.invoiceStatus === "paid" ? "paid" : credit.invoiceStatus,
      };
    }
    const charge = await chargeSavedCardCore(supabase, context.userId, data.invoiceId);
    return {
      appliedCreditCents: credit.appliedCents,
      chargedCents: charge.chargedCents,
      status: charge.status,
    };
  });

export const listUnbilledForClient = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await requirePermission(supabase, context.userId, "manage_client_billing");
    const { data: visits, error } = await supabase
      .from("visits")
      .select("id, scheduled_on, completed_at, subscription_id, subscriptions(price_cents), invoice_line_items(id)")
      .eq("client_id", data.clientId)
      .eq("status", "completed")
      .order("scheduled_on");
    if (error) throw new Error(error.message);
    return (visits ?? []).filter((v: { invoice_line_items?: unknown[] }) => !v.invoice_line_items || (v.invoice_line_items as unknown[]).length === 0);
  });

export const generatePrepaidInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ subscriptionId: z.string().uuid(), visitCount: z.number().int().min(1).max(52) }).parse(d))
  .handler(async ({ data, context }) => {
    await requirePermission(context.supabase, context.userId, "manage_client_billing");
    const { data: id, error } = await context.supabase.rpc("generate_prepaid_invoice", {
      _subscription_id: data.subscriptionId,
      _visit_count: data.visitCount,
    });
    if (error) throw new Error(error.message);
    return { invoiceId: id as string };
  });

export const getClientCredit = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await requirePermission(supabase, context.userId, "manage_client_billing");
    const { data: client, error } = await supabase
      .from("clients")
      .select("credit_balance_cents")
      .eq("id", data.clientId)
      .single();
    if (error) throw new Error(error.message);
    const { data: ledger, error: lErr } = await supabase
      .from("credit_ledger")
      .select("id, delta_cents, kind, note, invoice_id, visit_id, created_at")
      .eq("client_id", data.clientId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (lErr) throw new Error(lErr.message);
    return { balanceCents: client.credit_balance_cents ?? 0, ledger: ledger ?? [] };
  });

export const getClientBillingSummary = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await requirePermission(supabase, context.userId, "manage_client_billing");

    const [clientRes, invoicesRes] = await Promise.all([
      supabase
        .from("clients")
        .select("autopay_enabled, default_card_brand, default_card_last4, default_payment_method_id, stripe_customer_id, primary_email, autopay_paused, autopay_failure_count, autopay_last_error, autopay_last_attempt_at")
        .eq("id", data.clientId)
        .single(),
      supabase
        .from("invoices")
        .select("id, status, kind, currency, subtotal_cents, total_cents, credit_applied_cents, period_start, period_end, issued_at, paid_at, due_on, public_token, checkout_url, created_at")
        .eq("client_id", data.clientId)
        .order("created_at", { ascending: false })
        .limit(25),
    ]);
    if (clientRes.error) throw new Error(clientRes.error.message);

    // due_on/public_token aren't in the generated types yet.
    const invoices = ((invoicesRes.data ?? []) as any[]) as Array<{
      id: string;
      status: string;
      kind: string;
      currency: string | null;
      subtotal_cents: number | null;
      total_cents: number | null;
      credit_applied_cents: number | null;
      period_start: string | null;
      period_end: string | null;
      issued_at: string | null;
      paid_at: string | null;
      due_on: string | null;
      public_token: string;
      checkout_url: string | null;
      created_at: string;
    }>;
    const invoiceIds = invoices.map((i) => i.id);
    const paymentsRes = invoiceIds.length
      ? await supabase
          .from("payments")
          .select("id, invoice_id, amount_cents, status, stripe_payment_intent_id, paid_at, created_at")
          .in("invoice_id", invoiceIds)
          .order("created_at", { ascending: false })
          .limit(50)
      : { data: [] as any[] };

    const openInvoices = invoices.filter((i) => i.status === "open");
    // Shared AR math (B1/B7): open balance net of applied credit.
    const { sumOutstandingCents } = await import("@/lib/ar");

    return {
      client: clientRes.data,
      invoices,
      payments: paymentsRes.data ?? [],
      openCount: openInvoices.length,
      openTotalCents: sumOutstandingCents(openInvoices),
    };
  });

// Manual override: staff can reset a client's dunning ladder (clears the
// failure count + paused flag) so the next nightly run tries again. Useful
// after the client updates their card outside the portal.
export const resumeAutopay = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await requirePermission(context.supabase, context.userId, "manage_client_billing");
    const { error } = await context.supabase
      .from("clients")
      .update({
        autopay_paused: false,
        autopay_failure_count: 0,
        autopay_last_error: null,
      })
      .eq("id", data.clientId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });


/** Shared invoice drawer (QA round 8, was follow-up 2.3): line items, payment
 * attempts, due date, and the client context the drawer's action buttons need
 * (saved card, email address) — without leaving the current page. */
export const getInvoiceDetail = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ invoiceId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await requirePermission(supabase, context.userId, "manage_client_billing");
    const [{ data: invoice, error: iErr }, { data: lines, error: lErr }, { data: pays, error: pErr }] =
      await Promise.all([
        supabase
          .from("invoices")
          .select(
            "id, client_id, status, kind, currency, subtotal_cents, total_cents, credit_applied_cents, period_start, period_end, issued_at, paid_at, due_on, send_after, sent_at, public_token, voided_at, notes, checkout_url, created_at, clients(id, display_name, primary_email, default_payment_method_id, default_card_brand, default_card_last4)",
          )
          .eq("id", data.invoiceId)
          .single(),
        supabase
          .from("invoice_line_items")
          .select("id, description, amount_cents, visit_id, subscription_id, created_at")
          .eq("invoice_id", data.invoiceId)
          .order("created_at"),
        supabase
          .from("payments")
          .select("id, amount_cents, status, paid_at, created_at, stripe_payment_intent_id")
          .eq("invoice_id", data.invoiceId)
          .order("created_at", { ascending: false }),
      ]);
    if (iErr) throw new Error(iErr.message);
    if (lErr) throw new Error(lErr.message);
    if (pErr) throw new Error(pErr.message);
    const inv = invoice as any;
    const client = Array.isArray(inv?.clients) ? inv.clients[0] : inv?.clients;
    if (inv) delete inv.clients;
    return {
      invoice: inv as {
        id: string;
        client_id: string;
        status: string;
        kind: string;
        currency: string | null;
        subtotal_cents: number | null;
        total_cents: number | null;
        /** Portion of total already covered by applied credit (B7); the
         * amount due is total_cents - credit_applied_cents. */
        credit_applied_cents: number | null;
        period_start: string | null;
        period_end: string | null;
        issued_at: string | null;
        paid_at: string | null;
        due_on: string | null;
        send_after: string | null;
        sent_at: string | null;
        public_token: string;
        voided_at: string | null;
        notes: string | null;
        checkout_url: string | null;
        created_at: string;
      },
      client: (client ?? null) as {
        id: string;
        display_name: string | null;
        primary_email: string | null;
        default_payment_method_id: string | null;
        default_card_brand: string | null;
        default_card_last4: string | null;
      } | null,
      lineItems: ((lines ?? []) as any[]) as Array<{
        id: string;
        description: string;
        amount_cents: number;
        visit_id: string | null;
        subscription_id: string | null;
        created_at: string;
      }>,
      payments: ((pays ?? []) as any[]) as Array<{
        id: string;
        amount_cents: number;
        status: string;
        paid_at: string | null;
        created_at: string;
        stripe_payment_intent_id: string | null;
      }>,
    };
  });

// ── Credits (QA round 8) ────────────────────────────────────────────────────

/** Staff-issued credit adjustment: goodwill, service recovery, referral bonus.
 * Posts through the same ledger RPC prepay/visit debits use so the balance
 * and ledger never drift, and leaves an activity-log entry with the reason. */
export const addClientCredit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        clientId: z.string().uuid(),
        // Positive adds credit; negative corrects an over-grant.
        amountCents: z.number().int().min(-1_000_000).max(1_000_000).refine((n) => n !== 0, "Amount can't be zero"),
        reason: z.string().min(2).max(300),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { orgId } = await requirePermission(supabase, context.userId, "manage_client_billing");
    const { data: client, error: cErr } = await supabase
      .from("clients")
      .select("id, organization_id, credit_balance_cents")
      .eq("id", data.clientId)
      .single();
    if (cErr) throw new Error(cErr.message);
    if (client.organization_id !== orgId) throw new Error("Client not found");

    const { error } = await supabase.rpc("post_credit_entry", {
      _org_id: orgId,
      _client_id: data.clientId,
      _delta: data.amountCents,
      _kind: "adjustment",
      _invoice_id: null as any,
      _visit_id: null as any,
      _note: data.reason,
    });
    if (error) throw new Error(error.message);

    const dollars = `$${(Math.abs(data.amountCents) / 100).toFixed(2)}`;
    const { logActivity } = await import("@/lib/activity.server");
    await logActivity(supabase, {
      orgId,
      clientId: data.clientId,
      actorUserId: context.userId,
      kind: "client.credit_adjusted",
      summary: `${data.amountCents > 0 ? "Added" : "Removed"} ${dollars} credit: ${data.reason}`,
      meta: { amount_cents: data.amountCents, reason: data.reason },
    });
    return {
      ok: true,
      balanceCents: (client.credit_balance_cents ?? 0) + data.amountCents,
    };
  });

// ── Public pay link (QA round 8): /pay/i/{token} ────────────────────────────
//
// NO auth middleware on these two — the unguessable invoices.public_token IS
// the capability, same model as the portal/signup public fns. They run via
// the service-role client after loading the invoice by token, and return
// display data only (org name + client display name, no other client PII).

async function publicAdmin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

async function invoiceByPublicToken(token: string) {
  const sb = await publicAdmin();
  const { data, error } = await sb
    .from("invoices")
    .select(
      "id, organization_id, client_id, status, kind, currency, subtotal_cents, total_cents, credit_applied_cents, period_start, period_end, issued_at, paid_at, due_on, stripe_payment_intent_id, stripe_checkout_session_id, organizations(name), clients(display_name)",
    )
    .eq("public_token" as any, token)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as any;
}

export const getPublicInvoice = createServerFn({ method: "GET" })
  .inputValidator((d) => z.object({ token: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const invoice = await invoiceByPublicToken(data.token);
    if (!invoice) return { found: false as const };
    const sb = await publicAdmin();
    // Webhook-independent safety net (same as the portal list): the client may
    // reopen the link right after paying, before the webhook lands.
    if (
      invoice.status === "open" &&
      (invoice.stripe_payment_intent_id || invoice.stripe_checkout_session_id)
    ) {
      const { reconcileInvoicePayment } = await import("@/lib/invoice-reconcile.server");
      if ((await reconcileInvoicePayment(invoice.id)) === "marked_paid") {
        invoice.status = "paid";
        invoice.paid_at = invoice.paid_at ?? new Date().toISOString();
      }
    }
    const { data: items } = await sb
      .from("invoice_line_items")
      .select("id, description, amount_cents")
      .eq("invoice_id", invoice.id)
      .order("created_at");
    const org = Array.isArray(invoice.organizations) ? invoice.organizations[0] : invoice.organizations;
    const client = Array.isArray(invoice.clients) ? invoice.clients[0] : invoice.clients;
    return {
      found: true as const,
      invoice: {
        id: invoice.id as string,
        shortId: String(invoice.id).slice(0, 8),
        status: invoice.status as string,
        currency: (invoice.currency ?? "usd") as string,
        subtotalCents: invoice.subtotal_cents as number | null,
        totalCents: (invoice.total_cents ?? 0) as number,
        // B7: credit already applied and the net amount actually due.
        creditAppliedCents: (invoice.credit_applied_cents ?? 0) as number,
        amountDueCents: Math.max(
          (invoice.total_cents ?? 0) - (invoice.credit_applied_cents ?? 0),
          0,
        ),
        periodStart: invoice.period_start as string | null,
        periodEnd: invoice.period_end as string | null,
        issuedAt: invoice.issued_at as string | null,
        paidAt: invoice.paid_at as string | null,
        dueOn: invoice.due_on as string | null,
      },
      orgName: (org?.name ?? "Your service provider") as string,
      clientName: (client?.display_name ?? null) as string | null,
      items: (items ?? []).map((i: any) => ({
        id: i.id as string,
        description: i.description as string,
        amountCents: i.amount_cents as number,
      })),
    };
  });

export const createPublicInvoicePaymentIntent = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ token: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const publishableKey = process.env.STRIPE_CONNECT_PUBLISHABLE_KEY;
    if (!publishableKey) throw new Error("Payments not configured");

    const invoice = await invoiceByPublicToken(data.token);
    if (!invoice) throw new Error("Invoice not found");
    if (invoice.status === "paid") throw new Error("Invoice already paid");
    if (invoice.status === "void") throw new Error("Invoice is voided");
    // Charge the OPEN amount: total net of applied credit (B7).
    const dueCents = Math.max(
      (invoice.total_cents ?? 0) - (invoice.credit_applied_cents ?? 0),
      0,
    );
    if (dueCents <= 0) throw new Error("Nothing due on this invoice");
    // If the stored intent OR a legacy hosted-checkout session already
    // succeeded but the status is stale (webhook missed), reconcile instead
    // of minting a new intent and charging a second time.
    if (invoice.stripe_payment_intent_id || invoice.stripe_checkout_session_id) {
      const { reconcileInvoicePayment } = await import("@/lib/invoice-reconcile.server");
      if ((await reconcileInvoicePayment(invoice.id)) === "marked_paid") {
        throw new Error("Invoice already paid");
      }
    }

    const supabaseAdmin = await publicAdmin();
    const { data: cRow } = await supabaseAdmin
      .from("clients")
      .select("id, stripe_customer_id, primary_email, display_name")
      .eq("id", invoice.client_id)
      .single();
    if (!cRow) throw new Error("Invoice not found");

    const { requireOrgStripeAccount, connectStripe, verifyClientStripeCustomer } = await import("@/lib/stripe-connect.server");
    const acct = await requireOrgStripeAccount(invoice.organization_id);
    const stripe = await connectStripe();
    const opts = { stripeAccount: acct.accountId };

    let customerId = await verifyClientStripeCustomer(stripe, acct.accountId, cRow);
    if (!customerId) {
      const cust = await stripe.customers.create({
        email: cRow.primary_email ?? undefined,
        name: cRow.display_name ?? undefined,
        metadata: { client_id: cRow.id, organization_id: invoice.organization_id },
      }, opts);
      customerId = cust.id;
      await supabaseAdmin.from("clients").update({ stripe_customer_id: customerId }).eq("id", cRow.id);
    }

    const currency = (invoice.currency ?? "usd").toLowerCase();
    const metadata = {
      invoice_id: invoice.id,
      organization_id: invoice.organization_id,
      source: "public_link",
    };

    let pi: import("stripe").Stripe.PaymentIntent | null = null;
    if (invoice.stripe_payment_intent_id) {
      try {
        const existing = await stripe.paymentIntents.retrieve(invoice.stripe_payment_intent_id, {}, opts);
        // An in-flight bank debit means the invoice IS being paid; minting a
        // replacement intent would lose the reference and invite a second
        // charge while the debit clears.
        if (existing.status === "processing") {
          throw new Error(
            "A payment for this invoice is already processing. Bank payments can take a few days to clear.",
          );
        }
        if (
          existing.status === "requires_payment_method" ||
          existing.status === "requires_confirmation" ||
          existing.status === "requires_action"
        ) {
          // Always update the reused intent: syncs amount/currency, pins
          // explicit payment_method_types so previously-minted "automatic"
          // intents stop offering Klarna/Affirm/etc., and CLEARS
          // setup_future_usage — the anonymous pay-link flow must never save
          // the card (only the client's own portal session can consent).
          const updateParams = {
            amount: dueCents,
            currency,
            metadata,
            setup_future_usage: "" as const,
          };
          try {
            pi = await stripe.paymentIntents.update(existing.id, {
              ...updateParams,
              payment_method_types: INVOICE_PM_TYPES,
            }, opts);
          } catch (e) {
            if (!isBankDebitUnavailableError(e)) throw e;
            pi = await stripe.paymentIntents.update(existing.id, {
              ...updateParams,
              payment_method_types: ["card"],
            }, opts);
          }
        }
      } catch (e) {
        // The processing guard is a real answer for the caller, not a
        // retrieve hiccup — let it surface instead of minting a new intent.
        if ((e as Error).message?.startsWith("A payment for this invoice is already processing")) throw e;
        console.warn("retrieve existing PI failed, creating new", e);
      }
    }

    if (!pi) {
      // No setup_future_usage: an anonymous pay-link payer never has their
      // payment method saved.
      const createParams = {
        amount: dueCents,
        currency,
        customer: customerId,
        metadata,
      };
      try {
        pi = await stripe.paymentIntents.create({
          ...createParams,
          payment_method_types: INVOICE_PM_TYPES,
        }, opts);
      } catch (e) {
        if (!isBankDebitUnavailableError(e)) throw e;
        pi = await stripe.paymentIntents.create({
          ...createParams,
          payment_method_types: ["card"],
        }, opts);
      }
      const { error: upErr } = await supabaseAdmin
        .from("invoices")
        .update({ stripe_payment_intent_id: pi.id, status: "open" })
        .eq("id", invoice.id);
      if (upErr) throw new Error(upErr.message);
    }

    return {
      clientSecret: pi.client_secret as string,
      publishableKey,
      stripeAccount: acct.accountId,
      amountCents: dueCents,
      currency,
    };
  });
