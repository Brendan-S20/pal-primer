// Seats are charged one closed period at a time, exactly once, as their own
// invoice line dated for the period they cover (owner, 2026-10-09). This file
// drives seat-charges.server.ts and seat-reconcile.server.ts against a fake
// Stripe and a fake database; the database half of "exactly once" (the claim)
// is proved against real Postgres in
// tests/sql/a-seat-is-somebody-who-showed-up.proof.sql.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const stripe = {
    subscriptions: { retrieve: vi.fn(), update: vi.fn() },
    subscriptionItems: { del: vi.fn() },
    invoiceItems: { create: vi.fn(), list: vi.fn() },
    invoices: { create: vi.fn(), finalizeInvoice: vi.fn() },
    prices: { list: vi.fn() },
  };
  return {
    stripe,
    claim: vi.fn(),
    count: vi.fn(),
    updates: [] as Array<{ id: string; row: Record<string, unknown> }>,
    upserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
    org: { id: "org-1", slug: "acme", is_comped: false, timezone: "America/Chicago" } as Record<
      string,
      unknown
    > | null,
    plans: [] as unknown[],
  };
});

const admin = {
  rpc: (fn: string, args: Record<string, unknown>) =>
    Promise.resolve(fn === "claim_seat_charge" ? h.claim(args) : h.count(args)),
  from: (table: string) => {
    const q: any = {
      select: () => q,
      eq: () => q,
      maybeSingle: () => Promise.resolve({ data: h.org }),
      update: (row: Record<string, unknown>) => ({
        eq: (_k: string, id: string) => {
          h.updates.push({ id, row });
          return Promise.resolve({ error: null });
        },
      }),
      upsert: (row: Record<string, unknown>) => {
        h.upserts.push({ table, row });
        return Promise.resolve({ error: null });
      },
      then: (res: any, rej: any) =>
        Promise.resolve(table === "platform_plans" ? { data: h.plans } : { data: [] }).then(
          res,
          rej,
        ),
    };
    return q;
  },
};

vi.mock("@/lib/stripe-client.server", () => ({ makeStripe: async () => h.stripe }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: admin }));

import { chargeSeatPeriod, seatChargeKey, type SeatChargeContext } from "@/lib/seat-charges.server";
import {
  chargeFinalSeatPeriods,
  chargeFloor,
  chargeSeatsOnRenewalInvoice,
  dueForSeatSweep,
  prepaidThroughOnInvoice,
  invoiceSubscriptionId,
} from "@/lib/seat-reconcile.server";

const at = (iso: string) => Date.parse(iso) / 1000;
const SEP = { start: at("2026-09-01T05:00:00Z"), end: at("2026-10-01T05:00:00Z") };
const PLAN = {
  slug: "launch",
  includedSeats: 3,
  unitAmountCents: 1000,
  seatPriceIds: new Set(["price_seat"]),
};

function subscription(over: Record<string, unknown> = {}) {
  return {
    id: "sub_abc123456",
    customer: "cus_abc123456",
    currency: "usd",
    status: "active",
    default_payment_method: "pm_card",
    billing_cycle_anchor: at("2026-01-01T05:00:00Z"),
    start_date: at("2026-01-01T05:00:00Z"),
    trial_end: null,
    metadata: { seat_billing: "arrears", seat_arrears_from: "0" },
    items: {
      data: [
        {
          id: "si_base",
          price: { id: "price_base" },
          quantity: 1,
          current_period_start: at("2026-10-01T05:00:00Z"),
          current_period_end: at("2026-11-01T05:00:00Z"),
        },
      ],
    },
    ...over,
  } as any;
}

function ctx(over: Partial<SeatChargeContext> = {}): SeatChargeContext {
  return {
    stripe: h.stripe as any,
    admin,
    orgId: "org-1",
    sub: subscription(),
    plan: PLAN,
    timeZone: "America/Chicago",
    ...over,
  };
}

beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = "sk_test_seats";
  for (const group of Object.values(h.stripe))
    for (const f of Object.values(group)) (f as any).mockReset();
  h.claim.mockReset();
  h.count.mockReset();
  h.updates.length = 0;
  h.upserts.length = 0;
  h.org = { id: "org-1", slug: "acme", is_comped: false, timezone: "America/Chicago" };
  h.plans = [
    {
      slug: "launch",
      included_seats: 3,
      price_per_seat_cents: 1000,
      stripe_price_id: "price_base",
      stripe_seat_price_id: "price_seat",
      stripe_annual_price_id: null,
      stripe_annual_seat_price_id: null,
    },
  ];
  h.claim.mockReturnValue({
    data: { claimed: true, id: "charge-1", status: "claimed", retry: false },
    error: null,
  });
  h.count.mockReturnValue({ data: 5, error: null });
  h.stripe.prices.list.mockResolvedValue({ data: [], has_more: false });
  h.stripe.invoiceItems.create.mockImplementation(async (p: any) => ({
    id: "ii_1",
    invoice: p.invoice ?? null,
  }));
  h.stripe.invoices.create.mockResolvedValue({ id: "in_own" });
  h.stripe.invoiceItems.list.mockResolvedValue({ data: [] });
});

describe("one period, charged once", () => {
  it("puts its own line on the renewal invoice, dated for the period it covers", async () => {
    const o = await chargeSeatPeriod(ctx(), SEP, "renewal", {
      kind: "renewal_invoice",
      invoiceId: "in_renewal",
    });
    expect(o).toMatchObject({
      status: "billed",
      seats: 2,
      amountCents: 2000,
      invoiceId: "in_renewal",
    });
    expect(h.stripe.invoiceItems.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: "cus_abc123456",
        invoice: "in_renewal",
        amount: 2000,
        currency: "usd",
        description: "Extra active employees, Sep 1–30 (2 × $10.00)",
        period: { start: SEP.start, end: SEP.end },
        metadata: expect.objectContaining({ seat_charge_key: seatChargeKey("sub_abc123456", SEP) }),
      }),
      { idempotencyKey: `${seatChargeKey("sub_abc123456", SEP)}:renewal` },
    );
    // Not the licensed subscription item.
    expect(h.stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(h.updates.at(-1)?.row).toMatchObject({
      status: "billed",
      seats_seen: 5,
      billed_seats: 2,
      amount_cents: 2000,
      stripe_invoice_item_id: "ii_1",
    });
  });

  it("counts the people seen INSIDE the period, not since it began", async () => {
    await chargeSeatPeriod(ctx(), SEP, "renewal", {
      kind: "renewal_invoice",
      invoiceId: "in_renewal",
    });
    expect(h.count).toHaveBeenCalledWith({
      _org_id: "org-1",
      _from: new Date(SEP.start * 1000).toISOString(),
      _to: new Date(SEP.end * 1000).toISOString(),
    });
  });

  it("calls Stripe not at all for a period somebody else claimed or already charged", async () => {
    h.claim.mockReturnValue({
      data: { claimed: false, id: "charge-1", status: "billed", retry: false },
      error: null,
    });
    const o = await chargeSeatPeriod(ctx(), SEP, "period_close", { kind: "own_invoice" });
    expect(o).toEqual({ status: "not_claimed", period: SEP, why: "billed" });
    expect(h.count).not.toHaveBeenCalled();
    expect(h.stripe.invoiceItems.create).not.toHaveBeenCalled();
    expect(h.stripe.invoices.create).not.toHaveBeenCalled();
  });

  it("nobody past the allowance used it: recorded, and nothing sent to Stripe", async () => {
    h.count.mockReturnValue({ data: 3, error: null });
    const o = await chargeSeatPeriod(ctx(), SEP, "renewal", {
      kind: "renewal_invoice",
      invoiceId: "in_renewal",
    });
    expect(o).toEqual({ status: "nothing_to_bill", period: SEP, seen: 3 });
    expect(h.stripe.invoiceItems.create).not.toHaveBeenCalled();
    expect(h.updates.at(-1)?.row).toMatchObject({ status: "nothing_to_bill", amount_cents: 0 });
  });

  it("an invoice of its own when there is no renewal to ride on: only this line, the subscription's card, finalized", async () => {
    const o = await chargeSeatPeriod(ctx(), SEP, "cancellation", { kind: "own_invoice" });
    expect(o).toMatchObject({ status: "billed", invoiceId: "in_own" });
    expect(h.stripe.invoices.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: "cus_abc123456",
        collection_method: "charge_automatically",
        pending_invoice_items_behavior: "exclude",
        default_payment_method: "pm_card",
      }),
      { idempotencyKey: `${seatChargeKey("sub_abc123456", SEP)}:invoice` },
    );
    expect(h.stripe.invoiceItems.create).toHaveBeenCalledWith(
      expect.objectContaining({ invoice: "in_own", amount: 2000 }),
      expect.anything(),
    );
    expect(h.stripe.invoices.finalizeInvoice).toHaveBeenCalledWith("in_own", {
      auto_advance: true,
    });
  });

  it("a renewal that finalized before we got to it: the period goes on an invoice of its own", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    h.stripe.invoiceItems.create.mockImplementationOnce(async () => {
      throw new Error("You can only add invoice items to draft invoices.");
    });
    const o = await chargeSeatPeriod(ctx(), SEP, "renewal", {
      kind: "renewal_invoice",
      invoiceId: "in_renewal",
    });
    expect(o).toMatchObject({ status: "billed", invoiceId: "in_own" });
    expect(h.stripe.invoices.create).toHaveBeenCalledTimes(1);
  });

  it("a retry first looks for the line a dead run already made, and makes no second one", async () => {
    h.claim.mockReturnValue({
      data: { claimed: true, id: "charge-1", status: "claimed", retry: true },
      error: null,
    });
    h.stripe.invoiceItems.list.mockResolvedValue({
      data: [
        { id: "ii_other", metadata: { seat_charge_key: "something-else" } },
        {
          id: "ii_made",
          invoice: "in_renewal",
          metadata: { seat_charge_key: seatChargeKey("sub_abc123456", SEP) },
        },
      ],
    });
    const o = await chargeSeatPeriod(ctx(), SEP, "period_close", { kind: "own_invoice" });
    expect(o).toMatchObject({
      status: "billed",
      invoiceItemId: "ii_made",
      invoiceId: "in_renewal",
    });
    expect(h.stripe.invoiceItems.create).not.toHaveBeenCalled();
    expect(h.stripe.invoices.create).not.toHaveBeenCalled();
  });

  it("a Stripe failure is recorded on the period for the next run, never thrown", async () => {
    h.stripe.invoices.create.mockRejectedValue(new Error("stripe down"));
    const o = await chargeSeatPeriod(ctx(), SEP, "period_close", { kind: "own_invoice" });
    expect(o).toMatchObject({ status: "failed", error: "stripe down" });
    expect(h.updates.at(-1)?.row).toMatchObject({ status: "failed", error: "stripe down" });
  });

  it("a count that could not be read is a failure, not zero", async () => {
    h.count.mockReturnValue({ data: null, error: { message: "boom" } });
    const o = await chargeSeatPeriod(ctx(), SEP, "renewal", {
      kind: "renewal_invoice",
      invoiceId: "in_renewal",
    });
    expect(o.status).toBe("failed");
    expect(h.updates.at(-1)?.row.status).toBe("failed");
  });
});

describe("the renewal webhook", () => {
  const draft = (over: Record<string, unknown> = {}) =>
    ({
      id: "in_renewal",
      status: "draft",
      billing_reason: "subscription_cycle",
      parent: { subscription_details: { subscription: "sub_abc123456" } },
      lines: { data: [] },
      ...over,
    }) as any;

  it("only a subscription's own renewal draft", async () => {
    expect(
      await chargeSeatsOnRenewalInvoice(draft({ billing_reason: "subscription_update" })),
    ).toEqual({
      skipped: "not_a_renewal",
    });
    expect(await chargeSeatsOnRenewalInvoice(draft({ status: "open" }))).toEqual({
      skipped: "not_a_draft",
    });
    expect(h.stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it("puts every closed, unclaimed month since the floor on the draft", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T05:00:30Z"));
    try {
      h.stripe.subscriptions.retrieve.mockResolvedValue(
        subscription({
          start_date: at("2026-09-01T05:00:00Z"),
          billing_cycle_anchor: at("2026-09-01T05:00:00Z"),
        }),
      );
      const r = await chargeSeatsOnRenewalInvoice(draft());
      expect("charged" in r && r.charged.map((c) => c.status)).toEqual(["billed"]);
      expect(h.claim).toHaveBeenCalledWith(
        expect.objectContaining({
          _period_start: "2026-09-01T05:00:00.000Z",
          _period_end: "2026-10-01T05:00:00.000Z",
          _reason: "renewal",
        }),
      );
      expect(h.stripe.invoiceItems.create).toHaveBeenCalledWith(
        expect.objectContaining({ invoice: "in_renewal" }),
        expect.anything(),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("never the demo org, and never a comped one", async () => {
    h.stripe.subscriptions.retrieve.mockResolvedValue(subscription());
    h.org = { id: "org-1", slug: "demo", is_comped: false, timezone: null };
    expect(await chargeSeatsOnRenewalInvoice(draft())).toEqual({ skipped: "demo_org" });
    h.org = { id: "org-1", slug: "acme", is_comped: true, timezone: null };
    expect(await chargeSeatsOnRenewalInvoice(draft())).toEqual({ skipped: "demo_org" });
    expect(h.claim).not.toHaveBeenCalled();
  });

  it("reads the subscription off either invoice shape", () => {
    expect(invoiceSubscriptionId(draft())).toBe("sub_abc123456");
    expect(invoiceSubscriptionId({ subscription: "sub_old_shape" })).toBe("sub_old_shape");
    expect(invoiceSubscriptionId({})).toBeNull();
  });

  it("a draft that already charged the new period's seats in advance makes that period prepaid too", () => {
    const inv = {
      lines: {
        data: [
          {
            quantity: 1,
            period: { end: 200 },
            pricing: { price_details: { price: "price_base" } },
          },
          {
            quantity: 3,
            period: { end: 300 },
            pricing: { price_details: { price: "price_seat" } },
          },
          { quantity: 0, period: { end: 900 }, price: { id: "price_seat" } },
        ],
      },
    };
    expect(prepaidThroughOnInvoice(inv, PLAN.seatPriceIds)).toBe(300);
    expect(prepaidThroughOnInvoice({ lines: { data: [] } }, PLAN.seatPriceIds)).toBeNull();
  });
});

describe("a cancellation", () => {
  it("charges the final period once, from its start to the moment it ended", async () => {
    const ended = at("2026-10-20T12:00:00Z");
    h.stripe.subscriptions.retrieve.mockResolvedValue(
      subscription({
        status: "canceled",
        ended_at: ended,
        billing_cycle_anchor: at("2026-01-01T05:00:00Z"),
      }),
    );
    // Earlier months were charged already; the claim says so.
    h.claim.mockImplementation((args: any) =>
      args._period_start === "2026-10-01T05:00:00.000Z"
        ? {
            data: { claimed: true, id: "charge-final", status: "claimed", retry: false },
            error: null,
          }
        : { data: { claimed: false, id: "x", status: "billed", retry: false }, error: null },
    );
    const r = await chargeFinalSeatPeriods(subscription({ status: "canceled", ended_at: ended }));
    const final = h.claim.mock.calls
      .map((c) => c[0])
      .find((a: any) => a._period_start === "2026-10-01T05:00:00.000Z");
    expect(final).toMatchObject({
      _period_end: "2026-10-20T12:00:00.000Z",
      _reason: "cancellation",
    });
    expect("charged" in r && r.charged.filter((c) => c.status === "billed")).toHaveLength(1);
    expect(h.stripe.invoices.create).toHaveBeenCalledTimes(1);
  });

  it("a subscription still on the old rule had its final period prepaid: nothing more", async () => {
    const ended = at("2026-10-20T12:00:00Z");
    h.stripe.subscriptions.retrieve.mockResolvedValue(
      subscription({ status: "canceled", ended_at: ended, metadata: {} }),
    );
    const r = await chargeFinalSeatPeriods(
      subscription({ status: "canceled", ended_at: ended, metadata: {} }),
    );
    expect(r).toEqual({ charged: [] });
    expect(h.claim).not.toHaveBeenCalled();
  });
});

describe("the floor and the nightly sweep", () => {
  it("charges nothing before the changeover, the subscription, a free trial, or the lookback", () => {
    expect(chargeFloor({ markedFrom: null, now: 1e9 })).toBe(Number.POSITIVE_INFINITY);
    expect(chargeFloor({ markedFrom: 0, startDate: 500, trialEnd: 900, now: 1000 })).toBe(900);
    expect(chargeFloor({ markedFrom: 0, now: 1e9 })).toBe(1e9 - 70 * 24 * 60 * 60);
  });

  it("looks at an org once its seat period has closed past the renewal grace, or if never looked at", () => {
    const now = new Date("2026-10-09T09:00:00Z");
    const org = (id: string, end: string | null, over: Record<string, unknown> = {}) => ({
      id,
      slug: "acme",
      is_comped: false,
      timezone: null,
      seat_period_end: end,
      ...over,
    });
    const due = dueForSeatSweep(
      [
        org("closed-yesterday", "2026-10-08T05:00:00Z"),
        org("closed-an-hour-ago", "2026-10-09T08:00:00Z"), // renewal webhook's turn
        org("still-open", "2026-10-20T05:00:00Z"),
        org("never-looked", null),
        org("demo", null, { slug: "demo" }),
        org("comped", null, { is_comped: true }),
      ],
      now,
    ).map((o) => o.id);
    expect(due).toEqual(["closed-yesterday", "never-looked"]);
  });
});
