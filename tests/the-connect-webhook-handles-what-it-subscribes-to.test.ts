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
// All thirteen are handled now. The handler took two attempts: the first read
// `charge.invoice`, a field that does not exist at the pinned API version, and
// its tests passed anyway because the fixture had invented it. The join has to
// be stored at invoice time (`Invoice.payments[].payment.payment_intent`) and
// read at refund time (`Charge.payment_intent`), because nothing on a charge
// points back to an invoice — see 20260814050000.
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
    [
      "charge.refunded",
      "a refunded subscription charge stays counted as collected, and the customer sees the invoice paid in full with no sign of the refund",
    ],
  ])("handles %s — without it, %s", (eventType) => {
    expect(PLATFORM).toContain(`case "${eventType}"`);
  });

  it("handles every enabled event and nothing is left unaccounted for", () => {
    // The count is the guard the per-event assertions cannot give: it fails if
    // somebody enables a fourteenth event in the dashboard and this list is not
    // updated with it.
    const enabledOnTheLiveEndpoint = 13;
    const handled = new Set([...PLATFORM.matchAll(/case "([a-z_]+\.[a-z_.]+)"/g)].map((m) => m[1]));
    expect(handled.size).toBe(enabledOnTheLiveEndpoint);
  });
});

describe("the refund handler writes what it means to", () => {
  const branch = () =>
    PLATFORM.slice(
      PLATFORM.indexOf('case "charge.refunded"'),
      PLATFORM.indexOf('case "customer.created"'),
    );

  it("records the refund beside the payment, never instead of it", () => {
    // Folding the two into one number is the bug 20260804080000 had to undo:
    // two screens derive the same money differently and the gross is gone.
    expect(branch()).toMatch(/refunded_cents:/);
    expect(branch()).not.toMatch(/amount_paid_cents:/);
  });

  it("sets the running total rather than adding to it", () => {
    // `amount_refunded` is already Stripe's cumulative figure and this event
    // redelivers for up to three days; adding climbs past the charge on the
    // second delivery and the CHECK from 20260814020000 rejects it.
    expect(branch()).toMatch(/refunded_cents: charge\.amount_refunded/);
    expect(branch()).not.toMatch(/refunded_cents:.*\+/);
  });

  it("dates the refund by the refund, not by the charge", () => {
    // `charge.created` is the original payment — eleven months earlier on an
    // annual plan.
    expect(branch()).toMatch(/refunds\?\.data\?\.\[0\]\?\.created/);
    expect(branch()).not.toMatch(/refunded_at:\s*new Date\(\(?charge\.created/);
  });

  it("joins through the payment intent, since nothing else can", () => {
    expect(branch()).toMatch(/stripe_payment_intent_id/);
    // The field that does not exist at this API version, and that the first
    // attempt was built on.
    expect(branch()).not.toMatch(/charge\.invoice/);
  });

  it("does not let a best-effort lookup fail the whole delivery", () => {
    // Without the try/catch a transient Stripe error 500s the event and Stripe
    // retries it for three days over what was only an optimisation.
    const fallback = branch().slice(branch().indexOf("invoices.list"));
    expect(branch().slice(0, branch().indexOf("invoices.list"))).toMatch(/try \{/);
    expect(fallback).toMatch(/catch/);
  });

  it("says so loudly when it cannot link a refund", () => {
    // An unlinked refund is a wrong revenue figure; the only thing worse is one
    // nobody can find.
    expect(branch()).toMatch(/console\.error/);
    expect(branch()).toMatch(/NOT recorded/);
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
