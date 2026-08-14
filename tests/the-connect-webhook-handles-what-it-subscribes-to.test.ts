import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const CONNECT = readFileSync("src/routes/api/public/hooks/stripe.ts", "utf8");
const PLATFORM = readFileSync("src/routes/api/public/hooks/platform-stripe.ts", "utf8");

// Two failure modes, both silent, both live in this one file.
//
// 1. SUBSCRIBED BUT UNHANDLED. The Stripe dashboard decides which events are
//    delivered; this file decides which are acted on. Nothing connects the two,
//    so an event can be enabled in the dashboard for months while the handler
//    that was supposed to read it does not exist — the endpoint returns 200 and
//    everything looks healthy. The live Connect endpoint currently enables
//    eleven events; the ones that MUST have a handler are pinned below.
//
// 2. THE WRONG ACCOUNT'S CREDENTIALS. These two endpoints belong to different
//    Stripe roles — the Connect platform that owns the connected accounts, and
//    the account that bills HoundStack subscriptions. They may be the same
//    account today and separate tomorrow. Both used to fall back to the
//    platform vars, which under a split silently authenticates against an
//    account that owns none of these connected accounts (every lookup misses)
//    and verifies signatures with the wrong secret (every event rejected as if
//    forged). Neither errors. Both return 200.

describe("every event the Connect endpoint subscribes to has a handler", () => {
  it.each([
    ["payment_intent.succeeded", "the invoice is never marked paid"],
    ["payment_intent.payment_failed", "a decline is never recorded and dunning never runs"],
    ["charge.refunded", "the refund and our fee reversal never happen"],
    ["charge.dispute.created", "a dispute never reaches the review queue"],
    ["account.updated", "charge-readiness and the surcharge's merchant state go stale"],
    [
      "account.application.deauthorized",
      "a tenant who disconnects from their own Stripe dashboard stays marked charges-enabled forever, and every charge fails at the API with nothing explaining why",
    ],
    [
      "setup_intent.succeeded",
      "a card saved at Stripe is never recorded here when the browser goes away mid-flow, so autopay silently never runs",
    ],
  ])("handles %s — without it, %s", (eventType) => {
    expect(CONNECT).toContain(`event.type === "${eventType}"`);
  });
});

// ── AND THE SAME THING, FOR THE ENDPOINT NOBODY PINNED ────────────────────
//
// Failure mode 1 above was written about the Connect endpoint and only ever
// enforced there. The platform endpoint had exactly one assertion — that its
// webhook secret has no fallback — and nothing checked which events it acts on.
//
// Read from the live account on 2026-08-14, endpoint
// we_1U0SFdQjJFmqXgZD3yF8GRzZ enables THIRTEEN events. Twelve had a `case`.
// `charge.refunded` did not, and the switch has no `default`, so it was
// recorded, stamped processed_at, and answered 200 — the healthy-looking
// silence this whole file exists to prevent. A refunded HoundStack
// subscription charge stayed counted as collected revenue, because Stripe
// leaves `invoice.amount_paid` at its full amount and puts the money coming
// back on the charge instead.
//
// The list below is the live endpoint's `enabled_events`, verbatim. It is the
// thing that drifts: somebody enables an event in the dashboard and no code
// changes, or somebody deletes a handler and no dashboard changes. Either way
// this fails.
describe("every event the platform endpoint subscribes to has a handler", () => {
  it.each([
    ["invoice.created", "the invoice never appears in billing history"],
    ["invoice.finalized", "the amount owed is never recorded"],
    ["invoice.paid", "the org is never marked active and revenue is never counted"],
    [
      "invoice.payment_failed",
      "a decline never moves the org to past_due and dunning never starts",
    ],
    ["invoice.voided", "a voided invoice still reads as owed"],
    ["invoice.marked_uncollectible", "a written-off invoice still reads as collectable"],
    ["customer.subscription.created", "the org's plan and renewal date are never recorded"],
    ["customer.subscription.updated", "a plan change or lapse never reaches the org row"],
    ["customer.subscription.deleted", "a cancelled plan keeps its entitlements for ever"],
    [
      "customer.subscription.trial_will_end",
      "the trial-ending warning is never sent and the card is charged unannounced",
    ],
    ["customer.created", "nothing — the customer→org mapping is written at checkout"],
    ["customer.updated", "nothing — the customer→org mapping is written at checkout"],
  ])("handles %s — without it, %s", (eventType) => {
    expect(PLATFORM).toContain(`case "${eventType}"`);
  });

  // ── KNOWN GAP ───────────────────────────────────────────────────────────
  //
  // `charge.refunded` is the thirteenth enabled event and has NO handler. It
  // is recorded here rather than quietly dropped from the list above, because
  // a list that only contains what is already done cannot tell you what is
  // missing — the same reason scripts/dead-machinery-baseline.json calls
  // itself "a record of decisions, not a mute button".
  //
  // The consequence, unfixed: a refunded HoundStack subscription charge stays
  // counted as collected revenue, because Stripe leaves `invoice.amount_paid`
  // at its full amount and puts the money coming back on the charge. The
  // customer who was refunded also sees the invoice paid in full in
  // Settings → Billing.
  //
  // Why it is not simply written: at the pinned API version (2026-07-29.dahlia)
  // `Charge` has NO `invoice` field — only `payment_intent` — and `PaymentIntent`
  // has no `invoice` either. The modern link runs Invoice → `payments[]` →
  // `payment.payment_intent`, i.e. from the invoice outward, which is the wrong
  // direction for a handler that starts from a charge. Getting it right needs
  // either the payment intent stored on `platform_invoices` when the invoice
  // row is written, or a bounded invoice lookup at refund time — and the live
  // platform account has ZERO invoices, so neither the payload shape nor the
  // fix can be verified against real data yet.
  //
  // The half that IS shipped: `platform_invoices.refunded_cents` /
  // `refunded_at` exist, `collectedNetCents` nets them into both the headline
  // figure and the twelve-month chart, and Settings → Billing renders the
  // contra line. Everything is ready for the handler; only the handler is
  // missing, and it reads 0 until one exists.
  it("records charge.refunded as an unhandled event rather than hiding it", () => {
    const enabledOnTheLiveEndpoint = 13;
    const handled = [...PLATFORM.matchAll(/case "([a-z_]+\.[a-z_.]+)"/g)].map((m) => m[1]);
    expect(new Set(handled).size).toBe(enabledOnTheLiveEndpoint - 1);
    expect(handled).not.toContain("charge.refunded");
  });
});

describe("each endpoint uses its own account's credentials, with no fallback", () => {
  it("the Connect endpoint reads only the CONNECT key and secret", () => {
    expect(CONNECT).toContain("process.env.STRIPE_CONNECT_SECRET_KEY");
    expect(CONNECT).toContain("process.env.STRIPE_CONNECT_WEBHOOK_SECRET");
    // The whole point: no `?? process.env.STRIPE_SECRET_KEY` and no
    // `?? process.env.STRIPE_WEBHOOK_SECRET` anywhere in the credential setup.
    expect(CONNECT).not.toMatch(/STRIPE_CONNECT_SECRET_KEY\s*\?\?/);
    expect(CONNECT).not.toMatch(/STRIPE_CONNECT_WEBHOOK_SECRET\s*\?\?/);
    expect(CONNECT).not.toContain("process.env.STRIPE_WEBHOOK_SECRET");
  });

  it("the platform endpoint reads only the platform webhook secret", () => {
    expect(PLATFORM).toContain("process.env.PLATFORM_STRIPE_WEBHOOK_SECRET");
    expect(PLATFORM).not.toMatch(/PLATFORM_STRIPE_WEBHOOK_SECRET\s*\?\?/);
  });

  it("neither endpoint borrows the other's credentials", () => {
    // The Connect endpoint must not reach for the subscription account's key.
    const credentialSetup = CONNECT.slice(0, CONNECT.indexOf("const signature"));
    expect(credentialSetup).not.toContain("STRIPE_SECRET_KEY");
  });
});

/** The deauthorization branch alone — bounded at its own `return`, so this does
 *  not silently start reading the next handler's code. */
function deauthorizeBranch(): string {
  const start = CONNECT.indexOf('event.type === "account.application.deauthorized"');
  expect(start).toBeGreaterThan(-1);
  const end = CONNECT.indexOf('return new Response("ok", { status: 200 });', start);
  expect(end).toBeGreaterThan(start);
  return CONNECT.slice(start, end);
}

describe("the deauthorization handler keys on the only trustworthy field", () => {
  it("matches the org by event.account, never by metadata", () => {
    const branch = deauthorizeBranch();
    expect(branch).toContain('.eq("stripe_connect_account_id", event.account)');
    // Connect event metadata is fully controllable by the account that produced
    // it, so a handler that trusted it could let one tenant disconnect another.
    //
    // Matched as a property ACCESS (`.metadata`, `metadata?.`) rather than the
    // bare word: the branch's own comment explains why metadata is not consulted,
    // and a test that cannot tell prose from code fails on the explanation. This
    // repo has already shipped that exact mistake once — the app-origin guard's
    // comment-stripper ate the `//` inside a URL string, so the one host it
    // existed to forbid was the one it could not see.
    expect(branch).not.toMatch(/\.metadata\b|metadata\?\./);
  });

  it("keeps the account id rather than clearing it", () => {
    const branch = deauthorizeBranch();
    expect(branch).toContain("stripe_connect_charges_enabled: false");
    // Clearing the id would strand every saved card and customer that points at
    // it, and lose the record of which account had been connected.
    expect(branch).not.toMatch(/stripe_connect_account_id:\s*null/);
  });
});
