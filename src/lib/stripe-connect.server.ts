import { makeStripe } from "@/lib/stripe-client.server";
// Server-only helpers for tenant Stripe via Connect (Express accounts).
// HoundStack is the Connect PLATFORM here (STRIPE_CONNECT_* keys) — distinct
// from the platform's SaaS-billing Stripe (PLATFORM_STRIPE_* / bucket A).
// Tenant->client charges run on the org's connected Express account by passing
// { stripeAccount } to the Connect platform client. Express uses Stripe-hosted
// onboarding (Account Links); the tenant never shares an API key.

export type OrgStripeAccount = {
  accountId: string;
  chargesEnabled: boolean;
  /** True when this is the FRANCHISE's account rather than the org's own —
   *  BUILD-6. Callers that word errors or receipts need to know, because
   *  "connect your Stripe account" is the wrong advice for a location whose
   *  franchise collects on its behalf. */
  collectedByParent: boolean;
};

export function connectSecret(): string {
  const s = process.env.STRIPE_CONNECT_SECRET_KEY;
  if (!s) throw new Error("Stripe Connect is not configured. Contact support.");
  return s;
}

/** Connect platform publishable key — used to init embedded Connect components
 *  and the client-side Payment Element scoped to a connected account. */
export function connectPublishableKey(): string {
  const k = process.env.STRIPE_CONNECT_PUBLISHABLE_KEY;
  if (!k) throw new Error("Stripe Connect is not configured (missing publishable key). Contact support.");
  return k;
}

/** The Connect platform Stripe client (platform secret key). */
export async function connectStripe() {
  return await makeStripe(connectSecret());
}

/**
 * The account a charge for this org should be made on.
 *
 * Normally the org's own connected account. BUILD-6 adds one exception: a
 * franchise LOCATION whose `payments_collected_by_parent` is set charges into
 * the FRANCHISE's account instead, because the owner's model is that the
 * franchise collects and then remits the location's share.
 *
 * Resolved here, in the single funnel every charge site already passes through,
 * rather than at each call site — there are several, and a location whose
 * payments routed correctly from the invoice page but not from autopay would be
 * a very expensive kind of inconsistent.
 *
 * One hop only, never a loop: the two-level rule means a parent has no parent,
 * and this reads the parent's own columns directly rather than recursing.
 */
export async function resolveOrgStripeAccount(orgId: string): Promise<OrgStripeAccount | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await (supabaseAdmin as any)
    .from("organizations")
    .select(
      "stripe_connect_account_id, stripe_connect_charges_enabled, parent_organization_id, payments_collected_by_parent",
    )
    .eq("id", orgId)
    .maybeSingle();
  if (!data) return null;

  if (data.payments_collected_by_parent && data.parent_organization_id) {
    const { data: parent } = await (supabaseAdmin as any)
      .from("organizations")
      .select("stripe_connect_account_id, stripe_connect_charges_enabled")
      .eq("id", data.parent_organization_id)
      .maybeSingle();
    const parentAccount = parent?.stripe_connect_account_id as string | null | undefined;
    // Deliberately NO fallback to the location's own account. If the franchise
    // is supposed to be collecting and its account is missing or broken, the
    // charge must fail loudly — quietly billing the customer into the
    // franchisee's account instead would put money in the wrong bank and be
    // discovered at reconciliation, if ever.
    if (!parentAccount) return null;
    return {
      accountId: parentAccount,
      chargesEnabled: !!parent.stripe_connect_charges_enabled,
      collectedByParent: true,
    };
  }

  const accountId = data.stripe_connect_account_id as string | null | undefined;
  if (!accountId) return null;
  return {
    accountId,
    chargesEnabled: !!data.stripe_connect_charges_enabled,
    collectedByParent: false,
  };
}

/** What a CUSTOMER reads when the business can't take cards yet (R2-42). The
 *  staff wording ("Connect one on the Payments page") is an instruction to the
 *  owner; shown in the portal or on the booking link it tells a customer to do
 *  something they cannot. */
export const CUSTOMER_CARDS_UNAVAILABLE =
  "This business isn't taking card payments online yet. Please contact them to pay another way.";

/** For charge sites: require a charge-ready connected account or throw a clear
 *  error. NEVER falls back to the platform account — that would put tenant
 *  charges on HoundStack's own Stripe.
 *
 *  `audience: "customer"` is for the portal and the booking link: the same
 *  refusal, worded for the person paying rather than the owner. */
export async function requireOrgStripeAccount(
  orgId: string,
  opts: { audience?: "staff" | "customer" } = {},
): Promise<OrgStripeAccount> {
  // A locked account (trial over with no plan, or a plan that has ended)
  // takes no payments until the owner subscribes. Checked before the account
  // is even looked up, so every charge path refuses the same way.
  const { refuseChargesIfLocked } = await import("@/lib/account-lock.server");
  await refuseChargesIfLocked(orgId, { audience: opts.audience });
  const acct = await resolveOrgStripeAccount(orgId);
  if (opts.audience === "customer") {
    if (!acct || !acct.chargesEnabled) throw new Error(CUSTOMER_CARDS_UNAVAILABLE);
    return acct;
  }
  if (!acct) {
    // BUILD-6: for a location whose franchise collects, "connect your Stripe
    // account" is advice the franchisee cannot act on — it is the franchise's
    // account that is missing. Ask the right person.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: org } = await (supabaseAdmin as any)
      .from("organizations")
      .select("payments_collected_by_parent, parent_organization_id")
      .eq("id", orgId)
      .maybeSingle();
    if (org?.payments_collected_by_parent && org?.parent_organization_id) {
      throw new Error(
        "Payments for this location are collected by your franchise, and their Stripe account isn't ready yet. Ask them to finish Stripe setup.",
      );
    }
    throw new Error("This business hasn't connected a Stripe account yet. Connect one on the Payments page.");
  }
  if (!acct.chargesEnabled) {
    throw new Error("The connected Stripe account can't accept charges yet. Finish Stripe onboarding on the Payments page.");
  }
  return acct;
}

/**
 * Ensure the org has an Express connected account, creating one on first use.
 * Returns the account id. The account is stored on the org immediately (status
 * pending) so the Account Link onboarding + return flow can find it without an
 * OAuth state handshake.
 */
export async function ensureExpressAccount(orgId: string, email?: string): Promise<string> {
  const existing = await resolveOrgStripeAccount(orgId);
  if (existing) return existing.accountId;

  const stripe = await connectStripe();
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: org } = await (supabaseAdmin as any)
    .from("organizations").select("name").eq("id", orgId).maybeSingle();

  const acct = await stripe.accounts.create({
    type: "express",
    country: "US",
    email: email || undefined,
    business_profile: { name: org?.name || undefined },
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
    metadata: { organization_id: orgId },
  });

  await (supabaseAdmin as any).from("organizations").update({
    stripe_connect_account_id: acct.id,
    stripe_connect_status: acct.charges_enabled ? "active" : "pending",
    stripe_connect_charges_enabled: !!acct.charges_enabled,
    stripe_connect_connected_at: new Date().toISOString(),
  }).eq("id", orgId);

  return acct.id;
}

/**
 * Cutover safety: a client's saved Stripe customer + payment method live on the
 * account that stored them. When an org connects a different account (or
 * disconnects), those references are invalid on the new account, so clear them
 * to force a clean re-save. Autopay is turned off since there's no card to
 * charge until the client re-enters one.
 */
export async function clearOrgClientStripeRefs(orgId: string): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await (supabaseAdmin as any)
    .from("clients")
    .update({
      stripe_customer_id: null,
      default_payment_method_id: null,
      default_card_brand: null,
      default_card_last4: null,
      autopay_enabled: false,
    })
    .eq("organization_id", orgId);
}

/** Clear ONE client's saved Stripe refs (stale/orphaned customer detected). */
export async function clearClientStripeRefs(clientId: string): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await (supabaseAdmin as any)
    .from("clients")
    .update({
      stripe_customer_id: null,
      default_payment_method_id: null,
      default_card_brand: null,
      default_card_last4: null,
      autopay_enabled: false,
    })
    .eq("id", clientId);
}

/** True when a Stripe error means "this object doesn't exist on this account". */
export function isStripeMissingResource(e: unknown): boolean {
  const err = e as { code?: string; message?: string } | null;
  return err?.code === "resource_missing" || /no such customer/i.test(err?.message ?? "");
}

/**
 * A stored client customer id can point at a PREVIOUS connected account (the
 * Standard→Express cutover orphaned every customer stored before it), which
 * surfaces as a raw "No such customer: 'cus_…'" at the exact moment a client
 * tries to pay. Verify the id against the CURRENT account; if it's gone,
 * clear the stale refs and return null so the caller mints a fresh customer
 * (or asks for the card again) instead of erroring.
 */
export async function verifyClientStripeCustomer(
  stripe: { customers: { retrieve: (id: string, params: object, opts: object) => Promise<unknown> } },
  stripeAccount: string,
  client: { id: string; stripe_customer_id: string | null },
): Promise<string | null> {
  const id = client.stripe_customer_id;
  if (!id) return null;
  try {
    const cust = (await stripe.customers.retrieve(id, {}, { stripeAccount })) as { deleted?: boolean } | null;
    if (cust?.deleted) {
      await clearClientStripeRefs(client.id);
      return null;
    }
    return id;
  } catch (e) {
    if (isStripeMissingResource(e)) {
      await clearClientStripeRefs(client.id);
      return null;
    }
    throw e;
  }
}

/** Retrieve the connected account and return its charge-readiness + status. */
export async function fetchConnectAccountState(
  accountId: string,
): Promise<{ chargesEnabled: boolean; status: string }> {
  const stripe = await connectStripe();
  const acct = await stripe.accounts.retrieve(accountId);
  return accountStateFrom(acct);
}

/** Derive our status fields from a Stripe Account object (retrieve or webhook). */
export function accountStateFrom(acct: {
  charges_enabled?: boolean | null;
  details_submitted?: boolean | null;
}): { chargesEnabled: boolean; status: string } {
  const chargesEnabled = !!acct.charges_enabled;
  const status = chargesEnabled ? "active" : (acct.details_submitted ? "restricted" : "pending");
  return { chargesEnabled, status };
}

/**
 * Which organization's Stripe account will actually receive money charged for
 * this org — recorded on each payment as it is taken (BUILD-6).
 *
 * Stamped at charge time rather than derived at settlement time, because
 * routing can change. A location that switches to franchise-collection
 * mid-month has revenue on both sides of the switch, and settling the whole
 * period by whatever is true on the 1st would misattribute every payment taken
 * under the old arrangement — in a calculation that decides who owes whom
 * money.
 *
 * Only for money that actually moved through Stripe. Cash or a cheque handed to
 * the location was collected BY the location whatever the routing says, so
 * those call sites pass the org's own id directly instead of calling this.
 */
export async function collectingOrgIdFor(orgId: string): Promise<string> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await (supabaseAdmin as any)
    .from("organizations")
    .select("parent_organization_id, payments_collected_by_parent")
    .eq("id", orgId)
    .maybeSingle();
  if (data?.payments_collected_by_parent && data?.parent_organization_id) {
    return data.parent_organization_id as string;
  }
  return orgId;
}
