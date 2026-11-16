// The Money tab's balance headline, server half (#922).
//
// ── WHY THIS IS ITS OWN FILE ──────────────────────────────────────────────
//
// getStripeBalanceSummary built its Stripe client from STRIPE_SECRET_KEY.
// That is the key for HoundStack's OWN Stripe account — the SaaS-billing one
// that charges tenants for their plan (billing.functions.ts, platform.ts). The
// tenant's connected Express account does not belong to that account; it
// belongs to the Connect PLATFORM, whose key is STRIPE_CONNECT_SECRET_KEY
// (stripe-connect.server.ts says so in its first lines). Every other call on
// the page — the Account Session that draws Balance and Payouts, onboarding,
// charges — already went through connectStripe().
//
// Asking a non-platform account to act `{ stripeAccount: acct_… }` is the
// exact request Stripe answers with "Only Stripe Connect platforms can work
// with other accounts." So the headline failed while the embedded panels under
// it, on the right key, rendered — which is what the Nov 12–16 smokes saw.
//
// Pulled out of the server function so the client choice and the error path
// can be tested with a fake Stripe, without a request context.

import type { OrgStripeAccount } from "@/lib/stripe-connect.server";
import { BALANCE_UNAVAILABLE } from "@/lib/payments-load";

type Money = { amount: number; currency: string };

/** The two reads the headline needs, typed narrowly so a test can fake them. */
export type BalanceStripe = {
  balance: {
    retrieve(
      params: Record<string, never>,
      opts: Record<string, unknown>,
    ): Promise<{ available?: Money[] | null; pending?: Money[] | null }>;
  };
  payouts: {
    list(
      params: { limit: number },
      opts: Record<string, unknown>,
    ): Promise<{
      data: Array<{
        amount: number;
        currency: string;
        status: string;
        arrival_date?: number | null;
      }>;
    }>;
  };
};

/** Mirrors BalanceSummaryData in payments-load.ts, with lastPayout spelled out
 *  (the client type leaves it `unknown`). */
export type BalanceSummaryResult =
  | { connected: false }
  | { connected: true; error: string }
  | {
      connected: true;
      available: Money[];
      pending: Money[];
      lastPayout: {
        amount: number;
        currency: string;
        status: string;
        arrivalDate: number | null;
      } | null;
    };

export type BalanceSummaryDeps = {
  /** resolveOrgStripeAccount: franchise-aware, so the headline names the same
   *  account the Account Session (and so the panels below it) draws. */
  resolveAccount: (orgId: string) => Promise<OrgStripeAccount | null>;
  /** connectStripe: the Connect PLATFORM client. Never the SaaS-billing key. */
  connectStripe: () => Promise<BalanceStripe>;
  log?: (msg: string, detail: Record<string, unknown>) => void;
};

/** acct_…1234, so a log line identifies the account without carrying it whole. */
function maskAccount(id: string): string {
  return id.length > 8 ? `${id.slice(0, 5)}…${id.slice(-4)}` : id;
}

/** What a Stripe error is, minus anything that could be a credential. Stripe's
 *  error message never contains the key, but a raw `e` can carry the request's
 *  headers, so only these named fields are logged. */
function describeStripeError(e: unknown): Record<string, unknown> {
  const x = (e ?? {}) as Record<string, unknown>;
  return {
    type: x.type ?? null,
    code: x.code ?? null,
    statusCode: x.statusCode ?? null,
    requestId: x.requestId ?? null,
    message: typeof x.message === "string" ? x.message : String(e),
  };
}

const sum = (rows: Money[]) => {
  // Summed per currency, not flattened to one number. A connected account can
  // hold several, and adding cents across currencies would produce a figure
  // that is wrong in every one of them.
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.currency, (m.get(r.currency) ?? 0) + r.amount);
  return [...m.entries()].map(([currency, amount]) => ({ currency, amount }));
};

export async function loadBalanceSummary(
  orgId: string,
  deps: BalanceSummaryDeps,
): Promise<BalanceSummaryResult> {
  const log = deps.log ?? ((msg, detail) => console.error(msg, detail));

  const acct = await deps.resolveAccount(orgId);
  if (!acct || !acct.chargesEnabled) return { connected: false as const };

  // Answered rather than thrown, so the page says it instead of retrying a
  // misconfiguration (#436) — and in the owner's words, not ours (#922).
  let stripe: BalanceStripe;
  try {
    stripe = await deps.connectStripe();
  } catch (e) {
    log("[stripe-balance] Connect platform client unavailable", {
      orgId,
      account: maskAccount(acct.accountId),
      ...describeStripeError(e),
    });
    return { connected: true as const, error: BALANCE_UNAVAILABLE };
  }

  // A deadline per request (#436). The SDK's default is 80s with retries,
  // which is a "Loading balance…" nobody waits out. 10s and one retry is the
  // outer bound; the page has its own deadline on top of this.
  const opts = { stripeAccount: acct.accountId, timeout: 10_000, maxNetworkRetries: 1 };

  try {
    const [balance, payouts] = await Promise.all([
      stripe.balance.retrieve({}, opts),
      stripe.payouts.list({ limit: 1 }, opts),
    ]);
    const next = payouts.data[0];
    return {
      connected: true as const,
      // "available" is what can be paid out now; "pending" is still clearing.
      // Showing only the total would overstate what the owner can actually
      // draw today, which is the number they came to find.
      available: sum(balance.available ?? []),
      pending: sum(balance.pending ?? []),
      lastPayout: next
        ? {
            amount: next.amount,
            currency: next.currency,
            status: next.status,
            // `arrival_date` is seconds, and it is an ESTIMATE from Stripe —
            // labelled as such in the UI rather than presented as a promise.
            arrivalDate: next.arrival_date ? next.arrival_date * 1000 : null,
          }
        : null,
    };
  } catch (e) {
    // A balance we cannot fetch must not take the tab down. It is returned,
    // not thrown, and the page shows it with a retry beside the embedded
    // components, which may still work (#436). Stripe's reason goes to the
    // server log, where somebody who can act on it reads it; the owner gets
    // BALANCE_UNAVAILABLE (#922).
    log("[stripe-balance] Stripe refused the balance read", {
      orgId,
      account: maskAccount(acct.accountId),
      collectedByParent: acct.collectedByParent,
      ...describeStripeError(e),
    });
    return { connected: true as const, error: BALANCE_UNAVAILABLE };
  }
}
