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
      .select("id, client_id, status, subtotal_cents, total_cents, currency, period_start, period_end, issued_at, paid_at, checkout_url, clients(display_name)")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
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
        notes: data.notes ?? "Manual invoice",
      })
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
        .select("id, status, total_cents, currency, client_id, organization_id")
        .eq("id", id)
        .single();
      if (rErr || !inv) { failed++; continue; }
      if (inv.status === "paid" || inv.status === "void") { failed++; continue; }
      const { error: uErr } = await supabase
        .from("invoices")
        .update({ status: "paid", paid_at: nowIso })
        .eq("id", id);
      if (uErr) { failed++; continue; }
      await supabase.from("payments").insert({
        invoice_id: id,
        organization_id: inv.organization_id,
        amount_cents: inv.total_cents,
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
    const { data: invoice, error } = await supabase
      .from("invoices")
      .select("id, organization_id, client_id, total_cents, currency, status, stripe_checkout_session_id, stripe_payment_intent_id")
      .eq("id", data.id)
      .single();
    if (error) throw new Error(error.message);
    if (invoice.status === "paid") throw new Error("Invoice already paid");
    if (invoice.status === "void") throw new Error("Invoice is voided");
    if (!invoice.total_cents || invoice.total_cents <= 0) throw new Error("Invoice total is zero");
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
        if (
          existing.status === "requires_payment_method" ||
          existing.status === "requires_confirmation" ||
          existing.status === "requires_action"
        ) {
          // Always update the reused intent: syncs amount/currency and pins
          // explicit payment_method_types so previously-minted "automatic"
          // intents stop offering Klarna/Affirm/etc.
          const updateParams = { amount: invoice.total_cents, currency, metadata };
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
        console.warn("retrieve existing PI failed, creating new", e);
      }
    }

    if (!pi) {
      // No setup_future_usage here: staff must not save the client's payment
      // method without the client's own consent (portal flow only).
      const createParams = {
        amount: invoice.total_cents,
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
      amountCents: invoice.total_cents as number,
      currency,
    };
  });

// In-app payments follow-up: staff share the client's PORTAL billing link
// (which pays inside our app) instead of a raw checkout.stripe.com URL.
export const getInvoicePortalLink = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ invoiceId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await requirePermission(supabase, context.userId, "manage_client_billing");
    const { data: invoice, error } = await supabase
      .from("invoices")
      .select("id, organization_id, client_id, clients(portal_token)")
      .eq("id", data.invoiceId)
      .single();
    if (error) throw new Error(error.message);
    const client = Array.isArray(invoice.clients)
      ? invoice.clients[0]
      : (invoice.clients as { portal_token?: string | null } | null);
    if (!client?.portal_token) throw new Error("Client has no portal link");
    const { buildPortalLink } = await import("@/lib/portal-links.server");
    const base = await buildPortalLink(invoice.organization_id, client.portal_token);
    if (!base) throw new Error("Could not build the portal link");
    return { url: `${base}/billing` };
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
        .select("id, status, kind, currency, subtotal_cents, total_cents, period_start, period_end, issued_at, paid_at, checkout_url, created_at")
        .eq("client_id", data.clientId)
        .order("created_at", { ascending: false })
        .limit(25),
    ]);
    if (clientRes.error) throw new Error(clientRes.error.message);

    const invoices = invoicesRes.data ?? [];
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

    return {
      client: clientRes.data,
      invoices,
      payments: paymentsRes.data ?? [],
      openCount: openInvoices.length,
      openTotalCents: openInvoices.reduce((s, i) => s + (i.total_cents ?? 0), 0),
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


/** Invoice detail drawer (QA follow-up 2.3): line items + payment attempts
 * without leaving the client page. */
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
            "id, status, kind, currency, subtotal_cents, total_cents, period_start, period_end, issued_at, paid_at, voided_at, notes, checkout_url, created_at",
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
    return { invoice, lineItems: lines ?? [], payments: pays ?? [] };
  });
