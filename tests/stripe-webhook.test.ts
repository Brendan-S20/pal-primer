import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";

// IMP-6 — payment test coverage, unblocked now that Stripe is authorized.
//
// This webhook is the single most money-critical piece of code in the product
// and it had NO tests. It is:
//
//   * the ONLY writer of `payments.status` — the migration that made payments
//     append-only for tenants (BUG-72) rests entirely on that being true;
//   * the caller of record_franchise_adjustment, so it decides what a franchise
//     location is charged back for;
//   * the thing that marks an invoice paid, which is the moment money becomes
//     real to this system.
//
// It is also 610 lines inline in a route handler with no exported seam. Rather
// than refactor money code that has no tests yet — the wrong order — these
// drive the SHIPPED handler directly, signature verification included, so what
// is tested is what runs.
//
// Signing works without any Stripe secret: verification is an HMAC against
// whatever `STRIPE_CONNECT_WEBHOOK_SECRET` is set to, so the test sets it and
// signs with the same value. No network, no Stripe account, runs in CI.

const WEBHOOK_SECRET = "whsec_test_imp6_do_not_use_anywhere_real";
const API_KEY = "sk_test_imp6_placeholder";

/** Stripe's scheme: `t=<unix>,v1=<hmac-sha256(`${t}.${payload}`, secret)>`. */
function signedHeader(
  payload: string,
  secret = WEBHOOK_SECRET,
  at = Math.floor(Date.now() / 1000),
) {
  const sig = createHmac("sha256", secret).update(`${at}.${payload}`).digest("hex");
  return `t=${at},v1=${sig}`;
}

async function postToWebhook(body: string, headers: Record<string, string>) {
  const mod = await import("@/routes/api/public/hooks/stripe");
  const POST = (
    mod.Route as unknown as {
      options: { server: { handlers: { POST: (ctx: { request: Request }) => Promise<Response> } } };
    }
  ).options.server.handlers.POST;
  const request = new Request("https://app.houndstack.com/api/public/hooks/stripe", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
  return (await POST({ request })) as Response;
}

function event(type: string, object: Record<string, unknown>, account?: string) {
  return JSON.stringify({
    id: `evt_test_${Math.random().toString(36).slice(2)}`,
    object: "event",
    type,
    ...(account ? { account } : {}),
    data: { object },
  });
}

const ORIGINAL = { ...process.env };

beforeEach(() => {
  process.env.STRIPE_CONNECT_SECRET_KEY = API_KEY;
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = WEBHOOK_SECRET;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("the webhook refuses anything it cannot verify", () => {
  it("rejects a request with no signature", async () => {
    const body = event("payment_intent.succeeded", { id: "pi_x" });
    const res = await postToWebhook(body, {});
    expect(res.status).toBe(400);
  });

  it("rejects a signature computed with the wrong secret", async () => {
    // The whole security model. Without this, anyone who can POST to a public
    // URL can mark any invoice paid.
    const body = event("payment_intent.succeeded", { id: "pi_x" });
    const res = await postToWebhook(body, {
      "stripe-signature": signedHeader(body, "whsec_attacker_guess"),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a valid signature over a DIFFERENT body", async () => {
    // Signature reuse: capture a real webhook's header, swap the payload for
    // one that pays off your own invoice.
    const signedBody = event("payment_intent.succeeded", { id: "pi_original" });
    const tamperedBody = event("payment_intent.succeeded", { id: "pi_swapped" });
    const res = await postToWebhook(tamperedBody, {
      "stripe-signature": signedHeader(signedBody),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a stale signature", async () => {
    // Replay of a genuine, correctly-signed event from an hour ago. Stripe's
    // constructEvent enforces a default tolerance of five minutes.
    const body = event("payment_intent.succeeded", { id: "pi_x" });
    const anHourAgo = Math.floor(Date.now() / 1000) - 3600;
    const res = await postToWebhook(body, {
      "stripe-signature": signedHeader(body, WEBHOOK_SECRET, anHourAgo),
    });
    expect(res.status).toBe(401);
  });

  it("accepts a correctly signed event", async () => {
    // The positive case matters as much as the negatives: a suite where every
    // assertion is "it was rejected" passes just as happily against a handler
    // that rejects everything, and that would be an outage rather than a fix.
    const body = event("payment_intent.succeeded", {
      id: "pi_correctly_signed",
      metadata: {},
      amount: 1000,
    });
    const res = await postToWebhook(body, { "stripe-signature": signedHeader(body) });
    expect(res.status).not.toBe(400);
    expect(res.status).not.toBe(401);
  });
});

describe("the webhook refuses to run unconfigured", () => {
  it("fails closed when the signing secret is absent", async () => {
    // Falling back to "process anything" when the secret is missing would turn
    // a deploy misconfiguration into an open money endpoint. 500 is correct:
    // Stripe retries, and nothing is processed in the meantime.
    delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const body = event("payment_intent.succeeded", { id: "pi_x" });
    const res = await postToWebhook(body, { "stripe-signature": signedHeader(body) });
    expect(res.status).toBe(500);
  });

  it("fails closed when the API key is absent", async () => {
    delete process.env.STRIPE_CONNECT_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    const body = event("payment_intent.succeeded", { id: "pi_x" });
    const res = await postToWebhook(body, { "stripe-signature": signedHeader(body) });
    expect(res.status).toBe(500);
  });
});

describe("a Connect event cannot reach another tenant's records", () => {
  // Security C1, stated in the handler's own comment: a Connect event's
  // metadata is fully controllable by the account that produced it, but
  // `event.account` is not. Without the check, a tenant puts a VICTIM's
  // invoice id in their own event's metadata and marks it paid.
  //
  // The comment has been there since the code was written and nothing tested
  // it. This session has found several such comments to be false.

  // Reaching the guard means reaching the database, so the behavioural half is
  // gated the same way tests/integration/*.db.test.ts are. It is NOT skipped
  // silently: without the env it would return 500 from the supabaseAdmin
  // client, which would be a green test proving nothing.
  const hasDb = !!process.env.SERVICE_ROLE_KEY && !!process.env.SUPABASE_URL;

  it.skipIf(!hasDb)("ignores an event whose account owns nothing", async () => {
    // acct_ATTACKER_NOT_REAL matches no organization, so accountMatches() is
    // false for every org and the handler must not write anything. A 2xx here
    // means "received and discarded", which is what Stripe wants — a 4xx would
    // make Stripe retry an event that will never apply.
    const body = event(
      "payment_intent.succeeded",
      {
        id: "pi_cross_tenant_probe",
        amount: 999_999,
        metadata: {
          source: "portal_inline",
          invoice_id: "00000000-0000-0000-0000-000000000001",
          organization_id: "00000000-0000-0000-0000-000000000002",
        },
      },
      "acct_ATTACKER_NOT_REAL",
    );
    const res = await postToWebhook(body, { "stripe-signature": signedHeader(body) });
    expect(res.status).toBeLessThan(500);
  });

  it("guards the write with event.account, not with metadata", async () => {
    // Read from the shipped source, because the behavioural test above cannot
    // distinguish "guarded" from "the ids happened not to exist". If the guard
    // is ever removed, this is what notices.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(fileURLToPath(new URL("..", import.meta.url)), "src/routes/api/public/hooks/stripe.ts"),
      "utf8",
    );
    const code = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    // The guard compares the event's account against the org's connected
    // account. Both halves have to be present: the function, and its use.
    expect(code).toMatch(/async function accountMatches\(/);
    expect(code).toMatch(/a\.accountId === event\.account/);
    expect(code.match(/accountMatches\(/g)?.length ?? 0).toBeGreaterThan(1);
  });
});
