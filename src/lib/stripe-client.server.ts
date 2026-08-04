// The one place a Stripe client is constructed.
//
// ── WHY THIS EXISTS ───────────────────────────────────────────────────────
//
// There were THIRTEEN `new Stripe(secret)` calls across nine modules and not
// one of them passed `apiVersion`. Unpinned means "whatever version this
// account happens to be on", which is a value that can change from the Stripe
// dashboard, by Stripe's own migration schedule, or by a colleague clicking
// upgrade — with no deploy, no diff, and no failing test.
//
// It had already drifted. The live platform webhook endpoint
// (we_1U0SFdQjJFmqXgZD3yF8GRzZ) was sending `2026-07-29.dahlia` while the
// installed SDK (22.3.0) types every response against `2026-06-24.dahlia`:
//
//     node_modules/stripe/esm/apiVersion.d.ts
//     export declare const ApiVersion = "2026-06-24.dahlia";
//
// So `Stripe.Invoice`, `Stripe.Charge` and every other type the webhook handler
// reads described a DIFFERENT version than the one being delivered. Nothing
// fails at compile time — the payload arrives as JSON and is cast — so the only
// symptom would be a field that is renamed, moved or dropped between versions
// reading `undefined` at runtime, inside money code, in production.
//
// ── WHY 2026-06-24 AND NOT 2026-07-29 ─────────────────────────────────────
//
// Because the SDK is the thing that has to be right. Its own type is
//
//     apiVersion?: LatestApiVersion;   // = "2026-06-24.dahlia"
//
// — a single string literal. `2026-07-29.dahlia` does not typecheck, and
// forcing it with a cast would be asserting agreement with a version whose
// response shapes this SDK does not model. Pinning to the SDK's version means
// the types in the editor and the JSON on the wire describe the same API.
//
// The webhook endpoints were moved to match, so requests and events now speak
// one version. Upgrading is a deliberate three-step change — bump the SDK,
// bump this constant, bump the endpoints — and the guard test makes skipping a
// step visible.

import type Stripe from "stripe";

/**
 * The API version every request and every webhook endpoint speaks.
 *
 * Tied to the installed SDK on purpose: `Stripe.LatestApiVersion` is the
 * version whose response shapes these types describe. If the SDK is upgraded
 * and this is not, the compiler says so — which is the entire point of not
 * writing the string out by hand.
 */
export const STRIPE_API_VERSION: PinnedApiVersion = "2026-06-24.dahlia";

/**
 * The SDK's own `apiVersion` type, read off the constructor rather than
 * imported by name.
 *
 * `Stripe.LatestApiVersion` is NOT on the namespace — it lives in the package's
 * internal `lib.d.ts` — so naming it directly does not compile. Deriving it
 * from the constructor signature reaches the same single string literal without
 * reaching into the package's internals, and it is what makes the constant
 * above fail to build the moment the SDK is upgraded and this file is not.
 */
type PinnedApiVersion = NonNullable<
  NonNullable<ConstructorParameters<typeof import("stripe").default>[1]>["apiVersion"]
>;

/**
 * A Stripe client pinned to {@link STRIPE_API_VERSION}.
 *
 * Every caller goes through here — platform and Connect alike. They differ by
 * SECRET, never by version: a Connect client reading one version's payloads
 * while the platform reads another is the same split this module exists to
 * stop, and it would show up as a money bug rather than an error.
 */
export async function makeStripe(secret: string): Promise<Stripe> {
  // Dynamic, and the import is type-only above, so the SDK never reaches a
  // client bundle — the pattern every call site already used and the reason
  // this file could not simply `import Stripe from "stripe"` at the top.
  const Stripe = (await import("stripe")).default;
  return new Stripe(secret, { apiVersion: STRIPE_API_VERSION });
}

/**
 * Say so, loudly, when a delivered event was serialised against a different
 * API version than this code reads.
 *
 * Outbound calls are pinned by {@link makeStripe}, but INBOUND events are
 * serialised at whatever version the webhook endpoint was CREATED with, and
 * Stripe does not allow that to be changed afterwards — closing the gap means
 * recreating the endpoint, which mints a new signing secret and therefore needs
 * a human. Until then the mismatch is real and this is what makes it visible:
 * otherwise the only symptom is a field renamed between versions reading
 * `undefined`, silently, in money code.
 *
 * Deliberately NOT a rejection. Refusing the event would turn a field-shape
 * risk into guaranteed dropped billing events, and Stripe would retry a
 * delivery that can never succeed.
 */
export function warnOnApiVersionMismatch(event: { id: string; api_version: string | null }): void {
  if (!event.api_version || event.api_version === STRIPE_API_VERSION) return;
  console.warn(
    `stripe webhook ${event.id} was serialised at ${event.api_version} but this build reads ` +
      `${STRIPE_API_VERSION}. Fields that moved between the two will read undefined. Recreate ` +
      `the endpoint at ${STRIPE_API_VERSION} and update its signing secret.`,
  );
}
