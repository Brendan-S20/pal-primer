import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { liveServiceOrFilter, todayLocalISO } from "@/lib/subscription-form";
import { appUrl } from "@/lib/app-origin";
import { platformFeeCents } from "@/lib/platform-fee";

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
    if (!contact)
      return { verified: false as const, valid: false as const, channels: [], branding: null };

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
    if (!client)
      return { verified: false as const, valid: false as const, channels: [], branding: null };
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
    // What a portal skip actually costs, so the Skip button can stop guessing.
    //
    // `portal_request_skip` bills the visit at the org's `customer_requested`
    // percentage and ends with `IF _pct IS NULL THEN _pct := 0` — no row means
    // free, and skip-rules.functions.ts deliberately seeds that reason at 0 to
    // match. So on a default org the customer was warned about a charge that
    // could not be raised. This is read here rather than added to
    // portal_get_client because it needs no migration: the handler already
    // holds the org id from the row and runs as service_role.
    const { data: rule } = await sb
      .from("skip_billing_rules")
      .select("billable_pct")
      .eq("organization_id", row.organization_id)
      .eq("reason_code", "customer_requested")
      .maybeSingle();
    return { ...row, skip_billable_pct: rule?.billable_pct ?? 0 };
  });

export const portalListUpcomingVisits = createServerFn({ method: "GET" })
  .inputValidator((d) => tokenSchema.parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    await requirePortalSession(data.token);
    const sb = await admin();
    const { data: rows, error } = await sb.rpc("portal_list_upcoming_visits", {
      _token: data.token,
    });
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

    // G1: the portal must show the client's real debt — due dates, overdue
    // state, and open count/total. The RPC predates due_on; merge it from the
    // invoices table (scoped to this session's client) and compute the
    // summary with the same shared helper the staff surfaces use.
    const { isInvoiceOverdue, summarizeOpenInvoices } = await import("@/lib/overdue");
    const { invoiceOutstandingCents } = await import("@/lib/ar");
    const { data: dueRows, error: dueErr } = await sb
      .from("invoices")
      .select("id, due_on, credit_applied_cents")
      .eq("client_id", session.clientId);
    if (dueErr) throw new Error(dueErr.message);
    const dueById = new Map(
      (
        (dueRows ?? []) as Array<{
          id: string;
          due_on: string | null;
          credit_applied_cents: number | null;
        }>
      ).map((r) => [r.id, r]),
    );
    const invoices = (
      (rows ?? []) as Array<{
        invoice_id: string;
        status: string;
        kind: string;
        total_cents: number | null;
        issued_at: string | null;
        period_start: string | null;
        period_end: string | null;
      }>
    ).map((r) => {
      const extra = dueById.get(r.invoice_id);
      const due_on = extra?.due_on ?? null;
      const credit_applied_cents = extra?.credit_applied_cents ?? 0;
      return {
        ...r,
        due_on,
        credit_applied_cents,
        // What the client still owes on this invoice, net of applied credit (B7).
        amount_due_cents: invoiceOutstandingCents({
          status: r.status,
          total_cents: r.total_cents,
          credit_applied_cents,
        }),
        overdue: isInvoiceOverdue(r.status, due_on),
      };
    });
    const summary = summarizeOpenInvoices(invoices);
    return {
      invoices,
      openCount: summary.openCount,
      openTotalCents: summary.openTotalCents,
      overdueCount: summary.overdueCount,
      nextDueOn: summary.nextDueOn,
    };
  });

export const portalListPrepaidSubs = createServerFn({ method: "GET" })
  .inputValidator((d) => tokenSchema.parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    await requirePortalSession(data.token);
    const sb = await admin();
    const { data: rows, error } = await sb.rpc("portal_list_prepaid_subscriptions", {
      _token: data.token,
    });
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const portalRequestSkip = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        token: z.string().uuid(),
        visitId: z.string().uuid(),
        reason: z.string().max(500).optional().default(""),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    await requirePortalSession(data.token);
    const sb = await admin();
    const { error } = await sb.rpc("portal_request_skip", {
      _token: data.token,
      _visit_id: data.visitId,
      _reason: data.reason,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const portalStartPrepaidTopup = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        token: z.string().uuid(),
        subscriptionId: z.string().uuid(),
        visitCount: z.number().int().min(1).max(52),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    await requirePortalSession(data.token);
    const sb = await admin();
    const { data: id, error } = await sb.rpc("portal_start_prepaid_topup", {
      _token: data.token,
      _subscription_id: data.subscriptionId,
      _visit_count: data.visitCount,
    });
    if (error) throw new Error(error.message);
    return { invoiceId: id as string };
  });

const frequencyEnum = z.enum(["weekly", "biweekly", "twice_weekly", "monthly"]);
const addonFreqEnum = z.enum(["weekly", "biweekly", "monthly", "quarterly", "yearly"]);

export const portalRescheduleVisit = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        token: z.string().uuid(),
        visitId: z.string().uuid(),
        newDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    await requirePortalSession(data.token);
    const sb = await admin();
    const { error } = await sb.rpc("portal_reschedule_visit", {
      _token: data.token,
      _visit_id: data.visitId,
      _new_date: data.newDate,
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
        .select(
          "portal_allow_vacation_hold, portal_allow_frequency_change, portal_auto_apply_changes",
        )
        .eq("id", session.organizationId)
        .maybeSingle(),
      // "Your plan" has to be the client's STANDING plan.
      //
      // status='active' alone picked up services the tenant had ended (this
      // schema records ending in ends_on, not status) and — once one-off
      // bookings existed — a finished single call-out, because it is the
      // newest-started active row. The customer would then see "One time" as
      // their plan, and the subscriptionId handed to portalChangeFrequency was
      // that dead one-off: switching to biweekly rewrote a completed call-out
      // and left their real weekly service untouched, while the office got a
      // review ticket about a service that does not exist.
      sb
        .from("subscriptions")
        .select("id, frequency, status, ends_on")
        .eq("client_id", session.clientId)
        .eq("status", "active")
        .neq("frequency", "one_time")
        .or(liveServiceOrFilter(todayLocalISO()))
        .order("started_on", { ascending: false })
        .limit(1),
    ]);
    const sub = (subs ?? [])[0] ?? null;
    return {
      allowVacationHold: !!org?.portal_allow_vacation_hold,
      allowFrequencyChange: !!org?.portal_allow_frequency_change,
      // Drives the Account tab's request-vs-update affordance (the plan row
      // gets the same flag via the client payload).
      autoApply: !!(org as any)?.portal_auto_apply_changes,
      subscription: sub ? { id: sub.id as string, frequency: sub.frequency as string } : null,
    };
  });

export const portalChangeFrequency = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        token: z.string().uuid(),
        subscriptionId: z.string().uuid(),
        frequency: frequencyEnum,
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    await requirePortalSession(data.token);
    const sb = await admin();
    const { data: result, error } = await sb.rpc("portal_change_frequency", {
      _token: data.token,
      _subscription_id: data.subscriptionId,
      _new_frequency: data.frequency,
    });
    if (error) throw new Error(error.message);
    // 'applied' | 'requested' | 'unchanged' — 'requested' means auto-apply is
    // off and the office got a structured review ticket instead (C4/G4).
    return { ok: true, status: result ?? "applied" };
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
    z
      .object({
        token: z.string().uuid(),
        addonServiceId: z.string().uuid(),
        frequency: addonFreqEnum.nullable().optional(),
        quantity: z.number().int().min(1).max(50).default(1),
        propertyId: z.string().uuid().nullable().optional(),
      })
      .parse(d),
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
    // In-app notification to the office (same pattern as portalReportConcern):
    // a client asked for — and may now be billed for — a new service, which
    // otherwise sat unseen until someone happened to open the client page.
    // Best-effort; never block the client's request.
    try {
      const [{ data: cl }, { data: addon }] = await Promise.all([
        sb
          .from("clients")
          .select("id, display_name, organization_id")
          .eq("portal_token", data.token)
          .maybeSingle(),
        sb.from("addon_services").select("name").eq("id", data.addonServiceId).maybeSingle(),
      ]);
      if (cl?.organization_id) {
        const { notifyRoles } = await import("@/lib/notify-center.server");
        await notifyRoles(["owner", "office_manager"], {
          orgId: cl.organization_id,
          type: "addon_request",
          title: `Add-on requested: ${(addon as any)?.name ?? "a service"}`,
          body: `${cl.display_name ?? "A client"} requested ${(addon as any)?.name ?? "an add-on"}${data.quantity > 1 ? ` ×${data.quantity}` : ""} from the portal`,
          link: `/clients/${cl.id}?tab=services`,
        });
      }
    } catch (e) {
      console.error("addon request in-app notification failed", (e as Error).message);
    }
    return { id: id as string };
  });

export const portalCancelAddon = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        token: z.string().uuid(),
        addonSubscriptionId: z.string().uuid(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    await requirePortalSession(data.token);
    const sb = await admin();
    const { error } = await sb.rpc("portal_cancel_addon", {
      _token: data.token,
      _addon_subscription_id: data.addonSubscriptionId,
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

    const {
      requireOrgStripeAccount,
      connectStripe,
      connectPublishableKey,
      verifyClientStripeCustomer,
    } = await import("@/lib/stripe-connect.server");
    const acct = await requireOrgStripeAccount(session.organizationId);
    const stripe = await connectStripe();
    const opts = { stripeAccount: acct.accountId };

    let customerId = await verifyClientStripeCustomer(stripe, acct.accountId, cRow);
    if (!customerId) {
      const cust = await stripe.customers.create(
        {
          email: cRow.primary_email ?? undefined,
          name: cRow.display_name ?? undefined,
          metadata: { client_id: cRow.id, organization_id: session.organizationId },
        },
        opts,
      );
      customerId = cust.id;
      await supabaseAdmin
        .from("clients")
        .update({ stripe_customer_id: customerId })
        .eq("id", cRow.id);
    }

    const si = await stripe.setupIntents.create(
      {
        customer: customerId,
        payment_method_types: ["card"],
        usage: "off_session",
        metadata: {
          client_id: cRow.id,
          organization_id: session.organizationId,
          source: "portal_setup_inline",
        },
      },
      opts,
    );
    return {
      clientSecret: si.client_secret as string,
      publishableKey: connectPublishableKey(),
      stripeAccount: acct.accountId,
    };
  });

/** Finalize an inline card save: mark the confirmed payment method as the
 *  client's default and record the card details. */
export const portalFinalizeCardSetup = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z.object({ token: z.string().uuid(), setupIntentId: z.string().min(3) }).parse(d),
  )
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
    if (si.metadata?.client_id !== session.clientId)
      throw new Error("Card setup could not be verified.");

    const pm = await stripe.paymentMethods.retrieve(pmId, {}, opts);
    await stripe.customers.update(
      customerId,
      { invoice_settings: { default_payment_method: pmId } },
      opts,
    );
    await supabaseAdmin
      .from("clients")
      .update({
        stripe_customer_id: customerId,
        default_payment_method_id: pmId,
        default_card_brand: pm.card?.brand ?? null,
        default_card_last4: pm.card?.last4 ?? null,
        // `autopay_enabled: true` was here, unconditionally, in the handler for a
        // button labelled "Save card".
        //
        // The portal offers autopay as a SEPARATE choice with its own button
        // ("Turn on autopay" / "Turn off autopay", portalSetAutopay) directly
        // above, under copy reading "Save a card for one-tap payments, OR enable
        // autopay". So a customer who had deliberately turned autopay off after a
        // surprise charge, and later replaced an expired card, had it switched
        // back on for them — and had no way to notice, because the toast says
        // "Card saved". The next nightly run charged them off-session.
        //
        // Staff had no remedy either: the client Billing tab only DISPLAYS the
        // flag, and the one staff mutation for it (resumeAutopay) turns it on.
        //
        // Omitted rather than set to false, so replacing a card leaves the
        // customer's own choice exactly as they left it, either way.
      })
      .eq("id", session.clientId);
    return { ok: true, brand: pm.card?.brand ?? null, last4: pm.card?.last4 ?? null };
  });

/** Toggle autopay preference. Requires a saved card to enable. */
export const portalSetAutopay = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ token: z.string().uuid(), enabled: z.boolean() }).parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    await requirePortalSession(data.token);
    const sb = await admin();
    const { error } = await sb.rpc("portal_set_autopay", {
      _token: data.token,
      _enabled: data.enabled,
    });
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
      .from("clients")
      .select("id, default_payment_method_id")
      .eq("id", session.clientId)
      .single();
    if (cRow?.default_payment_method_id) {
      try {
        const { stripe, stripeAccount } = await loadStripe(session.organizationId);
        await stripe.paymentMethods.detach(cRow.default_payment_method_id, {}, { stripeAccount });
      } catch (e) {
        console.warn("detach pm failed", e);
      }
    }
    await supabaseAdmin
      .from("clients")
      .update({
        default_payment_method_id: null,
        default_card_brand: null,
        default_card_last4: null,
        autopay_enabled: false,
      })
      .eq("id", session.clientId);
    return { ok: true };
  });

/** Charge an open invoice off-session using the saved default card. */
export const portalPayInvoiceWithSavedCard = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z.object({ token: z.string().uuid(), invoiceId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token);
    const supabaseAdmin = await admin();
    const { data: c } = await supabaseAdmin
      .from("clients")
      .select("id, stripe_customer_id, default_payment_method_id")
      .eq("id", session.clientId)
      .single();
    if (!c?.stripe_customer_id || !c.default_payment_method_id)
      throw new Error("No saved card on file");

    const { data: invoice, error: iErr } = await supabaseAdmin
      .from("invoices")
      .select(
        "id, organization_id, client_id, total_cents, credit_applied_cents, currency, status, stripe_checkout_session_id, stripe_payment_intent_id",
      )
      .eq("id", data.invoiceId)
      .single();
    if (iErr) throw new Error(iErr.message);
    if (invoice.client_id !== c.id) throw new Error("Invoice not found");
    if (invoice.status === "paid") throw new Error("Already paid");
    if (invoice.status === "void") throw new Error("Voided");
    // Charge what's still owed, net of applied credit (B7) — never the gross total.
    const { invoiceOutstandingCents } = await import("@/lib/ar");
    const dueCents = invoiceOutstandingCents(invoice);
    if (dueCents <= 0) throw new Error("Nothing due on this invoice");
    // Stale-open guard: if a prior session/intent already paid this invoice
    // (webhook missed), reconcile instead of charging the saved card too.
    if (invoice.stripe_checkout_session_id || invoice.stripe_payment_intent_id) {
      const { reconcileInvoicePayment } = await import("@/lib/invoice-reconcile.server");
      if ((await reconcileInvoicePayment(invoice.id)) === "marked_paid") {
        throw new Error("Already paid");
      }
    }

    const { stripe, stripeAccount } = await loadStripe(invoice.organization_id);
    // In-flight bank debit guard (same rule as the staff charge path): a
    // stored PI in "processing" means the invoice IS being paid — charging
    // the saved card on top would collect twice when the debit clears. A
    // still-confirmable stale intent (e.g. an abandoned Payment Element at
    // the old amount) is canceled so it can't be confirmed after this charge.
    if (invoice.stripe_payment_intent_id) {
      try {
        const existing = await stripe.paymentIntents.retrieve(
          invoice.stripe_payment_intent_id,
          {},
          { stripeAccount },
        );
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
          await stripe.paymentIntents.cancel(existing.id, {}, { stripeAccount });
        }
      } catch (e) {
        if ((e as Error).message?.startsWith("A payment for this invoice is already processing"))
          throw e;
        // Retrieve/cancel hiccups don't block the charge; the reconcile above ran.
      }
    }
    // Saved-card refs can be orphaned by a connected-account cutover; verify
    // before charging so the client gets "re-add your card" instead of a raw
    // "No such customer: 'cus_…'".
    const { verifyClientStripeCustomer } = await import("@/lib/stripe-connect.server");
    const liveCustomerId = await verifyClientStripeCustomer(stripe, stripeAccount, c);
    if (!liveCustomerId) {
      throw new Error("Your saved card is no longer on file. Please add a payment method again.");
    }
    // Saved card: the payment method is known before the charge is built, so
    // the rail and funding type are too and no second step is needed. The
    // platform fee stays on the BASE — we do not take 50 bps of a fee the
    // tenant is recovering from Stripe.
    const { orgFeeConfig, quoteForPaymentMethodId, surchargeMetadata } =
      await import("@/lib/processing-fee.server");
    const quote = await quoteForPaymentMethodId(stripe, {
      paymentMethodId: c.default_payment_method_id,
      stripeAccount,
      baseCents: dueCents,
      config: await orgFeeConfig(supabaseAdmin, invoice.organization_id),
    });
    try {
      const pi = await stripe.paymentIntents.create(
        {
          amount: quote.totalCents,
          application_fee_amount: platformFeeCents(dueCents),
          currency: invoice.currency ?? "usd",
          customer: c.stripe_customer_id,
          payment_method: c.default_payment_method_id,
          off_session: true,
          confirm: true,
          metadata: {
            invoice_id: invoice.id,
            organization_id: invoice.organization_id,
            source: "portal_saved_card",
            ...surchargeMetadata(quote),
          },
        },
        {
          // Prevent a double-tap (or a retried request) from charging twice.
          // The amount is in the key so a changed balance (credit applied)
          // mints fresh; the payment-method id is in the key because after a
          // decline the client may save a NEW card the same day, and replaying
          // the old key with different params would be an idempotency_error.
          // It is the CHARGED total, not the invoice base: a tenant who switches
          // pass-through on between two attempts changes the amount, and reusing
          // the key would be exactly that idempotency_error.
          idempotencyKey: `portal-saved-card-${invoice.id}-${quote.totalCents}-${c.default_payment_method_id}`,
          stripeAccount,
        },
      );
      await supabaseAdmin
        .from("invoices")
        .update({
          stripe_payment_intent_id: pi.id,
          status: "open",
        })
        .eq("id", invoice.id);
      await supabaseAdmin
        .from("clients")
        .update({
          autopay_last_attempt_at: new Date().toISOString(),
          autopay_last_error: null,
        })
        .eq("id", c.id);
      return { ok: true, status: pi.status };
    } catch (e) {
      const msg = (e as Error).message || "Card charge failed";
      await supabaseAdmin
        .from("clients")
        .update({
          autopay_last_attempt_at: new Date().toISOString(),
          autopay_last_error: msg,
        })
        .eq("id", c.id);
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
      visit_id: string;
      scheduled_on: string;
      status: string;
      photo_paths: string[];
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
      dog_id: string;
      name: string;
      breed: string | null;
      weight_class: string | null;
      temperament: string | null;
      notes: string | null;
    }>;
  });

export const portalReportConcern = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        token: z.string().uuid(),
        visitId: z.string().uuid().nullable(),
        category: z.enum(["missed_spot", "gate_left_open", "damage", "wrong_yard", "other"]),
        message: z.string().max(1000).optional().default(""),
      })
      .parse(d),
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
        .from("clients")
        .select("display_name, organization_id")
        .eq("portal_token", data.token)
        .maybeSingle();
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
  const org: any = Array.isArray(client.organizations)
    ? client.organizations[0]
    : client.organizations;
  const to = org?.contact_email;
  if (!to) return; // no office inbox on file

  const label = CONCERN_LABELS[category] ?? category;
  const crypto = await import("node:crypto");
  const messageId = `concern-${crypto.randomBytes(8).toString("hex")}`;
  const html =
    `<p><strong>New client concern:</strong> ${label}</p>` +
    `<p>From: ${client.display_name}</p>` +
    (message ? `<p>${message.replace(/</g, "&lt;")}</p>` : "") +
    `<p><a href="${appUrl("/concerns")}">Open the Concerns inbox</a></p>`;
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
  await sb
    .from("email_send_log")
    .insert({
      message_id: messageId,
      template_name: "concern-notification",
      recipient_email: to,
      status,
      error_message: res.ok ? null : `Resend ${res.status}`,
    })
    .then(
      () => {},
      () => {},
    );
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
    const { data: ownRows, error: ownErr } = await supabaseAdmin.rpc("portal_list_recent_visits", {
      _token: data.token,
    });
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
    const { data: rows, error } = await sb.rpc("portal_list_stations" as any, {
      _token: data.token,
    });
    if (error) throw new Error(error.message);
    return (rows ?? []) as Array<{
      station_id: string;
      station_number: number | null;
      label: string | null;
      location_description: string | null;
      liner_size: string | null;
      last_serviced_on: string | null;
    }>;
  });

export const portalListMyRequests = createServerFn({ method: "GET" })
  .inputValidator((d) => tokenSchema.parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    await requirePortalSession(data.token);
    const sb = await admin();
    const { data: rows, error } = await sb.rpc("portal_list_my_requests" as any, {
      _token: data.token,
    });
    if (error) throw new Error(error.message);
    return (rows ?? []) as Array<{
      ticket_id: string;
      visit_id: string | null;
      visit_date: string | null;
      category: string;
      message: string | null;
      status: string;
      resolution_note: string | null;
      resolved_at: string | null;
      created_at: string;
    }>;
  });

export const portalRequestVacationHold = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        token: z.string().uuid(),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        reason: z.string().max(500).optional().default(""),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    await requirePortalSession(data.token);
    const sb = await admin();
    const { data: n, error } = await sb.rpc("portal_request_vacation_hold" as any, {
      _token: data.token,
      _start: data.startDate,
      _end: data.endDate,
      _reason: data.reason,
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
      _token: data.token,
      _code: data.code,
    });
    if (error) throw new Error(error.message);
    return { creditCents: (amt as number) ?? 0 };
  });

// ── In-app Payment Element (inline card/ACH) ───────────────────────────────

// Explicit payment method types keep the Payment Element to card + ACH — no
// Klarna/Affirm/Cash App clutter from automatic payment methods.
const INVOICE_PM_TYPES = ["card", "us_bank_account"];

// ACH requires activation on the connected account; when it isn't enabled the
// PI create/update fails and we retry card-only.
function isBankDebitUnavailableError(e: unknown): boolean {
  const err = e as { message?: string; param?: string };
  return (
    /us_bank_account/i.test(err?.message ?? "") || /payment_method_types/.test(err?.param ?? "")
  );
}

export const portalCreateInvoicePaymentIntent = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        token: z.string().uuid(),
        invoiceId: z.string().uuid(),
      })
      .parse(d),
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
      .select(
        "id, organization_id, client_id, total_cents, credit_applied_cents, currency, status, stripe_payment_intent_id, stripe_checkout_session_id",
      )
      .eq("id", data.invoiceId)
      .single();
    if (iErr) throw new Error(iErr.message);
    if (invoice.client_id !== session.clientId) throw new Error("Invoice not found");
    if (invoice.status === "paid") throw new Error("Invoice already paid");
    if (invoice.status === "void") throw new Error("Invoice is voided");
    // Charge what's still owed, net of applied credit (B7) — never the gross total.
    const { invoiceOutstandingCents } = await import("@/lib/ar");
    const dueCents = invoiceOutstandingCents(invoice);
    if (dueCents <= 0) throw new Error("Nothing due on this invoice");
    // If the stored intent OR a legacy hosted-checkout session already
    // succeeded but the status is stale (webhook missed), reconcile instead
    // of minting a new intent and charging the client a second time.
    if (invoice.stripe_payment_intent_id || invoice.stripe_checkout_session_id) {
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

    const { requireOrgStripeAccount, connectStripe, verifyClientStripeCustomer } =
      await import("@/lib/stripe-connect.server");
    const acct = await requireOrgStripeAccount(invoice.organization_id);
    const stripe = await connectStripe();
    const opts = { stripeAccount: acct.accountId };

    let customerId = await verifyClientStripeCustomer(stripe, acct.accountId, cRow);
    if (!customerId) {
      const cust = await stripe.customers.create(
        {
          email: cRow.primary_email ?? undefined,
          name: cRow.display_name ?? undefined,
          metadata: { client_id: cRow.id, organization_id: invoice.organization_id },
        },
        opts,
      );
      customerId = cust.id;
      await supabaseAdmin
        .from("clients")
        .update({ stripe_customer_id: customerId })
        .eq("id", cRow.id);
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
        const existing = await stripe.paymentIntents.retrieve(
          invoice.stripe_payment_intent_id,
          {},
          opts,
        );
        // An in-flight bank debit means the invoice IS being paid; minting a
        // replacement intent here would lose the reference and invite a
        // second charge while the debit clears.
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
          // intents stop offering Klarna/Affirm/etc., and (re)sets
          // setup_future_usage — a staff-minted intent doesn't save the card,
          // but the client paying it themselves consents to saving theirs.
          const updateParams = {
            amount: dueCents,
            // application_fee_amount travels WITH the amount. It was set once at
            // create time from the then-current due amount and never updated,
            // so applying client credit shrank the charge and left the fee
            // where it was: $150 of credit on a $200 invoice charged $50 with
            // a $1.00 fee — 2%, not 0.5% — out of the tenant's settlement. At
            // $1.00 due the fee equalled the whole charge.
            application_fee_amount: platformFeeCents(dueCents),
            currency,
            metadata,
            setup_future_usage: "off_session" as const,
          };
          try {
            pi = await stripe.paymentIntents.update(
              existing.id,
              {
                ...updateParams,
                payment_method_types: INVOICE_PM_TYPES,
              },
              opts,
            );
          } catch (e) {
            if (!isBankDebitUnavailableError(e)) throw e;
            pi = await stripe.paymentIntents.update(
              existing.id,
              {
                ...updateParams,
                payment_method_types: ["card"],
              },
              opts,
            );
          }
        }
      } catch (e) {
        // The processing guard is a real answer for the caller, not a
        // retrieve hiccup — let it surface instead of minting a new intent.
        if ((e as Error).message?.startsWith("A payment for this invoice is already processing"))
          throw e;
        console.warn("retrieve existing PI failed, creating new", e);
      }
    }

    if (!pi) {
      const createParams = {
        amount: dueCents,
        application_fee_amount: platformFeeCents(dueCents),
        currency,
        customer: customerId,
        setup_future_usage: "off_session" as const,
        metadata,
      };
      try {
        pi = await stripe.paymentIntents.create(
          {
            ...createParams,
            payment_method_types: INVOICE_PM_TYPES,
          },
          opts,
        );
      } catch (e) {
        if (!isBankDebitUnavailableError(e)) throw e;
        pi = await stripe.paymentIntents.create(
          {
            ...createParams,
            payment_method_types: ["card"],
          },
          opts,
        );
      }
      await supabaseAdmin
        .from("invoices")
        .update({
          stripe_payment_intent_id: pi.id,
          status: "open",
        })
        .eq("id", invoice.id);
    }

    const { data: client } = await supabaseAdmin
      .from("clients")
      .select("display_name")
      .eq("id", session.clientId)
      .single();

    return {
      clientSecret: pi.client_secret as string,
      publishableKey,
      stripeAccount: acct.accountId,
      amountCents: dueCents,
      currency,
      invoiceId: invoice.id,
      businessName: client?.display_name as string,
    };
  });

// ── The client opting themselves in ───────────────────────────────────────
//
// The strongest evidence a carrier can be shown: the end user, authenticated
// on their own portal session, ticking a box whose exact words are stored with
// the timestamp. Source is 'portal' so an audit can tell this apart from a
// staff member recording consent on someone's behalf.

export const portalSetSmsConsent = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ token: z.string().uuid(), optIn: z.boolean() }).parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token);
    const sb = await admin();

    const clientId = (session as any).clientId ?? (session as any).client_id;
    if (!clientId) throw new Error("No client on this portal session");

    if (!data.optIn) {
      // Opting out is not "clear the consent record" — the record of what they
      // once agreed to is the audit trail, and deleting it on withdrawal would
      // destroy the evidence for every message already sent. sms_opt_out is
      // the live switch; the consent columns stay as history.
      const { error } = await (sb.from("clients") as any)
        .update({ sms_opt_out: true })
        .eq("id", clientId);
      if (error) throw new Error(error.message);
      return { ok: true, optedIn: false };
    }

    const { SMS_CONSENT_TEXT } = await import("@/lib/clients.functions");
    const { error } = await sb.rpc("record_client_sms_consent" as any, {
      _client_id: clientId,
      _text: SMS_CONSENT_TEXT,
      _source: "portal",
    });
    if (error) throw new Error(error.message);
    return { ok: true, optedIn: true, text: SMS_CONSENT_TEXT };
  });
