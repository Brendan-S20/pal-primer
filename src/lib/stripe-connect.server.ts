// Server-only helpers for tenant Stripe via Connect (OAuth). HoundStack is the
// Connect PLATFORM here (STRIPE_CONNECT_* keys) — distinct from the platform's
// SaaS-billing Stripe (PLATFORM_STRIPE_* / bucket A). Tenant->client charges run
// on the org's connected account by passing { stripeAccount } to the Connect
// platform client; the tenant's secret key is never stored.

export type OrgStripeAccount = { accountId: string; chargesEnabled: boolean };

export function connectSecret(): string {
  const s = process.env.STRIPE_CONNECT_SECRET_KEY;
  if (!s) throw new Error("Stripe Connect is not configured. Contact support.");
  return s;
}

export function connectClientId(): string {
  const id = process.env.STRIPE_CONNECT_CLIENT_ID;
  if (!id) throw new Error("Stripe Connect is not configured (missing client id). Contact support.");
  return id;
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

/** Retrieve the connected account and return its charge-readiness + status. */
export async function fetchConnectAccountState(
  accountId: string,
): Promise<{ chargesEnabled: boolean; status: string }> {
  const stripe = await connectStripe();
  const acct = await stripe.accounts.retrieve(accountId);
  const chargesEnabled = !!acct.charges_enabled;
  const status = chargesEnabled ? "active" : (acct.details_submitted ? "restricted" : "pending");
  return { chargesEnabled, status };
}
