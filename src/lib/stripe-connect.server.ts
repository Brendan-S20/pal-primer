// Server-only helpers for tenant Stripe via Connect (Express accounts).
// HoundStack is the Connect PLATFORM here (STRIPE_CONNECT_* keys) — distinct
// from the platform's SaaS-billing Stripe (PLATFORM_STRIPE_* / bucket A).
// Tenant->client charges run on the org's connected Express account by passing
// { stripeAccount } to the Connect platform client. Express uses Stripe-hosted
// onboarding (Account Links); the tenant never shares an API key.

export type OrgStripeAccount = { accountId: string; chargesEnabled: boolean };

export function connectSecret(): string {
  const s = process.env.STRIPE_CONNECT_SECRET_KEY;
  if (!s) throw new Error("Stripe Connect is not configured. Contact support.");
  return s;
}

/** The Connect platform Stripe client (platform secret key). */
export async function connectStripe() {
  const Stripe = (await import("stripe")).default;
  return new Stripe(connectSecret());
}

/** The org's connected account, or null if it hasn't connected one. */
export async function resolveOrgStripeAccount(orgId: string): Promise<OrgStripeAccount | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await (supabaseAdmin as any)
    .from("organizations")
    .select("stripe_connect_account_id, stripe_connect_charges_enabled")
    .eq("id", orgId)
    .maybeSingle();
  const accountId = data?.stripe_connect_account_id as string | null | undefined;
  if (!accountId) return null;
  return { accountId, chargesEnabled: !!data.stripe_connect_charges_enabled };
}

/** For charge sites: require a charge-ready connected account or throw a clear
 *  error. NEVER falls back to the platform account — that would put tenant
 *  charges on HoundStack's own Stripe. */
export async function requireOrgStripeAccount(orgId: string): Promise<OrgStripeAccount> {
  const acct = await resolveOrgStripeAccount(orgId);
  if (!acct) {
    throw new Error("This business hasn't connected a Stripe account yet. Connect one in Settings → Payments.");
  }
  if (!acct.chargesEnabled) {
    throw new Error("The connected Stripe account can't accept charges yet — finish Stripe onboarding in Settings → Payments.");
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
