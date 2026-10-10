// The real makeStripe, counted. Every client the app makes and every HTTP
// request it sends are tallied on globalThis.__releaseGate, so "refused before
// any Stripe call" is a measurement.
import * as real from "../../../src/lib/stripe-client.server.ts";

export const STRIPE_API_VERSION = real.STRIPE_API_VERSION;
export const warnOnApiVersionMismatch = real.warnOnApiVersionMismatch;

export async function makeStripe(secret) {
  const g = globalThis.__releaseGate;
  g.makeStripeCalls += 1;
  const stripe = await real.makeStripe(secret);
  stripe.on("request", () => {
    g.stripeRequests += 1;
  });
  return stripe;
}
