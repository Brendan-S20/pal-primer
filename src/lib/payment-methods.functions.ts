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

/** Staff-initiated hosted Checkout (mode=setup) to add a card. Reuses the
 * portal_setup webhook finalizer, so the new card lands as the default. */
export const startCardSetupForClient = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ clientId: z.string().uuid(), returnUrl: z.string().url() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const client = await loadClientForBilling(context.supabase, context.userId, data.clientId);
    const { requireOrgStripeAccount, connectStripe, verifyClientStripeCustomer } = await import(
      "@/lib/stripe-connect.server"
    );
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

    const checkout = await stripe.checkout.sessions.create(
      {
        mode: "setup",
        customer: customerId,
        payment_method_types: ["card"],
        success_url: `${data.returnUrl}${data.returnUrl.includes("?") ? "&" : "?"}card_saved=1`,
        cancel_url: data.returnUrl,
        metadata: {
          // Distinct from portal_setup: the webhook must NOT flip autopay on
          // for a staff-added card (the client may have chosen autopay off).
          source: "staff_setup",
          client_id: client.id,
          organization_id: client.organization_id,
        },
      },
      opts,
    );
    return { url: checkout.url as string };
  });
