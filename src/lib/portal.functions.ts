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
      _frequency: (data.frequency ?? null) as any,
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

// ============ Saved cards + autopay (Session 30) ============

async function loadStripe() {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) throw new Error("Payments not configured");
  const Stripe = (await import("stripe")).default;
  return new Stripe(secret);
}

async function loadClientByToken(token: string) {
  const sb = anonClient();
  const { data: rows, error } = await sb.rpc("portal_get_client", { _token: token });
  if (error) throw new Error(error.message);
  const row = rows?.[0];
  if (!row) throw new Error("Invalid portal link");
  return row;
}

/** Kick off a Stripe Checkout session in mode=setup to save a card. */
export const portalStartCardSetup = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ token: z.string().uuid(), returnUrl: z.string().url() }).parse(d))
  .handler(async ({ data }) => {
    const client = await loadClientByToken(data.token);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Ensure a Stripe customer exists for this client
    const { data: cRow } = await supabaseAdmin
      .from("clients")
      .select("id, stripe_customer_id, primary_email, display_name")
      .eq("id", client.client_id)
      .single();
    if (!cRow) throw new Error("Client not found");

    const stripe = await loadStripe();
    let customerId = cRow.stripe_customer_id;
    if (!customerId) {
      const cust = await stripe.customers.create({
        email: cRow.primary_email ?? undefined,
        name: cRow.display_name ?? undefined,
        metadata: { client_id: cRow.id, organization_id: client.organization_id },
      });
      customerId = cust.id;
      await supabaseAdmin.from("clients").update({ stripe_customer_id: customerId }).eq("id", cRow.id);
    }

    const session = await stripe.checkout.sessions.create({
      mode: "setup",
      customer: customerId,
      payment_method_types: ["card"],
      success_url: `${data.returnUrl}?card_saved=1`,
      cancel_url: data.returnUrl,
      metadata: {
        source: "portal_setup",
        client_id: cRow.id,
        organization_id: client.organization_id,
      },
    });
    return { url: session.url as string };
  });

/** Toggle autopay preference. Requires a saved card to enable. */
export const portalSetAutopay = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ token: z.string().uuid(), enabled: z.boolean() }).parse(d))
  .handler(async ({ data }) => {
    const sb = anonClient();
    const { error } = await sb.rpc("portal_set_autopay", { _token: data.token, _enabled: data.enabled });
    if (error) throw new Error(error.message);
    return { enabled: data.enabled };
  });

/** Detach saved card, disable autopay. */
export const portalRemoveCard = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ token: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const client = await loadClientByToken(data.token);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: cRow } = await supabaseAdmin
      .from("clients").select("id, default_payment_method_id").eq("id", client.client_id).single();
    if (cRow?.default_payment_method_id) {
      try {
        const stripe = await loadStripe();
        await stripe.paymentMethods.detach(cRow.default_payment_method_id);
      } catch (e) { console.warn("detach pm failed", e); }
    }
    await supabaseAdmin.from("clients").update({
      default_payment_method_id: null,
      default_card_brand: null,
      default_card_last4: null,
      autopay_enabled: false,
    }).eq("id", client.client_id);
    return { ok: true };
  });

/** Charge an open invoice off-session using the saved default card. */
export const portalPayInvoiceWithSavedCard = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ token: z.string().uuid(), invoiceId: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const client = await loadClientByToken(data.token);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: c } = await supabaseAdmin
      .from("clients").select("id, stripe_customer_id, default_payment_method_id")
      .eq("id", client.client_id).single();
    if (!c?.stripe_customer_id || !c.default_payment_method_id) throw new Error("No saved card on file");

    const { data: invoice, error: iErr } = await supabaseAdmin
      .from("invoices")
      .select("id, organization_id, client_id, total_cents, currency, status")
      .eq("id", data.invoiceId).single();
    if (iErr) throw new Error(iErr.message);
    if (invoice.client_id !== c.id) throw new Error("Invoice not found");
    if (invoice.status === "paid") throw new Error("Already paid");
    if (invoice.status === "void") throw new Error("Voided");
    if (!invoice.total_cents || invoice.total_cents <= 0) throw new Error("Zero total");

    const stripe = await loadStripe();
    try {
      const pi = await stripe.paymentIntents.create({
        amount: invoice.total_cents,
        currency: invoice.currency ?? "usd",
        customer: c.stripe_customer_id,
        payment_method: c.default_payment_method_id,
        off_session: true,
        confirm: true,
        metadata: {
          invoice_id: invoice.id,
          organization_id: invoice.organization_id,
          source: "portal_saved_card",
        },
      });
      await supabaseAdmin.from("invoices").update({
        stripe_payment_intent_id: pi.id, status: "open",
      }).eq("id", invoice.id);
      await supabaseAdmin.from("clients").update({
        autopay_last_attempt_at: new Date().toISOString(),
        autopay_last_error: null,
      }).eq("id", c.id);
      // Webhook payment_intent.succeeded will finalize the invoice + insert payment row
      return { ok: true, status: pi.status };
    } catch (e) {
      const msg = (e as Error).message || "Card charge failed";
      await supabaseAdmin.from("clients").update({
        autopay_last_attempt_at: new Date().toISOString(),
        autopay_last_error: msg,
      }).eq("id", c.id);
      throw new Error(msg);
    }
  });

// ── Portal: history, dogs, concerns, photo signing ──────────────────────────

export const portalListRecentVisits = createServerFn({ method: "GET" })
  .inputValidator((d) => tokenSchema.parse(d))
  .handler(async ({ data }) => {
    const sb = anonClient();
    const { data: rows, error } = await sb.rpc("portal_list_recent_visits", { _token: data.token });
    if (error) throw new Error(error.message);
    return (rows ?? []) as Array<{
      visit_id: string; scheduled_on: string; status: string; photo_paths: string[];
    }>;
  });

export const portalListDogs = createServerFn({ method: "GET" })
  .inputValidator((d) => tokenSchema.parse(d))
  .handler(async ({ data }) => {
    const sb = anonClient();
    const { data: rows, error } = await sb.rpc("portal_list_dogs", { _token: data.token });
    if (error) throw new Error(error.message);
    return (rows ?? []) as Array<{
      dog_id: string; name: string; breed: string | null; weight_class: string | null;
      temperament: string | null; notes: string | null;
    }>;
  });

export const portalReportConcern = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z.object({
      token: z.string().uuid(),
      visitId: z.string().uuid().nullable(),
      category: z.enum(["missed_spot","gate_left_open","damage","wrong_yard","other"]),
      message: z.string().max(1000).optional().default(""),
    }).parse(d),
  )
  .handler(async ({ data }) => {
    const sb = anonClient();
    const { data: id, error } = await sb.rpc("portal_report_concern", {
      _token: data.token,
      _visit_id: data.visitId as string,

      _category: data.category,
      _message: data.message,
    });
    if (error) throw new Error(error.message);
    return { ticketId: id as string };
  });

export const portalSignPhotoUrls = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z.object({ token: z.string().uuid(), paths: z.array(z.string()).max(60) }).parse(d),
  )
  .handler(async ({ data }) => {
    // Verify token is valid before signing
    const sb = anonClient();
    const { data: rows } = await sb.rpc("portal_get_client", { _token: data.token });
    if (!rows?.[0]) throw new Error("Invalid token");
    if (data.paths.length === 0) return { urls: {} as Record<string, string> };
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: signed, error } = await supabaseAdmin.storage
      .from("visit-photos")
      .createSignedUrls(data.paths, 600);
    if (error) throw new Error(error.message);
    const urls: Record<string, string> = {};
    for (const s of signed ?? []) if (s.path && s.signedUrl) urls[s.path] = s.signedUrl;
    return { urls };
  });

export const portalGetReferral = createServerFn({ method: "GET" })
  .inputValidator((d) => tokenSchema.parse(d))
  .handler(async ({ data }) => {
    const sb = anonClient();
    const { data: rows, error } = await sb.rpc("portal_get_referral", { _token: data.token });
    if (error) throw new Error(error.message);
    return (rows?.[0] ?? { referral_code: null }) as { referral_code: string | null };
  });




