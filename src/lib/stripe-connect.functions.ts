import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";

// Tenant Stripe Connect (Express) management. Connecting the org's own Stripe
// account (bank/payout/identity onboarding) is an owner-level financial action,
// gated by manage_org_billing — owner-only, matching the /payments route ACL and
// sidebar nav (H5 #6). Previously gated on manage_settings, which let techs and
// office managers reach these; that was both an authz hole (I7) and the reason
// the nav/route audience diverged.


// Frictionless-signup gate: Stripe Express stays locked until the owner
// verifies their email (Brendan's re-review). Money movement needs a real,
// reachable owner address.
async function requireVerifiedEmail(orgId: string): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await (supabaseAdmin as any)
    .from("organizations")
    .select("email_verified_at")
    .eq("id", orgId)
    .maybeSingle();
  if (!data?.email_verified_at) {
    throw new Error("Verify your email address to unlock payments. Check your inbox or resend the link from the Payments page.");
  }
}

export const getStripeConnectStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_org_billing");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await (supabaseAdmin as any)
      .from("organizations")
      .select("stripe_connect_account_id, stripe_connect_status, stripe_connect_charges_enabled, stripe_connect_connected_at, email_verified_at")
      .eq("id", orgId)
      .maybeSingle();
    return {
      emailVerified: !!data?.email_verified_at,
      connected: !!data?.stripe_connect_account_id,
      accountId: (data?.stripe_connect_account_id as string) ?? null,
      status: (data?.stripe_connect_status as string) ?? null,
      chargesEnabled: !!data?.stripe_connect_charges_enabled,
      connectedAt: (data?.stripe_connect_connected_at as string) ?? null,
    };
  });

/**
 * Begin (or resume) Express onboarding. Creates the connected account on first
 * use, then returns a Stripe-hosted Account Link URL to redirect to. Safe to
 * call again to refresh an expired link — the account is reused.
 */
export const startStripeConnect = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ origin: z.string().url() }).parse(d))
  .handler(async ({ data, context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_org_billing");
    await requireVerifiedEmail(orgId);
    const { data: userData } = await context.supabase.auth.getUser();
    const email = userData.user?.email ?? undefined;

    const { ensureExpressAccount, connectStripe } = await import("@/lib/stripe-connect.server");
    const accountId = await ensureExpressAccount(orgId, email);
    const stripe = await connectStripe();
    const link = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${data.origin}/settings/payments?stripe_refresh=1`,
      return_url: `${data.origin}/settings/payments?connected=1`,
      type: "account_onboarding",
    });
    return { url: link.url };
  });

/** Ensure the org has an Express account (create on first use), for embedded
 *  onboarding + dashboard. Returns the account's charge-readiness. */
export const ensureStripeConnectAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_org_billing");
    await requireVerifiedEmail(orgId);
    const { data: userData } = await context.supabase.auth.getUser();
    const { ensureExpressAccount, resolveOrgStripeAccount } = await import("@/lib/stripe-connect.server");
    const accountId = await ensureExpressAccount(orgId, userData.user?.email ?? undefined);
    const acct = await resolveOrgStripeAccount(orgId);
    return { accountId, chargesEnabled: !!acct?.chargesEnabled };
  });

/**
 * Create a Connect Account Session for embedded components — the in-app Stripe
 * dashboard.
 *
 * ── THE GOAL: A TENANT NEVER OPENS STRIPE ─────────────────────────────────
 *
 * Every component enabled here is one fewer reason for a pet-waste business to
 * leave HoundStack, learn a second product, and discover that the thing they
 * needed was two products deep in someone else's navigation.
 *
 * ── FEATURES ARE SPELLED OUT EVEN WHERE THEY ARE THE DEFAULT ──────────────
 *
 * `refund_management` and `dispute_management` are `true` by default on the
 * payments component, which means tenants could ALREADY refund and answer
 * disputes in-app — while `disputes.ts` told them "answering it in Stripe is
 * how it stays that way" and `platform-fee.ts` recorded that "tenants refund
 * from their own Stripe dashboard". The capability was on and the product said
 * it was off, which is this repo's recurring defect wearing its friendliest
 * face: nobody was harmed, they were just sent somewhere they did not need to
 * go, on the two tasks that matter most when money is disputed.
 *
 * Writing the defaults out is what stops that recurring. A silent default is a
 * capability nobody can grep for, and the copy drifts away from it the moment
 * someone writes a sentence from memory.
 */
export const createStripeAccountSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_org_billing");
    await requireVerifiedEmail(orgId);
    const { resolveOrgStripeAccount, connectStripe, connectPublishableKey } = await import("@/lib/stripe-connect.server");
    const acct = await resolveOrgStripeAccount(orgId);
    if (!acct) throw new Error("Connect a Stripe account first.");
    const stripe = await connectStripe();
    // ── Features shared across the payment/dispute components ────────────
    //
    // Stripe rejects the WHOLE AccountSession if any two components declare
    // different values for a feature they have in common. Not the component,
    // not the feature — the session, so payouts, balances, documents and
    // everything else go down with it.
    //
    // This bit twice, and the second time is the instructive one:
    //
    //   1. "…specified by `payments` and `payment_details` must be the same."
    //      `payments` set capture_payments: false; `payment_details` had no
    //      features block, so Stripe applied its own default of true.
    //
    //   2. "…specified by `payment_details` and `disputes_list` must be the
    //      same." The first fix gave those two a shared object and stopped
    //      there, because the error had named exactly two components. It is
    //      not a pairwise rule. `disputes_list` was still bare and still
    //      defaulting, so the identical defect simply moved to the next
    //      component in Stripe's validation order.
    //
    // The constraint is over EVERY component that accepts a feature, so the
    // fix has to be too. Per the SDK types (stripe@22, AccountSessions.d.ts):
    //
    //   payments · payment_details · disputes_list · payment_disputes
    //     ← all four accept refund_management, dispute_management,
    //       smart_disputes_management, destination_on_behalf_of_charge_management
    //   capture_payments
    //     ← accepted by the first THREE; `payment_disputes` has no such
    //       feature, and sending it there is its own error.
    //
    // Hence two objects rather than one: the common four, and the three that
    // also take capture_payments. `tests/stripe-account-session-features`
    // derives this partition from the SDK's own types, so adding a component
    // without its features fails there instead of in production.
    const disputeFeatures = {
      // Both default to true. Stated so the capability is greppable, and so a
      // future change to Stripe's defaults cannot quietly remove the two
      // things a tenant most needs when a customer complains.
      refund_management: true,
      dispute_management: true,
      // Stripe's guided evidence flow — the difference between a tenant
      // answering a chargeback and ignoring it. It defaults to the value of
      // `dispute_management`, which is how it survived being declared on
      // `payments` alone; that was luck, not design.
      smart_disputes_management: true,
      // Charges are DIRECT — the connected account is merchant of record.
      // Nothing is created on their behalf, so this manages an empty set.
      destination_on_behalf_of_charge_management: false,
    } as const;

    // The other shared set, and the one nobody had noticed. `account_onboarding`,
    // `account_management`, `notification_banner`, `payouts` and `balances` all
    // accept these two — five components, every one of them previously bare and
    // therefore agreeing only because they all took the same default. The first
    // one to declare a value would have broken the session exactly as
    // `capture_payments` did.
    //
    // Both values here ARE the current defaults, so this changes no behaviour;
    // it removes the trap.
    const accountFeatures = {
      // Tenants manage their own payout bank account in the embedded component.
      // Turning this off would mean collecting bank details ourselves and
      // sending them to Stripe, which is the opposite of the requirement that
      // a tenant never has to leave the app.
      external_account_collection: true,
      // Forced, not chosen: this can only be true when
      // `controller.requirement_collection` is `application`, and ours is
      // `stripe`. It also defaults to the inverse of the line above.
      disable_stripe_user_authentication: false,
    } as const;

    // Deliberately NOT declared: `edit_payout_schedule`, `standard_payouts` and
    // `instant_payouts`, which `payouts` and `balances` both accept. Their
    // defaults depend on the connected account's controller config
    // (`losses.payments` is `application` here, so the first two default off),
    // and declaring a value I could only infer risks re-breaking the dashboard
    // to no benefit. Undeclared on BOTH is consistent — the invariant is that a
    // shared feature is declared everywhere or nowhere, not that it is always
    // declared. Turning payout controls on is a business decision with platform
    // liability attached, and belongs in its own change.

    const paymentFeatures = {
      ...disputeFeatures,
      // Capturing/cancelling a PaymentIntent by hand. HoundStack creates and
      // confirms in one step, so there is nothing for a tenant to capture;
      // leaving it on would show a control that never applies.
      capture_payments: false,
    } as const;

    const session = await stripe.accountSessions.create({
      account: acct.accountId,
      components: {
        account_onboarding: { enabled: true, features: { ...accountFeatures } },
        account_management: { enabled: true, features: { ...accountFeatures } },
        notification_banner: { enabled: true, features: { ...accountFeatures } },
        payments: { enabled: true, features: { ...paymentFeatures } },
        payouts: { enabled: true, features: { ...accountFeatures } },
        balances: { enabled: true, features: { ...accountFeatures } },
        // The dispute surface proper. `payments` allows RESPONDING to a
        // dispute; without these there is no list to find one in and no detail
        // view to read the customer's claim — so the tenant still ended up in
        // Stripe to see what they were answering.
        disputes_list: { enabled: true, features: { ...paymentFeatures } },
        payment_disputes: { enabled: true, features: { ...disputeFeatures } },
        // One payment, in full: the timeline, the card, the refunds against it.
        // What "why did this fail?" actually needs.
        payment_details: { enabled: true, features: { ...paymentFeatures } },
        // Tax forms — the 1099-K. An annual, unavoidable errand that otherwise
        // has exactly one home, and it is not this product.
        documents: { enabled: true },
      },
    });
    return { clientSecret: session.client_secret, publishableKey: connectPublishableKey() };
  });

/** Re-check the connected account's charge-readiness with Stripe. */
export const refreshStripeConnect = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_org_billing");
    const { resolveOrgStripeAccount, fetchConnectAccountState } = await import("@/lib/stripe-connect.server");
    const acct = await resolveOrgStripeAccount(orgId);
    if (!acct) return { connected: false, chargesEnabled: false, status: null as string | null };
    const state = await fetchConnectAccountState(acct.accountId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await (supabaseAdmin as any).from("organizations").update({
      stripe_connect_charges_enabled: state.chargesEnabled,
      stripe_connect_status: state.status,
    }).eq("id", orgId);
    return { connected: true, chargesEnabled: state.chargesEnabled, status: state.status };
  });

/**
 * Remediation pass for orphaned saved cards: a connected-account cutover (e.g.
 * Standard→Express) leaves clients pointing at customer ids that don't exist
 * on the current account, and every payment attempt throws "No such customer".
 * Verify every stored id against the live account and clear the stale ones so
 * staff/portal prompt for a fresh card instead of erroring mid-payment.
 */
export const auditClientCardRefs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_org_billing");
    const { requireOrgStripeAccount, connectStripe, verifyClientStripeCustomer } = await import("@/lib/stripe-connect.server");
    const acct = await requireOrgStripeAccount(orgId);
    const stripe = await connectStripe();
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: rows, error } = await supabaseAdmin
      .from("clients")
      .select("id, display_name, stripe_customer_id")
      .eq("organization_id", orgId)
      .not("stripe_customer_id", "is", null);
    if (error) throw new Error(error.message);

    const cleared: string[] = [];
    let checked = 0;
    for (const c of rows ?? []) {
      checked++;
      const live = await verifyClientStripeCustomer(stripe, acct.accountId, c);
      if (!live) cleared.push(c.display_name ?? c.id);
    }
    return { checked, cleared };
  });

/** Delete the Express account (platform-owned) and clear the org's fields. */
export const disconnectStripeConnect = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_org_billing");
    const { resolveOrgStripeAccount, connectStripe, clearOrgClientStripeRefs } = await import("@/lib/stripe-connect.server");
    const acct = await resolveOrgStripeAccount(orgId);
    if (acct) {
      try {
        const stripe = await connectStripe();
        await stripe.accounts.del(acct.accountId);
      } catch (e) {
        // Express accounts with a balance / activity can't be deleted; we still
        // drop our reference so the org can reconnect a fresh account.
        console.error("stripe express account delete failed", (e as Error).message);
      }
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await (supabaseAdmin as any).from("organizations").update({
      stripe_connect_account_id: null,
      stripe_connect_status: "disconnected",
      stripe_connect_charges_enabled: false,
      stripe_connect_connected_at: null,
    }).eq("id", orgId);
    await clearOrgClientStripeRefs(orgId);
    return { ok: true };
  });
