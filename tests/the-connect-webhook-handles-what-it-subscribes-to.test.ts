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
