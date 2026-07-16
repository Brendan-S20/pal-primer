// Staff-side payment-method management (client detail refactor, Billing
// tab): clients may keep multiple cards in Stripe; HoundStack stores only
// the customer id and a copy of the default card's brand/last4. All card
// data stays in Stripe on the org's connected account.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import { logActivity } from "@/lib/activity.server";

async function loadClientForBilling(supabase: any, userId: string, clientId: string) {
  await requirePermission(supabase, userId, "manage_client_billing");
  const { data: client, error } = await supabase
    .from("clients")
    .select(
      "id, organization_id, display_name, primary_email, stripe_customer_id, default_payment_method_id, autopay_enabled",
    )
    .eq("id", clientId)
    .single();
  if (error) throw new Error(error.message);
  return client;
}

async function stripeFor(orgId: string) {
  const { requireOrgStripeAccount, connectStripe } = await import("@/lib/stripe-connect.server");
  const acct = await requireOrgStripeAccount(orgId);
  const stripe = await connectStripe();
  return { stripe, opts: { stripeAccount: acct.accountId } };
}

export interface PaymentMethodSummary {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  isDefault: boolean;
}

export const listClientPaymentMethods = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const client = await loadClientForBilling(context.supabase, context.userId, data.clientId);
    if (!client.stripe_customer_id) return { methods: [] as PaymentMethodSummary[], hasCustomer: false };

    const { stripe, opts } = await stripeFor(client.organization_id);
    let customer: any;
    try {
      customer = await stripe.customers.retrieve(client.stripe_customer_id, {}, opts);
    } catch (e) {
      // Deleted/missing customer means "no cards"; anything else (network,
      // auth, rate limit) must surface as an error, not an empty list.
      const { isStripeMissingResource } = await import("@/lib/stripe-connect.server");
      if (isStripeMissingResource(e)) return { methods: [] as PaymentMethodSummary[], hasCustomer: false };
      throw e;
    }
    if (customer.deleted) return { methods: [] as PaymentMethodSummary[], hasCustomer: false };

    const defaultId =
      (typeof customer.invoice_settings?.default_payment_method === "string"
        ? customer.invoice_settings.default_payment_method
        : customer.invoice_settings?.default_payment_method?.id) ??
      client.default_payment_method_id ??
      null;

    const pms = await stripe.customers.listPaymentMethods(
      client.stripe_customer_id,
      { type: "card", limit: 20 },
      opts,
    );
    const methods: PaymentMethodSummary[] = (pms.data ?? [])
      .filter((pm: any) => pm.card)
      .map((pm: any) => ({
        id: pm.id,
        brand: pm.card.brand ?? "card",
        last4: pm.card.last4 ?? "????",
        expMonth: pm.card.exp_month ?? 0,
        expYear: pm.card.exp_year ?? 0,
        isDefault: pm.id === defaultId,
      }));
    return { methods, hasCustomer: true };
  });

export const setDefaultPaymentMethod = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ clientId: z.string().uuid(), paymentMethodId: z.string().min(3) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const client = await loadClientForBilling(context.supabase, context.userId, data.clientId);
    if (!client.stripe_customer_id) throw new Error("No saved payment methods for this client");
    const { stripe, opts } = await stripeFor(client.organization_id);

    // The method must belong to THIS client's customer; a pasted pm_… id
    // from another customer must not be attachable as their default.
    const pm = await stripe.paymentMethods.retrieve(data.paymentMethodId, {}, opts);
    const pmCustomer = typeof pm.customer === "string" ? pm.customer : pm.customer?.id;
    if (pmCustomer !== client.stripe_customer_id)
      throw new Error("That card doesn't belong to this client");

    await stripe.customers.update(
      client.stripe_customer_id,
      { invoice_settings: { default_payment_method: data.paymentMethodId } },
      opts,
    );
    const { error } = await context.supabase
      .from("clients")
      .update({
        default_payment_method_id: data.paymentMethodId,
        default_card_brand: pm.card?.brand ?? null,
        default_card_last4: pm.card?.last4 ?? null,
      })
      .eq("id", client.id);
    if (error) throw new Error(error.message);

    await logActivity(context.supabase, {
      orgId: client.organization_id,
      clientId: client.id,
      actorUserId: context.userId,
      kind: "billing.default_card_changed",
      summary: `Set default card to ${pm.card?.brand ?? "card"} ****${pm.card?.last4 ?? ""}`,
    });
    return { ok: true };
  });

export const removePaymentMethod = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ clientId: z.string().uuid(), paymentMethodId: z.string().min(3) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const client = await loadClientForBilling(context.supabase, context.userId, data.clientId);
    if (!client.stripe_customer_id) throw new Error("No saved payment methods for this client");
    const { stripe, opts } = await stripeFor(client.organization_id);

    const pm = await stripe.paymentMethods.retrieve(data.paymentMethodId, {}, opts);
    const pmCustomer = typeof pm.customer === "string" ? pm.customer : pm.customer?.id;
    if (pmCustomer !== client.stripe_customer_id)
      throw new Error("That card doesn't belong to this client");

    await stripe.paymentMethods.detach(data.paymentMethodId, {}, opts);

    if (client.default_payment_method_id === data.paymentMethodId) {
      // Promote another saved card if one remains; otherwise the client has
      // no card on file and autopay can't run.
      const rest = await stripe.customers.listPaymentMethods(
        client.stripe_customer_id,
        { type: "card", limit: 5 },
        opts,
      );
      const next = (rest.data ?? []).find((m: any) => m.card);
      if (next) {
        await stripe.customers.update(
          client.stripe_customer_id,
          { invoice_settings: { default_payment_method: next.id } },
          opts,
        );
        await context.supabase
          .from("clients")
          .update({
            default_payment_method_id: next.id,
            default_card_brand: next.card?.brand ?? null,
            default_card_last4: next.card?.last4 ?? null,
          })
          .eq("id", client.id);
      } else {
        await context.supabase
          .from("clients")
          .update({
            default_payment_method_id: null,
            default_card_brand: null,
            default_card_last4: null,
            autopay_enabled: false,
          })
          .eq("id", client.id);
      }
    }

    await logActivity(context.supabase, {
      orgId: client.organization_id,
      clientId: client.id,
      actorUserId: context.userId,
      kind: "billing.card_removed",
      summary: `Removed ${pm.card?.brand ?? "card"} ****${pm.card?.last4 ?? ""}`,
    });
    return { ok: true };
  });

/** Staff-initiated inline card save: create a SetupIntent on the connected
 * account for a Payment Element, instead of redirecting to hosted Checkout. */
export const createSetupIntentForClient = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const client = await loadClientForBilling(context.supabase, context.userId, data.clientId);
    const { requireOrgStripeAccount, connectStripe, connectPublishableKey, verifyClientStripeCustomer } =
      await import("@/lib/stripe-connect.server");
    const acct = await requireOrgStripeAccount(client.organization_id);
    const stripe = await connectStripe();
    const opts = { stripeAccount: acct.accountId };

    let customerId = await verifyClientStripeCustomer(stripe, acct.accountId, client);
    if (!customerId) {
      const cust = await stripe.customers.create(
        {
          email: client.primary_email ?? undefined,
          name: client.display_name ?? undefined,
          metadata: { client_id: client.id, organization_id: client.organization_id },
        },
        opts,
      );
      customerId = cust.id;
      const { error } = await context.supabase
        .from("clients")
        .update({ stripe_customer_id: customerId })
        .eq("id", client.id);
      if (error) throw new Error(error.message);
    }

    const si = await stripe.setupIntents.create(
      {
        customer: customerId,
        payment_method_types: ["card"],
        usage: "off_session",
        metadata: {
          // Distinct from portal_setup_inline: a staff-added card must NOT
          // flip autopay on (the client may have chosen autopay off).
          source: "staff_setup_inline",
          client_id: client.id,
          organization_id: client.organization_id,
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
 * client's default and record the card details. Never touches autopay —
 * that's the client's choice from the portal (staff_setup rule). */
export const finalizeCardSetupForClient = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ clientId: z.string().uuid(), setupIntentId: z.string().min(3) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const client = await loadClientForBilling(context.supabase, context.userId, data.clientId);
    const { stripe, opts } = await stripeFor(client.organization_id);

    const si = await stripe.setupIntents.retrieve(data.setupIntentId, {}, opts);
    const pmId = typeof si.payment_method === "string" ? si.payment_method : si.payment_method?.id;
    const customerId = typeof si.customer === "string" ? si.customer : si.customer?.id;
    if (!pmId || !customerId) throw new Error("Card wasn't saved. Please try again.");
    // Security: the SetupIntent must be the one we minted for THIS client, so
    // a pasted/guessed seti_… id from another client can't bind their card here.
    if (si.metadata?.client_id !== client.id) throw new Error("Card setup could not be verified.");

    const pm = await stripe.paymentMethods.retrieve(pmId, {}, opts);
    await stripe.customers.update(
      customerId,
      { invoice_settings: { default_payment_method: pmId } },
      opts,
    );
    const { error } = await context.supabase
      .from("clients")
      .update({
        stripe_customer_id: customerId,
        default_payment_method_id: pmId,
        default_card_brand: pm.card?.brand ?? null,
        default_card_last4: pm.card?.last4 ?? null,
      })
      .eq("id", client.id);
    if (error) throw new Error(error.message);

    await logActivity(context.supabase, {
      orgId: client.organization_id,
      clientId: client.id,
      actorUserId: context.userId,
      kind: "billing.card_added",
      summary: `Added ${pm.card?.brand ?? "card"} ****${pm.card?.last4 ?? ""}`,
    });
    return { ok: true, brand: pm.card?.brand ?? null, last4: pm.card?.last4 ?? null };
  });
