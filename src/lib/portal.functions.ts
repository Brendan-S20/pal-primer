import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

// portal-auth.server.ts imports server-only @tanstack/react-start/server, which
// is denied in the client bundle. This file (a *.functions.ts) is reachable
// from client code, so portal-auth MUST be imported ONLY inside handler bodies
// (which the TanStack compiler strips from the client build) — never at module
// scope. Same reason we import client.server dynamically below.
async function portalAuth() {
  return import("@/lib/portal-auth.server");
}

// All portal_* RPCs are revoked from anon (finding #4) and run via
// service_role after a session check. supabaseAdmin bypasses RLS; every
// handler that touches client data first calls requirePortalSession(token),
// and every RPC still filters internally by portal_token.
async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

const tokenSchema = z.object({ token: z.string().uuid() });

// ============ Auth entry points (no session required) ============

/**
 * Bootstrap the portal. Returns whether this device is already verified. When
 * verified, includes the full client payload; when not, returns ONLY the org
 * name and masked contact channels — no client name, balance, or schedule
 * leaks before the OTP is passed.
 */
export const portalContext = createServerFn({ method: "GET" })
  .inputValidator((d) => tokenSchema.parse(d))
  .handler(async ({ data }) => {
    const { portalContactChannels, getPortalSession } = await portalAuth();
    const contact = await portalContactChannels(data.token);
    if (!contact) return { verified: false as const, valid: false as const, channels: [], branding: null };

    const session = await getPortalSession(data.token);
    if (!session) {
      return {
        verified: false as const,
        valid: true as const,
        channels: contact.channels,
        branding: contact.branding,
      };
    }
    const sb = await admin();
    const { data: rows, error } = await sb.rpc("portal_get_client", { _token: data.token });
    if (error) throw new Error(error.message);
    const client = rows?.[0];
    if (!client) return { verified: false as const, valid: false as const, channels: [], branding: null };
    return { verified: true as const, valid: true as const, client, branding: contact.branding };
  });

// ── Generic company sign-in (/portal/{slug}) ────────────────────────────────

/** Org branding for the generic sign-in page, by slug. */
export const portalOrgBySlug = createServerFn({ method: "GET" })
  .inputValidator((d) => z.object({ slug: z.string().min(1).max(120) }).parse(d))
  .handler(async ({ data }) => {
    const { orgBrandingBySlug } = await portalAuth();
    const org = await orgBrandingBySlug(data.slug);
    if (!org) return { found: false as const };
    return { found: true as const, branding: org };
  });

/** Resolve a legacy bare token to its org slug so /portal/{uuid} can redirect. */
export const portalResolveLegacy = createServerFn({ method: "GET" })
  .inputValidator((d) => z.object({ token: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const { slugForToken } = await portalAuth();
    const slug = await slugForToken(data.token);
    return { slug };
  });

/** Identify a client in ONE org by phone/email and send an OTP. */
export const portalIdentify = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z.object({ slug: z.string().min(1).max(120), contact: z.string().min(3).max(200) }).parse(d),
  )
  .handler(async ({ data }) => {
    const { portalIdentify: identify } = await portalAuth();
    return identify(data.slug, data.contact);
  });

/** Verify a generic-entry code: establishes a session, or returns a picker. */
export const portalVerifyGenericOtp = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        slug: z.string().min(1).max(120),
        contact: z.string().min(3).max(200),
        code: z.string().min(4).max(10),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { portalVerifyGeneric } = await portalAuth();
    return portalVerifyGeneric(data.slug, data.contact, data.code);
  });

/** After a multi-match verify, mint the session for the chosen account. */
export const portalChooseAccount = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ clientId: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const { portalChooseClient } = await portalAuth();
    return portalChooseClient(data.clientId);
  });

/** Generic entry: redeem a code the client already has, without identifying. */
export const portalRedeemCode = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z.object({ slug: z.string().min(1).max(120), code: z.string().min(4).max(10) }).parse(d),
  )
  .handler(async ({ data }) => {
    const { portalRedeemOrgCode } = await portalAuth();
    return portalRedeemOrgCode(data.slug, data.code);
  });

export const portalRequestOtp = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z.object({ token: z.string().uuid(), channel: z.enum(["sms", "email"]) }).parse(d),
  )
  .handler(async ({ data }) => {
    const { issuePortalOtp } = await portalAuth();
    return issuePortalOtp(data.token, data.channel);
  });

export const portalVerifyOtp = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z.object({ token: z.string().uuid(), code: z.string().min(4).max(10) }).parse(d),
  )
  .handler(async ({ data }) => {
    const { verifyPortalOtp } = await portalAuth();
    const ok = await verifyPortalOtp(data.token, data.code);
    return { verified: ok };
  });

// ============ Client data + the original client loader (session-gated) ============

export const portalGetClient = createServerFn({ method: "GET" })
  .inputValidator((d) => tokenSchema.parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    await requirePortalSession(data.token);
    const sb = await admin();
    const { data: rows, error } = await sb.rpc("portal_get_client", { _token: data.token });
    if (error) throw new Error(error.message);
    const row = rows?.[0];
    if (!row) throw new Error("Invalid or expired portal link");
    return row;
  });

export const portalListUpcomingVisits = createServerFn({ method: "GET" })
  .inputValidator((d) => tokenSchema.parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    await requirePortalSession(data.token);
    const sb = await admin();
    const { data: rows, error } = await sb.rpc("portal_list_upcoming_visits", { _token: data.token });
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const portalListInvoices = createServerFn({ method: "GET" })
  .inputValidator((d) => tokenSchema.parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token);
    const sb = await admin();
    // Webhook-independent safety net: the client may have just returned from a
    // paid Checkout (?paid=1) before the webhook landed — verify this client's
    // open sessions against Stripe so the list shows the real state.
    const { data: opens } = await sb
      .from("invoices")
      .select("id")
      .eq("client_id", session.clientId)
      .eq("status", "open")
      .or("stripe_checkout_session_id.not.is.null,stripe_payment_intent_id.not.is.null")
      .order("updated_at", { ascending: false })
      .limit(5);
    if (opens?.length) {
      const { reconcileInvoicePayment } = await import("@/lib/invoice-reconcile.server");
      for (const r of opens) await reconcileInvoicePayment(r.id);
    }
    const { data: rows, error } = await sb.rpc("portal_list_invoices", { _token: data.token });
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const portalListPrepaidSubs = createServerFn({ method: "GET" })
  .inputValidator((d) => tokenSchema.parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    await requirePortalSession(data.token);
    const sb = await admin();
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
    const { requirePortalSession } = await portalAuth();
    await requirePortalSession(data.token);
    const sb = await admin();
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
    const { requirePortalSession } = await portalAuth();
    await requirePortalSession(data.token);
    const sb = await admin();
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
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token);
    const supabaseAdmin = await admin();
    const { data: invoice, error: iErr } = await supabaseAdmin
      .from("invoices")
      .select("id, organization_id, client_id, total_cents, currency, status, stripe_checkout_session_id, stripe_payment_intent_id, checkout_url")
      .eq("id", data.invoiceId)
      .single();
    if (iErr) throw new Error(iErr.message);
    if (invoice.client_id !== session.clientId) throw new Error("Invoice not found");
    if (invoice.status === "paid") throw new Error("Invoice already paid");
    if (invoice.status === "void") throw new Error("Invoice is voided");
    if (!invoice.total_cents || invoice.total_cents <= 0) throw new Error("Invoice total is zero");
    // If a previous session/intent was already paid but the status is stale
    // (webhook missed), reconcile instead of charging the client a second time.
    if (invoice.stripe_checkout_session_id || invoice.stripe_payment_intent_id) {
      const { reconcileInvoicePayment } = await import("@/lib/invoice-reconcile.server");
      if ((await reconcileInvoicePayment(invoice.id)) === "marked_paid") {
        throw new Error("Invoice already paid");
      }
    }

    const { requireOrgStripeAccount, connectStripe } = await import("@/lib/stripe-connect.server");
    const acct = await requireOrgStripeAccount(invoice.organization_id);
    const { data: client } = await supabaseAdmin
      .from("clients").select("display_name").eq("id", session.clientId).single();
    const stripe = await connectStripe();
    const checkout = await stripe.checkout.sessions.create({
      mode: "payment",
      success_url: `${data.returnUrl}?paid=1`,
      cancel_url: data.returnUrl,
      client_reference_id: invoice.id,
      payment_method_types: ["card", "us_bank_account"],
      line_items: [{
        quantity: 1,
        price_data: {
          currency: invoice.currency ?? "usd",
          unit_amount: invoice.total_cents,
          product_data: { name: `Invoice ${invoice.id.slice(0, 8)}: ${client?.display_name ?? "Service"}` },
        },
      }],
      metadata: { invoice_id: invoice.id, organization_id: invoice.organization_id, source: "portal" },
    }, { stripeAccount: acct.accountId });

    await supabaseAdmin
      .from("invoices")
      .update({
        stripe_checkout_session_id: checkout.id,
        checkout_url: checkout.url,
        status: "open",
      })
      .eq("id", invoice.id);

    return { url: checkout.url as string };
  });

// In-app payment: same connected-account Checkout session as
// portalCreateCheckout, but ui_mode embedded so the client pays right on the
// portal pay page — no checkout.stripe.com navigation. Mirrors the owner-side
// createEmbeddedCheckoutForInvoice return shape.
export const portalCreateEmbeddedCheckout = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z.object({
      token: z.string().uuid(),
      invoiceId: z.string().uuid(),
      returnUrl: z.string().url(),
    }).parse(d),
  )
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token);
    const supabaseAdmin = await admin();
    const { data: invoice, error: iErr } = await supabaseAdmin
      .from("invoices")
      .select("id, organization_id, client_id, total_cents, currency, status, stripe_checkout_session_id, stripe_payment_intent_id")
      .eq("id", data.invoiceId)
      .single();
    if (iErr) throw new Error(iErr.message);
    if (invoice.client_id !== session.clientId) throw new Error("Invoice not found");
    if (invoice.status === "paid") throw new Error("Invoice already paid");
    if (invoice.status === "void") throw new Error("Invoice is voided");
    if (!invoice.total_cents || invoice.total_cents <= 0) throw new Error("Invoice total is zero");
    // If a previous session/intent was already paid but the status is stale
    // (webhook missed), reconcile instead of charging the client a second time.
    if (invoice.stripe_checkout_session_id || invoice.stripe_payment_intent_id) {
      const { reconcileInvoicePayment } = await import("@/lib/invoice-reconcile.server");
      if ((await reconcileInvoicePayment(invoice.id)) === "marked_paid") {
        throw new Error("Invoice already paid");
      }
    }

    const { requireOrgStripeAccount, connectStripe, connectPublishableKey } = await import("@/lib/stripe-connect.server");
    const acct = await requireOrgStripeAccount(invoice.organization_id);
    const { data: client } = await supabaseAdmin
      .from("clients").select("display_name").eq("id", session.clientId).single();
    const stripe = await connectStripe();
    const checkout = await stripe.checkout.sessions.create({
      mode: "payment",
      ui_mode: "embedded_page",
      return_url: `${data.returnUrl}${data.returnUrl.includes("?") ? "&" : "?"}paid=1`,
      client_reference_id: invoice.id,
      payment_method_types: ["card", "us_bank_account"],
      line_items: [{
        quantity: 1,
        price_data: {
          currency: invoice.currency ?? "usd",
          unit_amount: invoice.total_cents,
          product_data: { name: `Invoice ${invoice.id.slice(0, 8)}: ${client?.display_name ?? "Service"}` },
        },
      }],
      metadata: { invoice_id: invoice.id, organization_id: invoice.organization_id, source: "portal" },
    }, { stripeAccount: acct.accountId });

    await supabaseAdmin
      .from("invoices")
      .update({
        stripe_checkout_session_id: checkout.id,
        status: "open",
      })
      .eq("id", invoice.id);

    return {
      clientSecret: checkout.client_secret as string,
      publishableKey: connectPublishableKey(),
      stripeAccount: acct.accountId,
      amountCents: invoice.total_cents as number,
      currency: (invoice.currency ?? "usd") as string,
      businessName: client?.display_name as string,
    };
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
    const { requirePortalSession } = await portalAuth();
    await requirePortalSession(data.token);
    const sb = await admin();
    const { error } = await sb.rpc("portal_reschedule_visit", {
      _token: data.token, _visit_id: data.visitId, _new_date: data.newDate,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// Finding #29: a client with 2+ properties saw one undifferentiated portal
// view with no address labels. This lists their serviced properties so the
// portal can show each address distinctly.
export const portalListProperties = createServerFn({ method: "GET" })
  .inputValidator((d) => tokenSchema.parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token);
    const sb = await admin();
    const { data: rows, error } = await sb
      .from("properties")
      .select("id, label, street, city, region, postal_code")
      .eq("client_id", session.clientId)
      .order("created_at");
    if (error) throw new Error(error.message);
    return { properties: rows ?? [] };
  });

// Finding #36: the org's self-serve permission toggles (vacation hold, change
// frequency) had no matching portal UI. This returns whether each is enabled
// plus the client's active subscription, so the portal can render (only) the
// controls the owner has switched on.
export const portalSelfServeOptions = createServerFn({ method: "GET" })
  .inputValidator((d) => tokenSchema.parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token);
    const sb = await admin();
    const [{ data: org }, { data: subs }] = await Promise.all([
      sb
        .from("organizations")
        .select("portal_allow_vacation_hold, portal_allow_frequency_change")
        .eq("id", session.organizationId)
        .maybeSingle(),
      sb
        .from("subscriptions")
        .select("id, frequency, status")
        .eq("client_id", session.clientId)
        .eq("status", "active")
        .order("started_on", { ascending: false })
        .limit(1),
    ]);
    const sub = (subs ?? [])[0] ?? null;
    return {
      allowVacationHold: !!org?.portal_allow_vacation_hold,
      allowFrequencyChange: !!org?.portal_allow_frequency_change,
      subscription: sub ? { id: sub.id as string, frequency: sub.frequency as string } : null,
    };
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
    const { requirePortalSession } = await portalAuth();
    await requirePortalSession(data.token);
    const sb = await admin();
    const { error } = await sb.rpc("portal_change_frequency", {
      _token: data.token, _subscription_id: data.subscriptionId, _new_frequency: data.frequency,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const portalListAddonCatalog = createServerFn({ method: "GET" })
  .inputValidator((d) => tokenSchema.parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    await requirePortalSession(data.token);
    const sb = await admin();
    const { data: rows, error } = await sb.rpc("portal_list_addon_catalog", { _token: data.token });
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const portalListClientAddons = createServerFn({ method: "GET" })
  .inputValidator((d) => tokenSchema.parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    await requirePortalSession(data.token);
    const sb = await admin();
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
      propertyId: z.string().uuid().nullable().optional(),
    }).parse(d),
  )
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    await requirePortalSession(data.token);
    const sb = await admin();
    const { data: id, error } = await sb.rpc("portal_subscribe_addon", {
      _token: data.token,
      _addon_service_id: data.addonServiceId,
      _frequency: (data.frequency ?? null) as any,
      _quantity: data.quantity,
      _property_id: (data.propertyId ?? null) as any,
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
    const { requirePortalSession } = await portalAuth();
    await requirePortalSession(data.token);
    const sb = await admin();
    const { error } = await sb.rpc("portal_cancel_addon", {
      _token: data.token, _addon_subscription_id: data.addonSubscriptionId,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ============ Saved cards + autopay ============

// Tenant->client card ops run on the org's own connected Stripe account.
async function loadStripe(orgId: string): Promise<{ stripe: any; stripeAccount: string }> {
  const { requireOrgStripeAccount, connectStripe } = await import("@/lib/stripe-connect.server");
  const acct = await requireOrgStripeAccount(orgId);
  const stripe = await connectStripe();
  return { stripe, stripeAccount: acct.accountId };
}

/** Kick off a Stripe Checkout session in mode=setup to save a card. */
export const portalStartCardSetup = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ token: z.string().uuid(), returnUrl: z.string().url() }).parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token);
    const supabaseAdmin = await admin();

    const { data: cRow } = await supabaseAdmin
      .from("clients")
      .select("id, stripe_customer_id, primary_email, display_name")
      .eq("id", session.clientId)
      .single();
    if (!cRow) throw new Error("Client not found");

    const { stripe, stripeAccount } = await loadStripe(session.organizationId);
    const { verifyClientStripeCustomer } = await import("@/lib/stripe-connect.server");
    let customerId = await verifyClientStripeCustomer(stripe, stripeAccount, cRow);
    if (!customerId) {
      const cust = await stripe.customers.create({
        email: cRow.primary_email ?? undefined,
        name: cRow.display_name ?? undefined,
        metadata: { client_id: cRow.id, organization_id: session.organizationId },
      }, { stripeAccount });
      customerId = cust.id;
      await supabaseAdmin.from("clients").update({ stripe_customer_id: customerId }).eq("id", cRow.id);
    }

    const checkout = await stripe.checkout.sessions.create({
      mode: "setup",
      customer: customerId,
      payment_method_types: ["card"],
      success_url: `${data.returnUrl}?card_saved=1`,
      cancel_url: data.returnUrl,
      metadata: {
        source: "portal_setup",
        client_id: cRow.id,
        organization_id: session.organizationId,
      },
    }, { stripeAccount });
    return { url: checkout.url as string };
  });

/** Inline (embedded) card save: create a SetupIntent on the connected account
 *  for a Payment Element, instead of redirecting to hosted Checkout. */
export const portalCreateSetupIntent = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ token: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token);
    const supabaseAdmin = await admin();
    const { data: cRow } = await supabaseAdmin
      .from("clients")
      .select("id, stripe_customer_id, primary_email, display_name")
      .eq("id", session.clientId)
      .single();
    if (!cRow) throw new Error("Client not found");

    const { requireOrgStripeAccount, connectStripe, connectPublishableKey, verifyClientStripeCustomer } = await import("@/lib/stripe-connect.server");
    const acct = await requireOrgStripeAccount(session.organizationId);
    const stripe = await connectStripe();
    const opts = { stripeAccount: acct.accountId };

    let customerId = await verifyClientStripeCustomer(stripe, acct.accountId, cRow);
    if (!customerId) {
      const cust = await stripe.customers.create({
        email: cRow.primary_email ?? undefined,
        name: cRow.display_name ?? undefined,
        metadata: { client_id: cRow.id, organization_id: session.organizationId },
      }, opts);
      customerId = cust.id;
      await supabaseAdmin.from("clients").update({ stripe_customer_id: customerId }).eq("id", cRow.id);
    }

    const si = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ["card"],
      usage: "off_session",
      metadata: { client_id: cRow.id, organization_id: session.organizationId, source: "portal_setup_inline" },
    }, opts);
    return { clientSecret: si.client_secret as string, publishableKey: connectPublishableKey(), stripeAccount: acct.accountId };
  });

/** Finalize an inline card save: mark the confirmed payment method as the
 *  client's default and record the card details. */
export const portalFinalizeCardSetup = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ token: z.string().uuid(), setupIntentId: z.string().min(3) }).parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token);
    const supabaseAdmin = await admin();
    const { requireOrgStripeAccount, connectStripe } = await import("@/lib/stripe-connect.server");
    const acct = await requireOrgStripeAccount(session.organizationId);
    const stripe = await connectStripe();
    const opts = { stripeAccount: acct.accountId };

    const si = await stripe.setupIntents.retrieve(data.setupIntentId, {}, opts);
    const pmId = typeof si.payment_method === "string" ? si.payment_method : si.payment_method?.id;
    const customerId = typeof si.customer === "string" ? si.customer : si.customer?.id;
    if (!pmId || !customerId) throw new Error("Card wasn't saved. Please try again.");
    // Security (M2): the SetupIntent must be the one we minted for THIS client,
    // so a leaked/guessed seti_… id from another client can't bind their card here.
    if (si.metadata?.client_id !== session.clientId) throw new Error("Card setup could not be verified.");

    const pm = await stripe.paymentMethods.retrieve(pmId, {}, opts);
    await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: pmId } }, opts);
    await supabaseAdmin.from("clients").update({
      stripe_customer_id: customerId,
      default_payment_method_id: pmId,
      default_card_brand: pm.card?.brand ?? null,
      default_card_last4: pm.card?.last4 ?? null,
      autopay_enabled: true,
    }).eq("id", session.clientId);
    return { ok: true, brand: pm.card?.brand ?? null, last4: pm.card?.last4 ?? null };
  });

/** Toggle autopay preference. Requires a saved card to enable. */
export const portalSetAutopay = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ token: z.string().uuid(), enabled: z.boolean() }).parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    await requirePortalSession(data.token);
    const sb = await admin();
    const { error } = await sb.rpc("portal_set_autopay", { _token: data.token, _enabled: data.enabled });
    if (error) throw new Error(error.message);
    return { enabled: data.enabled };
  });

/** Detach saved card, disable autopay. */
export const portalRemoveCard = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ token: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token);
    const supabaseAdmin = await admin();
    const { data: cRow } = await supabaseAdmin
      .from("clients").select("id, default_payment_method_id").eq("id", session.clientId).single();
    if (cRow?.default_payment_method_id) {
      try {
        const { stripe, stripeAccount } = await loadStripe(session.organizationId);
        await stripe.paymentMethods.detach(cRow.default_payment_method_id, {}, { stripeAccount });
      } catch (e) { console.warn("detach pm failed", e); }
    }
    await supabaseAdmin.from("clients").update({
      default_payment_method_id: null,
      default_card_brand: null,
      default_card_last4: null,
      autopay_enabled: false,
    }).eq("id", session.clientId);
    return { ok: true };
  });

/** Charge an open invoice off-session using the saved default card. */
export const portalPayInvoiceWithSavedCard = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ token: z.string().uuid(), invoiceId: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token);
    const supabaseAdmin = await admin();
    const { data: c } = await supabaseAdmin
      .from("clients").select("id, stripe_customer_id, default_payment_method_id")
      .eq("id", session.clientId).single();
    if (!c?.stripe_customer_id || !c.default_payment_method_id) throw new Error("No saved card on file");

    const { data: invoice, error: iErr } = await supabaseAdmin
      .from("invoices")
      .select("id, organization_id, client_id, total_cents, currency, status, stripe_checkout_session_id, stripe_payment_intent_id")
      .eq("id", data.invoiceId).single();
    if (iErr) throw new Error(iErr.message);
    if (invoice.client_id !== c.id) throw new Error("Invoice not found");
    if (invoice.status === "paid") throw new Error("Already paid");
    if (invoice.status === "void") throw new Error("Voided");
    if (!invoice.total_cents || invoice.total_cents <= 0) throw new Error("Zero total");
    // Stale-open guard: if a prior session/intent already paid this invoice
    // (webhook missed), reconcile instead of charging the saved card too.
    if (invoice.stripe_checkout_session_id || invoice.stripe_payment_intent_id) {
      const { reconcileInvoicePayment } = await import("@/lib/invoice-reconcile.server");
      if ((await reconcileInvoicePayment(invoice.id)) === "marked_paid") {
        throw new Error("Already paid");
      }
    }

    const { stripe, stripeAccount } = await loadStripe(invoice.organization_id);
    // Saved-card refs can be orphaned by a connected-account cutover; verify
    // before charging so the client gets "re-add your card" instead of a raw
    // "No such customer: 'cus_…'".
    const { verifyClientStripeCustomer } = await import("@/lib/stripe-connect.server");
    const liveCustomerId = await verifyClientStripeCustomer(stripe, stripeAccount, c);
    if (!liveCustomerId) {
      throw new Error("Your saved card is no longer on file. Please add a payment method again.");
    }
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
      }, {
        // Prevent a double-tap (or a retried request) from charging twice.
        idempotencyKey: `portal-saved-card-${invoice.id}-${invoice.total_cents}`,
        stripeAccount,
      });
      await supabaseAdmin.from("invoices").update({
        stripe_payment_intent_id: pi.id, status: "open",
      }).eq("id", invoice.id);
      await supabaseAdmin.from("clients").update({
        autopay_last_attempt_at: new Date().toISOString(),
        autopay_last_error: null,
      }).eq("id", c.id);
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
    const { requirePortalSession } = await portalAuth();
    await requirePortalSession(data.token);
    const sb = await admin();
    const { data: rows, error } = await sb.rpc("portal_list_recent_visits", { _token: data.token });
    if (error) throw new Error(error.message);
    return (rows ?? []) as Array<{
      visit_id: string; scheduled_on: string; status: string; photo_paths: string[];
    }>;
  });

export const portalListDogs = createServerFn({ method: "GET" })
  .inputValidator((d) => tokenSchema.parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    await requirePortalSession(data.token);
    const sb = await admin();
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
    const { requirePortalSession } = await portalAuth();
    await requirePortalSession(data.token);
    const sb = await admin();
    const { data: id, error } = await sb.rpc("portal_report_concern", {
      _token: data.token,
      _visit_id: data.visitId as string,
      _category: data.category,
      _message: data.message,
    });
    if (error) throw new Error(error.message);

    // Notify the office by email (finding #14): a dashboard banner alone isn't
    // reliable for something that could be a safety/liability issue like a gate
    // left open. Best-effort — never block the client's submission.
    try {
      await notifyOfficeOfConcern(sb, data.token, data.category, data.message);
    } catch (e) {
      console.error("concern office notification failed", (e as Error).message);
    }
    // In-app notification to owners/managers (concern could be a safety issue).
    try {
      const { data: cl } = await sb
        .from("clients").select("display_name, organization_id").eq("portal_token", data.token).maybeSingle();
      if (cl?.organization_id) {
        const { notifyRoles } = await import("@/lib/notify-center.server");
        await notifyRoles(["owner", "office_manager"], {
          orgId: cl.organization_id,
          type: "concern",
          title: `New concern: ${CONCERN_LABELS[data.category] ?? "Concern"}`,
          body: `${cl.display_name ?? "A client"}${data.message ? `: ${data.message.slice(0, 120)}` : ""}`,
          link: "/concerns",
        });
      }
    } catch (e) {
      console.error("concern in-app notification failed", (e as Error).message);
    }
    return { ticketId: id as string };
  });

const CONCERN_LABELS: Record<string, string> = {
  missed_spot: "Missed spot",
  gate_left_open: "Gate left open",
  damage: "Property damage",
  wrong_yard: "Wrong yard",
  other: "Other",
};

async function notifyOfficeOfConcern(
  sb: any,
  token: string,
  category: string,
  message: string,
): Promise<void> {
  const resendApiKey = process.env.RESEND_API_KEY;
  if (!resendApiKey) return; // email not configured — banner + inbox still work
  const { data: client } = await sb
    .from("clients")
    .select("display_name, organization_id, organizations(name, contact_email)")
    .eq("portal_token", token)
    .maybeSingle();
  if (!client) return;
  const org: any = Array.isArray(client.organizations) ? client.organizations[0] : client.organizations;
  const to = org?.contact_email;
  if (!to) return; // no office inbox on file

  const label = CONCERN_LABELS[category] ?? category;
  const crypto = await import("node:crypto");
  const messageId = `concern-${crypto.randomBytes(8).toString("hex")}`;
  const html =
    `<p><strong>New client concern:</strong> ${label}</p>` +
    `<p>From: ${client.display_name}</p>` +
    (message ? `<p>${message.replace(/</g, "&lt;")}</p>` : "") +
    `<p><a href="https://www.app.houndstack.com/concerns">Open the Concerns inbox</a></p>`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": messageId,
    },
    body: JSON.stringify({
      from: `${org?.name ?? "HoundStack"} <noreply@notify.houndstack.com>`,
      to: [to],
      subject: `New client concern: ${label}`,
      html,
      text: `New client concern (${label}) from ${client.display_name}. ${message}`.trim(),
    }),
  });
  const status = res.ok ? "sent" : "failed";
  await sb.from("email_send_log").insert({
    message_id: messageId,
    template_name: "concern-notification",
    recipient_email: to,
    status,
    error_message: res.ok ? null : `Resend ${res.status}`,
  }).then(() => {}, () => {});
}

export const portalSignPhotoUrls = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z.object({ token: z.string().uuid(), paths: z.array(z.string()).max(60) }).parse(d),
  )
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token);
    if (data.paths.length === 0) return { urls: {} as Record<string, string> };
    const supabaseAdmin = await admin();
    // Only sign photos that belong to this client's own visits — never sign an
    // arbitrary caller-supplied storage path.
    const { data: ownRows, error: ownErr } = await supabaseAdmin.rpc("portal_list_recent_visits", { _token: data.token });
    if (ownErr) throw new Error(ownErr.message);
    const allowed = new Set<string>();
    for (const r of (ownRows ?? []) as Array<{ photo_paths: string[] }>) {
      for (const p of r.photo_paths ?? []) allowed.add(p);
    }
    const safePaths = data.paths.filter((p) => allowed.has(p));
    if (safePaths.length === 0) return { urls: {} as Record<string, string> };
    const { data: signed, error } = await supabaseAdmin.storage
      .from("visit-photos")
      .createSignedUrls(safePaths, 600);
    if (error) throw new Error(error.message);
    const urls: Record<string, string> = {};
    for (const s of signed ?? []) if (s.path && s.signedUrl) urls[s.path] = s.signedUrl;
    void session;
    return { urls };
  });

export const portalGetReferral = createServerFn({ method: "GET" })
  .inputValidator((d) => tokenSchema.parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    await requirePortalSession(data.token);
    const sb = await admin();
    const { data: rows, error } = await sb.rpc("portal_get_referral", { _token: data.token });
    if (error) throw new Error(error.message);
    return (rows?.[0] ?? { referral_code: null }) as { referral_code: string | null };
  });

// ── Portal: stations, requests, vacation hold, promo redemption ─────────────

export const portalListStations = createServerFn({ method: "GET" })
  .inputValidator((d) => tokenSchema.parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    await requirePortalSession(data.token);
    const sb = await admin();
    const { data: rows, error } = await sb.rpc("portal_list_stations" as any, { _token: data.token });
    if (error) throw new Error(error.message);
    return (rows ?? []) as Array<{
      station_id: string; label: string; location_description: string | null;
      liner_size: string | null; capacity_liners: number | null;
      last_serviced_on: string | null;
    }>;
  });

export const portalListMyRequests = createServerFn({ method: "GET" })
  .inputValidator((d) => tokenSchema.parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    await requirePortalSession(data.token);
    const sb = await admin();
    const { data: rows, error } = await sb.rpc("portal_list_my_requests" as any, { _token: data.token });
    if (error) throw new Error(error.message);
    return (rows ?? []) as Array<{
      ticket_id: string; visit_id: string | null; visit_date: string | null;
      category: string; message: string | null;
      status: string; resolution_note: string | null;
      resolved_at: string | null; created_at: string;
    }>;
  });

export const portalRequestVacationHold = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z.object({
      token: z.string().uuid(),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      reason: z.string().max(500).optional().default(""),
    }).parse(d),
  )
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    await requirePortalSession(data.token);
    const sb = await admin();
    const { data: n, error } = await sb.rpc("portal_request_vacation_hold" as any, {
      _token: data.token, _start: data.startDate, _end: data.endDate, _reason: data.reason,
    });
    if (error) throw new Error(error.message);
    return { skippedCount: (n as number) ?? 0 };
  });

export const portalRedeemPromo = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z.object({ token: z.string().uuid(), code: z.string().min(2).max(60) }).parse(d),
  )
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    await requirePortalSession(data.token);
    const sb = await admin();
    const { data: amt, error } = await sb.rpc("portal_redeem_promo" as any, {
      _token: data.token, _code: data.code,
    });
    if (error) throw new Error(error.message);
    return { creditCents: (amt as number) ?? 0 };
  });

// ── In-app Payment Element (inline card/ACH) ───────────────────────────────

export const portalCreateInvoicePaymentIntent = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z.object({
      token: z.string().uuid(),
      invoiceId: z.string().uuid(),
    }).parse(d),
  )
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token);
    // Connect direct charges: the client-side Payment Element initializes with
    // the platform publishable key scoped to the org's connected account.
    const publishableKey = process.env.STRIPE_CONNECT_PUBLISHABLE_KEY;
    if (!publishableKey) throw new Error("Payments not configured");

    const supabaseAdmin = await admin();
    const { data: invoice, error: iErr } = await supabaseAdmin
      .from("invoices")
      .select("id, organization_id, client_id, total_cents, currency, status, stripe_payment_intent_id")
      .eq("id", data.invoiceId)
      .single();
    if (iErr) throw new Error(iErr.message);
    if (invoice.client_id !== session.clientId) throw new Error("Invoice not found");
    if (invoice.status === "paid") throw new Error("Invoice already paid");
    if (invoice.status === "void") throw new Error("Invoice is voided");
    if (!invoice.total_cents || invoice.total_cents <= 0) throw new Error("Invoice total is zero");
    // If the stored intent (or an old checkout session) already succeeded but
    // the status is stale (webhook missed), reconcile instead of minting a new
    // intent and charging the client a second time.
    if (invoice.stripe_payment_intent_id) {
      const { reconcileInvoicePayment } = await import("@/lib/invoice-reconcile.server");
      if ((await reconcileInvoicePayment(invoice.id)) === "marked_paid") {
        throw new Error("Invoice already paid");
      }
    }

    const { data: cRow } = await supabaseAdmin
      .from("clients")
      .select("id, stripe_customer_id, primary_email, display_name")
      .eq("id", session.clientId)
      .single();
    if (!cRow) throw new Error("Client not found");

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
      source: "portal_inline",
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
          if (existing.amount !== invoice.total_cents || existing.currency !== currency) {
            pi = await stripe.paymentIntents.update(existing.id, {
              amount: invoice.total_cents,
              currency,
              metadata,
            }, opts);
          } else {
            pi = existing;
          }
        }
      } catch (e) {
        console.warn("retrieve existing PI failed, creating new", e);
      }
    }

    if (!pi) {
      pi = await stripe.paymentIntents.create({
        amount: invoice.total_cents,
        currency,
        customer: customerId,
        automatic_payment_methods: { enabled: true },
        setup_future_usage: "off_session",
        metadata,
      }, opts);
      await supabaseAdmin.from("invoices").update({
        stripe_payment_intent_id: pi.id,
        status: "open",
      }).eq("id", invoice.id);
    }

    const { data: client } = await supabaseAdmin
      .from("clients").select("display_name").eq("id", session.clientId).single();

    return {
      clientSecret: pi.client_secret as string,
      publishableKey,
      stripeAccount: acct.accountId,
      amountCents: invoice.total_cents,
      currency,
      invoiceId: invoice.id,
      businessName: client?.display_name as string,
    };
  });
