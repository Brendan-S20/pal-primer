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
// (we_1U0SFdQjJFmqXgZD3yF8GRzZ) was serialising events at `2026-07-29.dahlia`
// while the SDK then installed (22.3.0) typed every response against
// `2026-06-24.dahlia`. So `Stripe.Invoice`, `Stripe.Charge` and every other
// type the webhook handlers read described a DIFFERENT version than the one
// being delivered. Nothing fails at compile time — the payload arrives as JSON
// and is cast — so the only symptom would be a field renamed, moved or dropped
// between versions reading `undefined` at runtime, inside money code.
//
// ── HOW THE VERSION IS CHOSEN ─────────────────────────────────────────────
//
// The SDK decides, and the endpoints are matched to it — not the other way
// round. `StripeConfig.apiVersion` is a single string literal equal to the
// version whose response shapes that release models, so there is exactly one
// value that both compiles AND describes the JSON on the wire. Writing any
// other version means a cast, and Stripe's own doc comment on that field spells
// out what a cast costs: "add a @ts-ignore comment here and anywhere the types
// differ between API versions".
//
// So closing the drift was an SDK UPGRADE, 22.3.0 → 22.4.0, whose entire
// headline is "changes the pinned API version to 2026-07-29.dahlia" — the
// version the endpoints were already on. Requests and events now speak one
// version, the types describe it, and no endpoint had to be recreated (which
// would have minted a new signing secret and dropped billing events until it
// was pasted in).
//
// Upgraded again to 22.6.2 on 2026-10-30, whose headline moves the pinned
// version to 2026-08-26.dahlia. The constant below was bumped with it — the
// SDK decides the version, and the endpoints are matched to it.
//
// Upgrading again is a deliberate two-step change: bump the SDK, bump this
// constant. Skipping the second step does not compile — that is not a
// convention, it is the type below, and it fired for real on this very
// upgrade: TS2322, '2026-06-24.dahlia' is not assignable to
// '2026-07-29.dahlia'. It fired again on the 22.6.2 upgrade: TS2322,
// '2026-07-29.dahlia' is not assignable to '2026-08-26.dahlia'. If a future
// SDK moves ahead of the endpoints, the runtime warning further down is what
// says so.

import type Stripe from "stripe";

/**
 * The API version every request and every webhook endpoint speaks.
 *
 * Tied to the installed SDK on purpose: the SDK's own literal is the version
 * whose response shapes its types describe. If the SDK is upgraded and this is
 * not, the compiler says so — which is the entire point of typing it against
 * the package rather than writing a string nobody checks.
 */
export const STRIPE_API_VERSION: PinnedApiVersion = "2026-08-26.dahlia";

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
 * The endpoints and this build agree today. This is here because they can stop
 * agreeing WITHOUT anyone editing this repo: an endpoint's api_version is fixed
 * at CREATION — Stripe rejects it on update ("Received unknown parameter:
 * api_version") — so a new endpoint added from the dashboard, or a future SDK
 * bump moving this constant ahead of the live endpoints, reintroduces the gap
 * silently. Outbound calls stay pinned either way; inbound events are whatever
 * the endpoint was born as.
 *
 * Without this the only symptom is a field renamed between versions reading
 * `undefined`, in money code, with no error anywhere.
 *
 * Deliberately NOT a rejection. Refusing the event would turn a field-shape
 * risk into guaranteed dropped billing events, and Stripe would retry a
 * delivery that can never succeed.
 */
export function warnOnApiVersionMismatch(event: { id: string; api_version: string | null }): void {
  if (!event.api_version || event.api_version === STRIPE_API_VERSION) return;
  console.warn(
    `stripe webhook ${event.id} was serialised at ${event.api_version} but this build reads ` +
      `${STRIPE_API_VERSION}. Fields that moved between the two will read undefined. An ` +
      `endpoint's api_version cannot be changed after creation, so closing this means either ` +
      `recreating the endpoint at ${STRIPE_API_VERSION} (new signing secret) or moving the SDK ` +
      `to the version the endpoint speaks.`,
  );
}
