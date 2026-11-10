// The Stripe controller settings a business's NEW connected account is
// created with (#825). Client-safe: the Payments page reads the fee payer to
// say who Stripe bills, and stripe-connect.server.ts creates accounts from it.
/**
 * Who carries what on a connected account created from #825 on.
 *
 * Brendan, 2026-11-10, 1:57 AM ET: "Make new businesses liable, if Stripe
 * allows". Stripe allows it, generally available, with its Standard
 * configuration (docs.stripe.com/connect/migrate-to-controller-properties):
 *
 *   losses.payments "stripe"        the business, through Stripe, is liable
 *                                   for refunds, disputes and negative
 *                                   balances; the platform holds no reserve
 *                                   for it (the -$2.04 on #825);
 *   fees.payer "account"            Stripe bills its fees, processing, Radar
 *                                   and the Tap to Pay fee included, to the
 *                                   business directly, so the pass-throughs
 *                                   in radar-fee.ts and tap-to-pay.server.ts
 *                                   add nothing for these accounts;
 *   requirement_collection "stripe" Stripe still collects KYC;
 *   stripe_dashboard "full"         the business gets a full Stripe
 *                                   Dashboard at dashboard.stripe.com, not
 *                                   the Express Dashboard.
 *
 * The Express Dashboard with losses.payments "stripe" exists only as a public
 * preview that needs a preview API version (docs.stripe.com/connect/
 * risk-management/managed-risk); this platform does not run a preview
 * version, so that combination is deliberately not used.
 *
 * Written as explicit controller properties rather than `type: "standard"`,
 * so what the business carries is readable here and pinned by a test, and a
 * `type` mapping that Stripe changes cannot change it silently.
 */
export const NEW_CONNECTED_ACCOUNT_CONTROLLER = {
  fees: { payer: "account" },
  losses: { payments: "stripe" },
  requirement_collection: "stripe",
  stripe_dashboard: { type: "full" },
} as const;

/** The fee payer a new account gets, for copy that has to say who Stripe bills. */
export const NEW_CONNECTED_ACCOUNT_FEE_PAYER: string = NEW_CONNECTED_ACCOUNT_CONTROLLER.fees.payer;
