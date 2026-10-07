import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createFakeAdmin, stripeSignature } from "./helpers/fake-supabase";
import { modelCountAutopayDecline } from "./helpers/count-autopay-decline-model";
import { repoRelative } from "./support/repo-paths";

// One decline counts once.
//
// `clients.autopay_failure_count` decides when a client's autopay pauses: at
// the org's `dunning_pause_after_failures` declines. Until 2026-10-07 one
// declined charge could be counted several times over:
//
//   * the webhook added one on EVERY delivery of payment_intent.payment_failed,
//     and Stripe redelivers any event it was not answered 200 for in time;
//   * the nightly autopay run's catch block added one for the charge it had
//     just made, and Stripe then reported that same PaymentIntent to the
//     webhook, which added another.
//
// So autopay paused after as few as half the declines the business set. Now
// the count belongs to count_autopay_decline, idempotent per PaymentIntent;
// the webhook reports every saved-card decline to it, and the nightly run
// reports only a failure that never reached Stripe.
//
// Driven through the SHIPPED webhook handler and the nightly run's own catch
// handler (recordNightlyAutopayFailure), with a fake service-role client and a
// model of the SQL function (tests/helpers/count-autopay-decline-model.ts). The
// SQL is proved against a real Postgres by
// tests/one-decline-counts-once-in-a-real-database.test.ts.

const WEBHOOK_SECRET = "whsec_test_one_decline_do_not_use_anywhere_real";
const ORG = "11111111-1111-1111-1111-111111111111";
const INVOICE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CLIENT = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const ACCOUNT = "acct_one_decline";

const fake = createFakeAdmin();
modelCountAutopayDecline(fake);

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, p) => fake.admin[p as keyof typeof fake.admin] }),
}));
vi.mock("@/lib/stripe-connect.server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveOrgStripeAccount: async (orgId: string) => (orgId === ORG ? { accountId: ACCOUNT } : null),
  collectingOrgIdFor: async (orgId: string) => orgId,
}));
vi.mock("@/lib/activity.server", () => ({ logActivity: async () => {} }));
vi.mock("@/lib/email/enqueue.server", () => ({ enqueueAppEmail: async () => {} }));
const officeNotices: Array<Record<string, unknown>> = [];
vi.mock("@/lib/notify-center.server", () => ({
  notifyRoles: async (_roles: string[], n: Record<string, unknown>) => {
    officeNotices.push(n);
  },
}));

async function deliver(
  type: "payment_intent.payment_failed" | "payment_intent.succeeded",
  object: Record<string, unknown>,
  eventId = `evt_${Math.random().toString(36).slice(2)}`,
) {
  const body = JSON.stringify({
    id: eventId,
    object: "event",
    type,
    account: ACCOUNT,
    created: Math.floor(Date.now() / 1000),
    data: { object },
  });
  const mod = await import("@/routes/api/public/hooks/stripe");
  const POST = (
    mod.Route as unknown as {
      options: { server: { handlers: { POST: (ctx: { request: Request }) => Promise<Response> } } };
    }
  ).options.server.handlers.POST;
  return (await POST({
    request: new Request("https://app.houndstack.com/api/public/hooks/stripe", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": stripeSignature(body, WEBHOOK_SECRET),
      },
      body,
    }),
  })) as Response;
}

/** An autopay charge of $85.00 that the card declined. */
const declinedPi = (id: string, source = "autopay") => ({
  id,
  amount: 8_500,
  currency: "usd",
  status: "requires_payment_method",
  metadata: { source, invoice_id: INVOICE, organization_id: ORG },
  last_payment_error: { code: "card_declined", message: "Your card was declined." },
});

/** Stripe reports a decline. Asserts it was answered 200, as Stripe needs. */
async function stripeReportsDecline(id: string, eventId?: string, source?: string) {
  const res = await deliver("payment_intent.payment_failed", declinedPi(id, source), eventId);
  expect(res.status).toBe(200);
}

/** What `stripe.paymentIntents.create({ confirm: true })` throws when the card
 *  declines: a StripeCardError carrying the failed PaymentIntent. */
const cardErrorFor = (piId: string) =>
  Object.assign(new Error("Your card was declined."), {
    type: "StripeCardError",
    code: "card_declined",
    payment_intent: { id: piId, object: "payment_intent", status: "requires_payment_method" },
  });

async function nightlyCatch(error: unknown) {
  const { recordNightlyAutopayFailure } = await import("@/lib/autopay-decline.server");
  return recordNightlyAutopayFailure(fake.admin, { clientId: CLIENT, error });
}

const client = () => fake.tables.clients[0];
const countCalls = () => fake.rpcs.filter((r) => r.fn === "count_autopay_decline");

beforeAll(async () => {
  await import("@/integrations/supabase/client.server");
  await import("@/routes/api/public/hooks/stripe");
  await import("@/lib/autopay-decline.server");
});

beforeEach(() => {
  process.env.STRIPE_CONNECT_SECRET_KEY = "sk_test_one_decline_placeholder";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = WEBHOOK_SECRET;
  officeNotices.length = 0;
  fake.reset({
    organizations: [
      {
        id: ORG,
        name: "Detroit Doo Disposal",
        notify_sms_payment_failed: false,
        dunning_pause_after_failures: 3,
      },
    ],
    invoices: [
      {
        id: INVOICE,
        organization_id: ORG,
        client_id: CLIENT,
        number: 1042,
        total_cents: 8_500,
        currency: "usd",
        status: "open",
      },
    ],
    clients: [
      {
        id: CLIENT,
        organization_id: ORG,
        display_name: "Pat Rivera",
        autopay_enabled: true,
        autopay_paused: false,
        autopay_failure_count: 0,
        autopay_counted_decline_pis: [],
      },
    ],
    payments: [],
  });
});

describe("one declined charge is one decline", () => {
  it("counts once when Stripe delivers it three times", async () => {
    for (let i = 0; i < 3; i++) await stripeReportsDecline("pi_thrice", "evt_thrice");
    expect(client().autopay_failure_count).toBe(1);
    expect(client().autopay_paused).toBe(false);
    // Every delivery asked, keyed on the PaymentIntent; only the first counted.
    expect(countCalls().map((c) => c.args._payment_intent_id)).toEqual([
      "pi_thrice",
      "pi_thrice",
      "pi_thrice",
    ]);
  });

  it("counts once when the nightly run saw it decline and then Stripe reported it", async () => {
    // The nightly run's charge throws first: it is the caller of create().
    expect(await nightlyCatch(cardErrorFor("pi_both"))).toBe("reported_by_webhook");
    await stripeReportsDecline("pi_both");
    expect(client().autopay_failure_count).toBe(1);
    // The nightly run asked nothing of the counter: the webhook owns this one.
    expect(countCalls()).toHaveLength(1);
  });

  it("counts once in the other order too, and on a redelivery after both", async () => {
    await stripeReportsDecline("pi_other_order", "evt_other_order");
    await nightlyCatch(cardErrorFor("pi_other_order"));
    await stripeReportsDecline("pi_other_order", "evt_other_order");
    expect(client().autopay_failure_count).toBe(1);
  });

  it("tells the office once, not once per delivery", async () => {
    for (let i = 0; i < 3; i++) await stripeReportsDecline("pi_notice", "evt_notice");
    expect(officeNotices).toHaveLength(1);
    expect(officeNotices[0]).toMatchObject({ orgId: ORG, type: "payment_failed" });
  });
});

describe("distinct declines", () => {
  it("count twice", async () => {
    await stripeReportsDecline("pi_first");
    await stripeReportsDecline("pi_second");
    expect(client().autopay_failure_count).toBe(2);
    expect(officeNotices).toHaveLength(2);
  });

  it("pause autopay exactly at the configured number, however often each is reported", async () => {
    fake.tables.organizations[0].dunning_pause_after_failures = 4;
    for (let n = 1; n <= 4; n++) {
      const pi = `pi_ladder_${n}`;
      // Each decline reported the way production reports one: the nightly
      // run's catch, then Stripe's event, then a redelivery of it.
      await nightlyCatch(cardErrorFor(pi));
      await stripeReportsDecline(pi, `evt_ladder_${n}`);
      await stripeReportsDecline(pi, `evt_ladder_${n}`);
      expect(client().autopay_failure_count, `after decline ${n}`).toBe(n);
      expect(client().autopay_paused, `after decline ${n}`).toBe(n >= 4);
    }
  });

  it("count on the portal's saved card too, and not on a staff charge or a pay-form typo", async () => {
    await stripeReportsDecline("pi_portal", undefined, "portal_saved_card");
    await stripeReportsDecline("pi_staff", undefined, "staff_saved_card");
    await stripeReportsDecline("pi_typo", undefined, "portal_inline");
    expect(client().autopay_failure_count).toBe(1);
  });
});

describe("a successful payment", () => {
  it("resets the ladder, and an old decline redelivered after it does not restart it", async () => {
    await stripeReportsDecline("pi_before_1", "evt_before_1");
    await stripeReportsDecline("pi_before_2");
    expect(client().autopay_failure_count).toBe(2);

    const res = await deliver("payment_intent.succeeded", {
      id: "pi_paid",
      amount: 8_500,
      currency: "usd",
      status: "succeeded",
      metadata: { source: "autopay", invoice_id: INVOICE, organization_id: ORG },
    });
    expect(res.status).toBe(200);
    expect(client().autopay_failure_count).toBe(0);
    expect(client().autopay_paused).toBe(false);

    await stripeReportsDecline("pi_before_1", "evt_before_1");
    expect(client().autopay_failure_count).toBe(0);
  });
});

describe("the nightly run counts only what no webhook will report", () => {
  it("does not count a network failure or a Stripe 5xx: not a decline, and maybe not even an answer", async () => {
    for (const type of ["StripeConnectionError", "StripeAPIError", "StripeRateLimitError"]) {
      const e = Object.assign(new Error("An error occurred with our connection to Stripe."), {
        type,
      });
      expect(await nightlyCatch(e)).toBe("transient");
    }
    expect(countCalls()).toHaveLength(0);
    expect(client().autopay_failure_count).toBe(0);
    // It is still shown: the Billing tab reads the last error.
    expect(client().autopay_last_error).toMatch(/connection to Stripe/);
  });

  it("counts a failure Stripe refused before making a PaymentIntent, once per attempt", async () => {
    const refused = Object.assign(new Error("Amount must be at least $0.50 usd"), {
      type: "StripeInvalidRequestError",
      code: "amount_too_small",
    });
    expect(await nightlyCatch(refused)).toBe("never_reached_stripe");
    expect(await nightlyCatch(new Error("fee quote failed"))).toBe("never_reached_stripe");
    expect(client().autopay_failure_count).toBe(2);
    expect(countCalls().map((c) => c.args._payment_intent_id)).toEqual([null, null]);
  });

  it("reads the PaymentIntent off the raw error as well as the error", async () => {
    const { paymentIntentIdOf } = await import("@/lib/autopay-decline.server");
    expect(paymentIntentIdOf(cardErrorFor("pi_a"))).toBe("pi_a");
    expect(paymentIntentIdOf({ raw: { payment_intent: { id: "pi_b" } } })).toBe("pi_b");
    expect(paymentIntentIdOf({ payment_intent: "pi_c" })).toBe("pi_c");
    expect(paymentIntentIdOf(new Error("no intent"))).toBeNull();
    expect(paymentIntentIdOf(null)).toBeNull();
  });
});

describe("the webhook cannot lose a decline", () => {
  it("answers 500 when the counter refuses, so Stripe redelivers, and the redelivery counts once", async () => {
    const realRpc = fake.admin.rpc;
    let refuse = true;
    fake.admin.rpc = async (fn, args) => {
      if (fn === "count_autopay_decline" && refuse) {
        refuse = false;
        return { data: null, error: { message: "function does not exist" } } as never;
      }
      return realRpc(fn, args);
    };
    try {
      const first = await deliver("payment_intent.payment_failed", declinedPi("pi_retry"), "evt_r");
      expect(first.status).toBe(500);
      expect(client().autopay_failure_count).toBe(0);
      await stripeReportsDecline("pi_retry", "evt_r");
      await stripeReportsDecline("pi_retry", "evt_r");
      expect(client().autopay_failure_count).toBe(1);
      expect(officeNotices).toHaveLength(1);
    } finally {
      fake.admin.rpc = realRpc;
    }
  });
});

// ── The count has one owner ─────────────────────────────────────────────────
//
// The fault was two writers each doing read-add-write. These pin that no
// third one appears: in app code `autopay_failure_count` is only ever reset to
// 0 (a success, the office's Resume), and only the decline module calls the
// counter.

const ROOT = join(import.meta.dirname, "..");

function appSources(dir = join(ROOT, "src"), acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) appSources(full, acc);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith("types.ts")) acc.push(full);
  }
  return acc;
}

describe("one place owns the count", () => {
  it("no app code writes autopay_failure_count except to reset it to 0", () => {
    const offenders: string[] = [];
    for (const file of appSources()) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          const m = line.match(/autopay_failure_count\s*:\s*([^,}\s]+)/);
          if (m && m[1] !== "0" && !/^\s*(\/\/|\*)/.test(line)) {
            offenders.push(`${repoRelative(file, ROOT)}:${i + 1}: ${line.trim()}`);
          }
        });
    }
    expect(offenders, "count a decline through count_autopay_decline instead").toEqual([]);
  });

  it("only the decline module calls count_autopay_decline", () => {
    const callers = appSources()
      .filter((f) => readFileSync(f, "utf8").includes('"count_autopay_decline"'))
      .map((f) => repoRelative(f, ROOT));
    expect(callers).toEqual(["src/lib/autopay-decline.server.ts"]);
  });

  it("the webhook keys the count on the PaymentIntent, and the nightly run hands its failures to the module", () => {
    const stripe = readFileSync(join(ROOT, "src/routes/api/public/hooks/stripe.ts"), "utf8");
    expect(stripe).toMatch(/countAutopayDecline\(supabaseAdmin, \{[^}]*paymentIntentId: pi\.id/);
    const nightly = readFileSync(join(ROOT, "src/routes/api/public/hooks/nightly.ts"), "utf8");
    expect(nightly).toMatch(
      /recordNightlyAutopayFailure\(supabaseAdmin, \{ clientId: c\.id, error: e \}\)/,
    );
  });
});
