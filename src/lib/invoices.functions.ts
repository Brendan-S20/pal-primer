import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const listInvoices = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
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
    const { data: invoice, error } = await supabase
      .from("invoices")
      .select("*, clients(display_name, primary_email)")
      .eq("id", data.id)
      .single();
    if (error) throw new Error(error.message);
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
    const { data: id, error } = await supabase.rpc("generate_invoice_for_client", {
      _client_id: data.clientId,
      _through: data.through,
    });
    if (error) throw new Error(error.message);
    return { invoiceId: id as string };
  });

export const voidInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.rpc("void_invoice", { _invoice_id: data.id });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const bulkVoidInvoices = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ ids: z.array(z.string().uuid()).min(1).max(500) }).parse(d))
  .handler(async ({ data, context }) => {
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

export const createCheckoutForInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid(), returnUrl: z.string().url() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    // Read invoice + verify access via RLS
    const { data: invoice, error } = await supabase
      .from("invoices")
      .select("id, organization_id, client_id, total_cents, currency, status, clients(display_name, primary_email)")
      .eq("id", data.id)
      .single();
    if (error) throw new Error(error.message);
    if (invoice.status === "paid") throw new Error("Invoice already paid");
    if (invoice.status === "void") throw new Error("Invoice is voided");
    if (!invoice.total_cents || invoice.total_cents <= 0) throw new Error("Invoice total is zero");

    const secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) throw new Error("STRIPE_SECRET_KEY not configured");

    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(secret);
    const client = Array.isArray(invoice.clients) ? invoice.clients[0] : (invoice.clients as { display_name?: string; primary_email?: string } | null);
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      success_url: `${data.returnUrl}?paid=1`,
      cancel_url: data.returnUrl,
      client_reference_id: invoice.id,
      customer_email: client?.primary_email ?? undefined,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: invoice.currency ?? "usd",
          unit_amount: invoice.total_cents,
          product_data: { name: `Invoice ${invoice.id.slice(0, 8)} — ${client?.display_name ?? "Service"}` },
        },
      }],
      metadata: { invoice_id: invoice.id, organization_id: invoice.organization_id },
    });

    // Persist checkout session details (RLS: manager)
    const { error: upErr } = await supabase
      .from("invoices")
      .update({
        stripe_checkout_session_id: session.id,
        checkout_url: session.url,
        status: "open",
      })
      .eq("id", invoice.id);
    if (upErr) throw new Error(upErr.message);

    return { url: session.url as string, sessionId: session.id };
  });

export const listUnbilledForClient = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
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

    const [clientRes, invoicesRes] = await Promise.all([
      supabase
        .from("clients")
        .select("autopay_enabled, default_card_brand, default_card_last4, default_payment_method_id, stripe_customer_id, primary_email")
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
