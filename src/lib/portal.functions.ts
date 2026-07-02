import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

// Anonymous supabase client — safe on server for calling anon-granted RPCs.
function anonClient() {
  return createClient<Database>(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_PUBLISHABLE_KEY!,
    { auth: { storage: undefined, persistSession: false, autoRefreshToken: false } },
  );
}

const tokenSchema = z.object({ token: z.string().uuid() });

export const portalGetClient = createServerFn({ method: "GET" })
  .inputValidator((d) => tokenSchema.parse(d))
  .handler(async ({ data }) => {
    const sb = anonClient();
    const { data: rows, error } = await sb.rpc("portal_get_client", { _token: data.token });
    if (error) throw new Error(error.message);
    const row = rows?.[0];
    if (!row) throw new Error("Invalid or expired portal link");
    return row;
  });

export const portalListUpcomingVisits = createServerFn({ method: "GET" })
  .inputValidator((d) => tokenSchema.parse(d))
  .handler(async ({ data }) => {
    const sb = anonClient();
    const { data: rows, error } = await sb.rpc("portal_list_upcoming_visits", { _token: data.token });
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const portalListInvoices = createServerFn({ method: "GET" })
  .inputValidator((d) => tokenSchema.parse(d))
  .handler(async ({ data }) => {
    const sb = anonClient();
    const { data: rows, error } = await sb.rpc("portal_list_invoices", { _token: data.token });
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const portalListPrepaidSubs = createServerFn({ method: "GET" })
  .inputValidator((d) => tokenSchema.parse(d))
  .handler(async ({ data }) => {
    const sb = anonClient();
    const { data: rows, error } = await sb.rpc("portal_list_prepaid_subscriptions", { _token: data.token });
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const portalRequestSkip = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z.object({
      token: z.string().uuid(),
      visitId: z.string().uuid(),
      reason: z.string().max(500).optional().default(""),
    }).parse(d),
  )
  .handler(async ({ data }) => {
    const sb = anonClient();
    const { error } = await sb.rpc("portal_request_skip", {
      _token: data.token, _visit_id: data.visitId, _reason: data.reason,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const portalStartPrepaidTopup = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z.object({
      token: z.string().uuid(),
      subscriptionId: z.string().uuid(),
      visitCount: z.number().int().min(1).max(52),
    }).parse(d),
  )
  .handler(async ({ data }) => {
    const sb = anonClient();
    const { data: id, error } = await sb.rpc("portal_start_prepaid_topup", {
      _token: data.token, _subscription_id: data.subscriptionId, _visit_count: data.visitCount,
    });
    if (error) throw new Error(error.message);
    return { invoiceId: id as string };
  });

export const portalCreateCheckout = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z.object({
      token: z.string().uuid(),
      invoiceId: z.string().uuid(),
      returnUrl: z.string().url(),
    }).parse(d),
  )
  .handler(async ({ data }) => {
    // 1) Verify token, get client_id + org_id
    const sb = anonClient();
    const { data: rows, error } = await sb.rpc("portal_get_client", { _token: data.token });
    if (error) throw new Error(error.message);
    const client = rows?.[0];
    if (!client) throw new Error("Invalid portal link");

    // 2) Load invoice via admin, verify it belongs to this client
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: invoice, error: iErr } = await supabaseAdmin
      .from("invoices")
      .select("id, organization_id, client_id, total_cents, currency, status, stripe_checkout_session_id, checkout_url")
      .eq("id", data.invoiceId)
      .single();
    if (iErr) throw new Error(iErr.message);
    if (invoice.client_id !== client.client_id) throw new Error("Invoice not found");
    if (invoice.status === "paid") throw new Error("Invoice already paid");
    if (invoice.status === "void") throw new Error("Invoice is voided");
    if (!invoice.total_cents || invoice.total_cents <= 0) throw new Error("Invoice total is zero");

    const secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) throw new Error("Payments not configured");
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(secret);
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      success_url: `${data.returnUrl}?paid=1`,
      cancel_url: data.returnUrl,
      client_reference_id: invoice.id,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: invoice.currency ?? "usd",
          unit_amount: invoice.total_cents,
          product_data: { name: `Invoice ${invoice.id.slice(0, 8)} — ${client.display_name}` },
        },
      }],
      metadata: { invoice_id: invoice.id, organization_id: invoice.organization_id, source: "portal" },
    });

    await supabaseAdmin
      .from("invoices")
      .update({
        stripe_checkout_session_id: session.id,
        checkout_url: session.url,
        status: "open",
      })
      .eq("id", invoice.id);

    return { url: session.url as string };
  });

const frequencyEnum = z.enum(["weekly", "biweekly", "twice_weekly", "monthly"]);
const addonFreqEnum = z.enum(["weekly", "biweekly", "monthly", "quarterly", "yearly"]);

export const portalRescheduleVisit = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z.object({
      token: z.string().uuid(),
      visitId: z.string().uuid(),
      newDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }).parse(d),
  )
  .handler(async ({ data }) => {
    const sb = anonClient();
    const { error } = await sb.rpc("portal_reschedule_visit", {
      _token: data.token, _visit_id: data.visitId, _new_date: data.newDate,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const portalChangeFrequency = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z.object({
      token: z.string().uuid(),
      subscriptionId: z.string().uuid(),
      frequency: frequencyEnum,
    }).parse(d),
  )
  .handler(async ({ data }) => {
    const sb = anonClient();
    const { error } = await sb.rpc("portal_change_frequency", {
      _token: data.token, _subscription_id: data.subscriptionId, _new_frequency: data.frequency,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const portalListAddonCatalog = createServerFn({ method: "GET" })
  .inputValidator((d) => tokenSchema.parse(d))
  .handler(async ({ data }) => {
    const sb = anonClient();
    const { data: rows, error } = await sb.rpc("portal_list_addon_catalog", { _token: data.token });
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const portalListClientAddons = createServerFn({ method: "GET" })
  .inputValidator((d) => tokenSchema.parse(d))
  .handler(async ({ data }) => {
    const sb = anonClient();
    const { data: rows, error } = await sb.rpc("portal_list_client_addons", { _token: data.token });
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const portalSubscribeAddon = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z.object({
      token: z.string().uuid(),
      addonServiceId: z.string().uuid(),
      frequency: addonFreqEnum.nullable().optional(),
      quantity: z.number().int().min(1).max(50).default(1),
    }).parse(d),
  )
  .handler(async ({ data }) => {
    const sb = anonClient();
    const { data: id, error } = await sb.rpc("portal_subscribe_addon", {
      _token: data.token,
      _addon_service_id: data.addonServiceId,
      _frequency: data.frequency ?? null,
      _quantity: data.quantity,
    });
    if (error) throw new Error(error.message);
    return { id: id as string };
  });

export const portalCancelAddon = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z.object({
      token: z.string().uuid(),
      addonSubscriptionId: z.string().uuid(),
    }).parse(d),
  )
  .handler(async ({ data }) => {
    const sb = anonClient();
    const { error } = await sb.rpc("portal_cancel_addon", {
      _token: data.token, _addon_subscription_id: data.addonSubscriptionId,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

