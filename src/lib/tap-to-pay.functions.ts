// Tap to Pay on the phone (#579): the server functions the native app calls.
//
// Three calls, in the order the phone makes them:
//
//   prepareTapToPay({ invoiceId })        -> location + account, before discovery
//   createTapToPayConnectionToken()       -> each time the SDK asks for a token
//   createTapToPayPaymentIntent({ ... })  -> the card_present intent to collect
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

/** Before the phone looks for its reader: the account and location to use.
 *  Creates the org's Terminal Location the first time. */
export const prepareTapToPay = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ invoiceId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await requirePermission(supabase, context.userId, "manage_client_billing");
    // Through the caller's own client, so RLS decides the invoice is theirs.
    const { data: invoice, error } = await supabase
      .from("invoices")
      .select("id, organization_id, status")
      .eq("id", data.invoiceId)
      .single();
    if (error) throw new Error(error.message);
    if (invoice.status !== "open") throw new Error("Only open invoices can be paid by tap.");

    const { requireOrgStripeAccount, connectStripe, connectSecret } =
      await import("@/lib/stripe-connect.server");
    const { ensureTerminalLocation } = await import("@/lib/tap-to-pay.server");
    const acct = await requireOrgStripeAccount(invoice.organization_id);
    const stripe = await connectStripe();
    const org = await orgForLocation(invoice.organization_id);
    const locationId = await ensureTerminalLocation(stripe, acct.accountId, org);
    return {
      locationId,
      stripeAccount: acct.accountId,
      merchantDisplayName: org.name,
      // Test-mode keys mean the SDK must use the simulated reader: a real tap
      // against a test account is refused by Stripe anyway, and saying so up
      // front is clearer than that refusal.
      isTest: connectSecret().startsWith("sk_test_") || connectSecret().startsWith("rk_test_"),
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
    const acct = await requireOrgStripeAccount(caller.orgId);
    const stripe = await connectStripe();
    const locationId = await ensureTerminalLocation(
      stripe,
      acct.accountId,
      await orgForLocation(caller.orgId),
    );
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
