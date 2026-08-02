import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeAdmin, type Row } from "./helpers/fake-supabase";
import { currentOrgMonth } from "@/lib/ai-overage-billing.server";

// BUILD-2, the money half. This writes a real charge to a real customer, and
// the two ways it can be wrong are not symmetric:
//
//   billing twice   → a refund, an apology, and a support ticket
//   billing never   → recoverable from the event log, silently
//
// So the tests that matter here are the refusals, and the one behaviour worth
// the most attention is what happens on a re-run.

const ORG = "11111111-1111-1111-1111-111111111111";
const PLAN = "22222222-2222-2222-2222-222222222222";
const CUSTOMER = "cus_org";
const SUB = "sub_org";

const fake = createFakeAdmin();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, p) => fake.admin[p as keyof typeof fake.admin] }),
}));

/** Records every invoice item created, and refuses a repeated idempotency key
 *  the way Stripe does — by returning the ORIGINAL object rather than making a
 *  second one. A fake that happily created two would let a double-bill pass. */
const created: Array<{ params: Record<string, unknown>; key: string | undefined }> = [];
const byKey = new Map<string, { id: string }>();
let stripeThrows: Error | null = null;

vi.mock("stripe", () => ({
  default: class {
    invoiceItems = {
      create: async (params: Record<string, unknown>, opts?: { idempotencyKey?: string }) => {
        if (stripeThrows) throw stripeThrows;
        const key = opts?.idempotencyKey;
        if (key && byKey.has(key)) return byKey.get(key)!;
        const item = { id: `ii_${created.length + 1}` };
        if (key) byKey.set(key, item);
        created.push({ params, key });
        return item;
      },
    };
  },
}));

const LAST_MONTH = "2026-07-01";
const THIS_MONTH = "2026-08-01";

const period = (o: Partial<Row> = {}): Row => ({
  organization_id: ORG,
  period_month: LAST_MONTH,
  actions: 500,
  billed_at: null,
  billed_actions: null,
  billed_cents: null,
  stripe_invoice_item_id: null,
  ...o,
});

const periodRow = () => fake.tables.ai_usage_periods[0];

beforeEach(() => {
  vi.useFakeTimers();
  // Mid-August in Chicago, so July is closed and August is not.
  vi.setSystemTime(new Date("2026-08-15T12:00:00Z"));
  process.env.PLATFORM_STRIPE_SECRET_KEY = "sk_test_build2";
  created.length = 0;
  byKey.clear();
  stripeThrows = null;
  fake.reset({
    organizations: [
      {
        id: ORG,
        stripe_customer_id: CUSTOMER,
        stripe_subscription_id: SUB,
        timezone: "America/Chicago",
        plan_id: PLAN,
      },
    ],
    platform_plans: [{ id: PLAN, ai_actions_included: 200, ai_overage_cents_per_action: 10 }],
    ai_usage_periods: [period()],
  });
});

async function run() {
  const { runAiOverageBilling } = await import("@/lib/ai-overage-billing.server");
  return runAiOverageBilling();
}

describe("a closed month with overage", () => {
  it("creates one invoice item for the actions past the allowance", async () => {
    // 500 used, 200 included → 300 over at 10c = $30.00. Billing all 500
    // would charge again for the allowance the plan already includes.
    const r = await run();
    expect(r.billed).toBe(1);
    expect(r.centsTotal).toBe(3000);
    expect(created).toHaveLength(1);
    expect(created[0].params).toMatchObject({
      customer: CUSTOMER,
      subscription: SUB,
      amount: 3000,
      currency: "usd",
    });
  });

  it("names the month, the count and the allowance on the line", async () => {
    // "AI overage $30.00" on its own is the kind of line that generates a
    // support ticket. The customer should be able to check it without asking.
    await run();
    const description = String(created[0].params.description);
    expect(description).toContain("July 2026");
    expect(description).toContain("300");
    expect(description).toContain("200");
  });

  it("records what it billed against the period", async () => {
    await run();
    expect(periodRow()).toMatchObject({
      billed_actions: 300,
      billed_cents: 3000,
      stripe_invoice_item_id: "ii_1",
    });
    expect(periodRow().billed_at).toBeTruthy();
  });

  it("carries the org and month in metadata for reconciliation", async () => {
    await run();
    expect(created[0].params.metadata).toMatchObject({
      kind: "ai_overage",
      organization_id: ORG,
      period_month: LAST_MONTH,
    });
  });
});

describe("it cannot bill the same month twice", () => {
  it("does nothing on a second run", async () => {
    await run();
    const second = await run();
    expect(second.billed).toBe(0);
    expect(created, "a second invoice item was created").toHaveLength(1);
  });

  it("skips a month already marked billed", async () => {
    fake.tables.ai_usage_periods = [period({ billed_at: "2026-08-01T00:00:00Z" })];
    const r = await run();
    expect(r.billed).toBe(0);
    expect(created).toHaveLength(0);
  });

  it("only one of two concurrent runs bills the month", async () => {
    // The sequential case is stopped by the run's own `.is("billed_at", null)`
    // filter, so it does NOT exercise the per-org claim at all — removing that
    // claim entirely left every other test in this file green. This is the one
    // that fails without it.
    //
    // Two nightly runs overlapping is not hypothetical: a slow run and its
    // successor, or a manual trigger during the scheduled one.
    const { billOrgAiOverage } = await import("@/lib/ai-overage-billing.server");

    // One throwaway billing of a DIFFERENT closed month first, which has to go
    // all the way through Stripe.
    //
    // `billOrgAiOverage` resolves the Stripe SDK with `await import()` on every
    // call, and two of those in flight at once race vitest's mocker into
    // handing one of them the REAL SDK. It then fails on a network call, only
    // one result says `billed`, and the assertion below passes for entirely
    // the wrong reason. Two earlier versions of this test did exactly that —
    // the first because the mocker handed over an unmocked Supabase client,
    // the second an unmocked Stripe — and both were green.
    //
    // A bare `import()` does not settle it and neither does a call that skips
    // early: the code path has to actually reach the module.
    fake.tables.ai_usage_periods.push(period({ period_month: "2026-06-01", actions: 300 }));
    const warm = await billOrgAiOverage({
      organization_id: ORG,
      period_month: "2026-06-01",
      actions: 300,
    });
    expect(warm, "the warm-up must reach Stripe or it warms nothing").toHaveProperty("billed");
    expect(created).toHaveLength(1);

    const row = { organization_id: ORG, period_month: LAST_MONTH, actions: 500 };
    const results = await Promise.all([billOrgAiOverage(row), billOrgAiOverage(row)]);
    // Exactly one claim, exactly one charge. Neither may be a thrown error:
    // an outcome that skipped for a `stripe_error` is a broken test, not a
    // working guard.
    expect(
      results.filter((r) => "billed" in r),
      "both runs billed the month",
    ).toHaveLength(1);
    expect(
      results.filter((r) => "skipped" in r && r.skipped.startsWith("stripe_error")),
      "a run failed instead of losing the claim — the guard was never exercised",
    ).toHaveLength(0);
    expect(created, "a second invoice item was created").toHaveLength(2);
  });

  it("reaches the same Stripe object if the claim was somehow lost", async () => {
    // The claim is taken BEFORE Stripe is called, which trades a small risk of
    // "billed but never charged" for no risk of "charged twice". The
    // idempotency key is what makes the first risk small: a re-run after a
    // rolled-back claim returns the ORIGINAL invoice item.
    await run();
    const firstKey = created[0].key;
    expect(firstKey).toBe(`ai-overage-${ORG}-${LAST_MONTH}`);

    fake.tables.ai_usage_periods = [period()]; // claim lost
    await run();
    expect(created, "the idempotency key did not hold").toHaveLength(1);
    expect(periodRow().stripe_invoice_item_id).toBe("ii_1");
  });
});

describe("what it refuses to bill", () => {
  it("will not bill a month that is still open", async () => {
    // The current month is still accruing. Billing it now cuts the month short
    // and bills the remainder again later as a second charge for one month.
    fake.tables.ai_usage_periods = [period({ period_month: THIS_MONTH, actions: 5000 })];
    const r = await run();
    expect(r.billed).toBe(0);
    expect(created).toHaveLength(0);
  });

  it("uses the ORG's month boundary, not the server's", async () => {
    // 1 August 02:00 UTC is 9pm on 31 July in Chicago. A server-clock boundary
    // would close that org's July seven hours early, then bill the remaining
    // usage again as a second July.
    vi.setSystemTime(new Date("2026-08-01T02:00:00Z"));
    expect(currentOrgMonth("America/Chicago")).toBe("2026-07-01");
    expect(currentOrgMonth("UTC")).toBe("2026-08-01");

    fake.tables.ai_usage_periods = [period({ period_month: LAST_MONTH })];
    const r = await run();
    expect(r.billed, "July was billed while the org was still in July").toBe(0);
  });

  it("bills nothing when usage stayed inside the allowance", async () => {
    fake.tables.ai_usage_periods = [period({ actions: 150 })];
    const r = await run();
    expect(r.billed).toBe(0);
    expect(created).toHaveLength(0);
  });

  it("still closes a month with no overage", async () => {
    // Otherwise every future run re-examines it for ever and the run's own
    // "how many months are outstanding" number stops meaning anything.
    fake.tables.ai_usage_periods = [period({ actions: 150 })];
    await run();
    expect(periodRow().billed_at).toBeTruthy();
    expect(periodRow().billed_cents).toBe(0);
  });

  it("bills nothing on an unlimited plan, and for the right reason", async () => {
    // Enterprise. A negotiated contract is not a place for an automatic charge.
    //
    // The REASON matters, and asserting only `billed === 0` did not check it:
    // with the unlimited guard removed the arithmetic coerces null to 0 and
    // produces a zero charge anyway, so the test passed against a version that
    // had stopped refusing on principle and started refusing by accident. One
    // plan-price change away from billing an Enterprise account.
    fake.tables.platform_plans = [
      { id: PLAN, ai_actions_included: null, ai_overage_cents_per_action: null },
    ];
    const r = await run();
    expect(r.billed).toBe(0);
    expect(created).toHaveLength(0);
    expect(r.outcomes).toEqual([
      { skipped: "plan_has_no_overage", orgId: ORG, periodMonth: LAST_MONTH },
    ]);
  });

  it("bills nothing for an org with no Stripe customer", async () => {
    fake.tables.organizations[0].stripe_customer_id = null;
    const r = await run();
    expect(r.billed).toBe(0);
    expect(created).toHaveLength(0);
  });

  it("bills nothing when Stripe is not configured", async () => {
    delete process.env.PLATFORM_STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    const r = await run();
    expect(r.billed).toBe(0);
    expect(created).toHaveLength(0);
  });
});

describe("a Stripe failure", () => {
  it("does not take down the run", async () => {
    stripeThrows = new Error("card_declined");
    const r = await run();
    expect(r.billed).toBe(0);
    // The claim stands: a retry hits the same idempotency key and either
    // succeeds or fails the same way. What it cannot do is bill twice.
    expect(periodRow().billed_at).toBeTruthy();
    expect(periodRow().stripe_invoice_item_id).toBeNull();
  });

  it("reports the reason rather than a silent zero", async () => {
    stripeThrows = new Error("card_declined");
    const r = await run();
    expect(r.outcomes.some((o) => "skipped" in o && o.skipped.startsWith("stripe_error"))).toBe(
      true,
    );
  });
});
