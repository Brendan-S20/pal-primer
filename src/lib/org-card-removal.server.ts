// Removing one of the business's own saved cards (Plan & billing), on the
// platform's Stripe customer for the org.
//
// A locked owner (trial over, no active plan) reaches this too: Plan & billing
// is the one page a locked account keeps (src/lib/account-lock.ts), and
// removing a card is part of managing what will be charged when they choose a
// plan. The card is DETACHED in Stripe, not only hidden here, and a detach
// Stripe refuses is an error rather than "Card removed".
import { detachPaymentMethod, type DetachOutcome } from "@/lib/stripe-detach.server";

/** The calls this needs from the Stripe SDK; tests pass a fake. */
export type OrgCardStripe = {
  paymentMethods: {
    retrieve: (id: string) => Promise<{ customer?: string | { id: string } | null }>;
    detach: (id: string) => Promise<unknown>;
  };
  customers: {
    retrieve: (id: string) => Promise<unknown>;
    listPaymentMethods: (
      id: string,
      params: { type: "card"; limit: number },
    ) => Promise<{ data?: Array<{ id: string; card?: unknown }> }>;
    update: (id: string, params: object) => Promise<unknown>;
  };
  subscriptions: {
    retrieve: (id: string) => Promise<{ default_payment_method?: string | { id: string } | null }>;
    update: (id: string, params: object) => Promise<unknown>;
  };
};

export async function removeOrgCard(input: {
  stripe: OrgCardStripe;
  customerId: string;
  subscriptionId: string | null;
  billingStatus: string | null;
  paymentMethodId: string;
  /** Which card is the default now (customer or subscription). */
  defaultIdFor: (customer: unknown) => Promise<string | null>;
}): Promise<{ ok: true; outcome: DetachOutcome }> {
  const { stripe, customerId, subscriptionId, billingStatus, paymentMethodId } = input;

  let pm: { customer?: string | { id: string } | null } | null;
  try {
    pm = await stripe.paymentMethods.retrieve(paymentMethodId);
  } catch (e) {
    if ((e as { code?: string })?.code !== "resource_missing") throw e;
    // Deleted in Stripe already: there is nothing left to remove.
    console.info("[org-card-removal] card no longer exists in Stripe", paymentMethodId);
    pm = null;
  }
  const pmCustomer = typeof pm?.customer === "string" ? pm.customer : (pm?.customer?.id ?? null);

  // Attached to nobody (or deleted): already detached, by an earlier removal
  // or Stripe's own dashboard. It cannot be charged, which is what removing it
  // was for. The default is still repaired below, so a retry after a removal
  // whose promote step failed finishes the job instead of stopping here.
  if (!pmCustomer) {
    await repairDefault(input);
    return { ok: true, outcome: "already_detached" };
  }
  if (pmCustomer !== customerId) throw new Error("That card doesn't belong to your account.");

  const customer = await stripe.customers.retrieve(customerId);
  const defaultId = await input.defaultIdFor(customer);
  const pms = await stripe.customers.listPaymentMethods(customerId, { type: "card", limit: 20 });
  const others = (pms.data ?? []).filter((m) => m.card && m.id !== paymentMethodId);
  const wasDefault = paymentMethodId === defaultId || others.length === 0;
  const subActive =
    !!subscriptionId &&
    (billingStatus === "active" || billingStatus === "past_due" || billingStatus === "grace");

  // Guard: never leave a live subscription with no card on file. If another
  // card remains it gets promoted below instead.
  if (wasDefault && subActive && others.length === 0) {
    throw new Error("Add another card first. An active subscription needs a card on file.");
  }

  const outcome = await detachPaymentMethod(stripe, paymentMethodId, {
    context: "org-card-removal",
  });
  await repairDefault(input);
  return { ok: true, outcome };
}

/** The id of a default that may be expanded or absent. */
function idOf(v: unknown): string | null {
  if (typeof v === "string") return v;
  return (v as { id?: string } | null | undefined)?.id ?? null;
}

/**
 * Make the customer's default and the subscription's default each point at a
 * card that is still attached. Checked SEPARATELY (review on #748): a removal
 * whose customer update succeeded but subscription update failed leaves the
 * customer right and the subscription on the detached card, and a retry has
 * to see the subscription's half to finish the job.
 *
 * Run after every removal, including one that found the card already gone:
 * the state it repairs is "detached, but the promote that should have
 * followed did not happen". The card both are moved to is a valid default
 * either already had, so a repair never moves a default that is fine; with
 * none valid, the first attached card.
 */
async function repairDefault(input: {
  stripe: OrgCardStripe;
  customerId: string;
  subscriptionId: string | null;
}): Promise<void> {
  const { stripe, customerId, subscriptionId } = input;
  const pms = await stripe.customers.listPaymentMethods(customerId, { type: "card", limit: 20 });
  const attached = new Set((pms.data ?? []).filter((m) => m.card).map((m) => m.id));
  if (attached.size === 0) return;
  const valid = (id: string | null) => (id && attached.has(id) ? id : null);

  const customer = (await stripe.customers.retrieve(customerId)) as {
    invoice_settings?: { default_payment_method?: unknown };
  } | null;
  const customerDefault = valid(idOf(customer?.invoice_settings?.default_payment_method));

  let subDefault: string | null = null;
  let subExists = false;
  if (subscriptionId) {
    try {
      const sub = await stripe.subscriptions.retrieve(subscriptionId);
      subExists = true;
      subDefault = valid(idOf(sub?.default_payment_method));
    } catch (e) {
      if ((e as { code?: string })?.code !== "resource_missing") throw e;
    }
  }

  const target = customerDefault ?? subDefault ?? [...attached][0];
  if (!customerDefault) {
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: target },
    });
  }
  if (subscriptionId && subExists && !subDefault) {
    await stripe.subscriptions.update(subscriptionId, { default_payment_method: target });
  }
}
