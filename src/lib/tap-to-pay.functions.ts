// Tap to Pay on the phone (#579): the server functions the native app calls.
//
// Three calls, in the order the phone makes them:
//
//   prepareTapToPay({ invoiceId })        -> location + account, before discovery
//   createTapToPayConnectionToken()       -> each time the SDK asks for a token
//   createTapToPayPaymentIntent({ ... })  -> the card_present intent to collect
//
// And three around them, for Apple's review guide:
//
//   getTapToPayStatus()                   -> may this person tap, may they accept
//                                            Apple's terms, is it on for the business
//   prepareTapToPay({})                   -> no invoice: Enable from Settings, and
//                                            the warm-up at launch and on foreground
//   reportTapToPayInterrupted({ ... })    -> the app closed mid-tap; push the
//                                            merchant if it was not approved (5.12)
//
// Each requires `manage_client_billing`, the permission Take payment already
// requires (createInvoicePaymentIntent), so a role that cannot take a payment
// on the web cannot take one by tapping either. The Stripe logic lives in
// tap-to-pay.server.ts so it can be tested without a request.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import { invoiceDueCents } from "@/lib/ar";

type LocationOrg = {
  id: string;
  name: string;
  contact_address: string | null;
  country: string | null;
};

async function orgForLocation(orgId: string): Promise<LocationOrg> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { isMissingCountryColumn } = await import("@/lib/org-country-column");
  const read = (cols: string) =>
    supabaseAdmin.from("organizations").select(cols).eq("id", orgId).single();
  let { data, error } = await read("id, name, contact_address, country");
  // organizations.country may not exist yet on a database the app deployed
  // ahead of (#496); without it the location defaults to US.
  if (error && isMissingCountryColumn(error)) {
    ({ data, error } = await read("id, name, contact_address"));
  }
  if (error || !data) throw new Error("Couldn't load the business for Tap to Pay.");
  const row = data as unknown as Partial<LocationOrg>;
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    contact_address: row.contact_address ?? null,
    country: row.country ?? null,
  };
}

/** Which reader this business gets (see tapToPayReaderMode). */
async function readerModeFor(org: { id: string }) {
  const { connectSecret } = await import("@/lib/stripe-connect.server");
  const { tapToPayReaderMode, parseOrgIds, isTestSecret, TAP_TO_PAY_NEVER_LIVE_ORG_IDS_ENV } =
    await import("@/lib/tap-to-pay.server");
  return tapToPayReaderMode({
    testKeys: isTestSecret(connectSecret()),
    org,
    neverLiveOrgIds: parseOrgIds(process.env[TAP_TO_PAY_NEVER_LIVE_ORG_IDS_ENV]),
  });
}

async function refuseWhenOff(org: { id: string }) {
  const mode = await readerModeFor(org);
  if (mode === "off") {
    const { TAP_TO_PAY_NOT_AVAILABLE } = await import("@/lib/tap-to-pay.server");
    throw new Error(TAP_TO_PAY_NOT_AVAILABLE);
  }
  return mode;
}

/** What the app needs before it draws any Tap to Pay screen. Never throws for
 *  a role or a business that cannot tap: it says so, so the screen can tell
 *  the person who to ask (Apple 3.8.1) instead of hiding. */
export const getTapToPayStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { resolveCaller } = await import("@/lib/authz.server");
    const { hasPermission } = await import("@/lib/permissions");
    const caller = await resolveCaller(context.supabase, context.userId);
    const canTap = hasPermission(caller.role, "manage_client_billing", caller.overrides);
    const canAcceptTerms = hasPermission(caller.role, "manage_org_billing", caller.overrides);
    let available = false;
    let readerMode: "simulated" | "live" | "off" = "off";
    try {
      const { requireOrgStripeAccount } = await import("@/lib/stripe-connect.server");
      const acct = await requireOrgStripeAccount(caller.orgId);
      const org = await orgForLocation(caller.orgId);
      readerMode = await readerModeFor(org);
      available = !!acct.chargesEnabled && readerMode !== "off";
    } catch {
      available = false; // no connected account yet, or not charge-ready
    }
    return { available, readerMode, canTap, canAcceptTerms };
  });

/** Before the phone looks for its reader: the account and location to use.
 *  Creates the org's Terminal Location the first time. */
export const prepareTapToPay = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ invoiceId: z.string().uuid().optional() }).parse(d ?? {}))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const caller = await requirePermission(supabase, context.userId, "manage_client_billing");
    let orgId = caller.orgId;
    if (data.invoiceId) {
      // Through the caller's own client, so RLS decides the invoice is theirs.
      const { data: invoice, error } = await supabase
        .from("invoices")
        .select("id, organization_id, status")
        .eq("id", data.invoiceId)
        .single();
      if (error) throw new Error(error.message);
      if (invoice.status !== "open") throw new Error("Only open invoices can be paid by tap.");
      orgId = invoice.organization_id;
    }

    const { requireOrgStripeAccount, connectStripe } = await import("@/lib/stripe-connect.server");
    const { ensureTerminalLocation } = await import("@/lib/tap-to-pay.server");
    const org = await orgForLocation(orgId);
    const readerMode = await refuseWhenOff(org);
    const acct = await requireOrgStripeAccount(orgId);
    const stripe = await connectStripe();
    const locationId = await ensureTerminalLocation(stripe, acct.accountId, org);
    return {
      locationId,
      stripeAccount: acct.accountId,
      merchantDisplayName: org.name,
      readerMode,
      // What the SDK is initialised with. Test keys mean the simulated reader
      // (a real tap against a test account is refused by Stripe anyway).
      // Live keys reach here only for the production demo org (never one on
      // TAP_TO_PAY_NEVER_LIVE_ORG_IDS), which gets the real phone reader: what shows Apple's screens.
      isTest: readerMode === "simulated",
    };
  });

/** A one-use connection token for the Terminal SDK on the business's account. */
export const createTapToPayConnectionToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const caller = await requirePermission(
      context.supabase,
      context.userId,
      "manage_client_billing",
    );
    const { requireOrgStripeAccount, connectStripe } = await import("@/lib/stripe-connect.server");
    const { ensureTerminalLocation, createConnectionToken } =
      await import("@/lib/tap-to-pay.server");
    const org = await orgForLocation(caller.orgId);
    await refuseWhenOff(org);
    const acct = await requireOrgStripeAccount(caller.orgId);
    const stripe = await connectStripe();
    const locationId = await ensureTerminalLocation(stripe, acct.accountId, org);
    return { secret: await createConnectionToken(stripe, acct.accountId, locationId) };
  });

/** The card_present PaymentIntent for the invoice's open amount. */
export const createTapToPayPaymentIntent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ invoiceId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await requirePermission(supabase, context.userId, "manage_client_billing");
    const { data: invoice, error } = await supabase
      .from("invoices")
      .select(
        "id, organization_id, client_id, total_cents, tax_cents, credit_applied_cents, amount_paid_cents, currency, status, stripe_checkout_session_id, stripe_payment_intent_id",
      )
      .eq("id", data.invoiceId)
      .single();
    if (error) throw new Error(error.message);
    if (invoice.status === "paid") throw new Error("Invoice already paid");
    if (invoice.status === "void") throw new Error("Invoice is voided");
    if (invoice.status !== "open") throw new Error("Only open invoices can be paid by tap.");
    const dueCents = invoiceDueCents(invoice);
    if (dueCents <= 0) throw new Error("Nothing due on this invoice");
    // A missed webhook must not become a second charge.
    if (invoice.stripe_checkout_session_id || invoice.stripe_payment_intent_id) {
      const { reconcileInvoicePayment } = await import("@/lib/invoice-reconcile.server");
      if ((await reconcileInvoicePayment(invoice.id)) === "marked_paid") {
        throw new Error("Invoice already paid");
      }
    }

    const { requireOrgStripeAccount, connectStripe, verifyClientStripeCustomer } =
      await import("@/lib/stripe-connect.server");
    const { createCardPresentIntent } = await import("@/lib/tap-to-pay.server");
    await refuseWhenOff(await orgForLocation(invoice.organization_id));
    const acct = await requireOrgStripeAccount(invoice.organization_id);
    const stripe = await connectStripe();

    // Attach the client's Stripe customer when there already is one, so the
    // charge sits under them on the Payments page. Never create one here and
    // never save the card: a tap is a one-off, by the client's own hand.
    const { data: cRow } = await supabase
      .from("clients")
      .select("id, stripe_customer_id")
      .eq("id", invoice.client_id)
      .maybeSingle();
    const customerId = cRow ? await verifyClientStripeCustomer(stripe, acct.accountId, cRow) : null;

    const pi = await createCardPresentIntent(stripe, acct.accountId, invoice, dueCents, customerId);
    const { error: upErr } = await supabase
      .from("invoices")
      .update({ stripe_payment_intent_id: pi.id, status: "open" })
      .eq("id", invoice.id);
    if (upErr) throw new Error(upErr.message);
    return {
      clientSecret: pi.client_secret as string,
      amountCents: dueCents,
      currency: pi.currency,
    };
  });

/**
 * The app went to the background (or was closed) while a tap was waiting for
 * a card or being approved (Apple 5.12). If the invoice's intent did not
 * succeed, the person who started the tap gets a push saying so. Also asked,
 * with `push: false`, on the next launch, to tell the person in the app.
 */
export const reportTapToPayInterrupted = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        invoiceId: z.string().uuid(),
        amountLabel: z.string().max(32),
        push: z.boolean().default(true),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await requirePermission(supabase, context.userId, "manage_client_billing");
    const { data: invoice, error } = await supabase
      .from("invoices")
      .select("id, organization_id, status, stripe_payment_intent_id")
      .eq("id", data.invoiceId)
      .single();
    if (error) throw new Error(error.message);
    if (invoice.status === "paid") return { approved: true, notified: false };
    let status: string | null = null;
    if (invoice.stripe_payment_intent_id) {
      try {
        const { requireOrgStripeAccount, connectStripe } =
          await import("@/lib/stripe-connect.server");
        const acct = await requireOrgStripeAccount(invoice.organization_id);
        const stripe = await connectStripe();
        const pi = await stripe.paymentIntents.retrieve(
          invoice.stripe_payment_intent_id,
          {},
          { stripeAccount: acct.accountId },
        );
        status = pi.status;
      } catch {
        status = null; // unknown: say nothing rather than a wrong "not approved"
      }
    }
    const { tapToPayInterruptedOutcome, tapToPayNotApprovedPush } =
      await import("@/lib/tap-to-pay");
    const outcome = tapToPayInterruptedOutcome(status);
    if (outcome !== "not_approved") return { approved: outcome === "approved", notified: false };
    if (!data.push) return { approved: false, notified: false };
    const { sendPushToUser } = await import("@/lib/push.server");
    const push = tapToPayNotApprovedPush(data.amountLabel);
    await sendPushToUser(context.userId, {
      ...push,
      url: `/invoices/${invoice.id}`,
      tag: `tap-to-pay:${invoice.id}`,
    });
    return { approved: false, notified: true };
  });
