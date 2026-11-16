/** #653, the close condition of 2026-11-10 and acceptance checklist D4-D6:
 *  "No test runs a refund or tip and then compares all three screens."
 *
 *  This one does, on a real database. It rebuilds the Round-2 audit case on a
 *  labelled pet-sitting TEST org (made here and deleted after, never a
 *  production org):
 *
 *    - tonight's stay, $350, with a $150 deposit paid in CASH at the office,
 *      so $200 is left to pay (the sitter card's $200, proved in SQL by
 *      tests/sql/a-deposit-is-part-payment-of-its-stay.proof.sql), and
 *    - a later stay, $500, whose $150 deposit is not paid yet.
 *
 *  Open receivables are the stay totals less the deposit paid: $350 - $150 +
 *  $500 = $700 on 2 invoices, the portal's "2 open · $700".
 *
 *  Then it reads what the three screens read, through the REAL server
 *  functions the screens call, as the signed-in owner:
 *
 *    dashboard   getDashboardSummary: mtdRevenueCents (collectedInPeriod,
 *                month to date) and arOpenCents (summarizeAr)
 *    /reports    getReports for the same month to date: collectedNetCents
 *                (collectedInPeriod) and outstandingCents
 *    AR aging    getReports' aging buckets (arPositionAsOf), as at today
 *
 *  and checks they agree before anything happens, after one cash refund with
 *  a reason (recordManualRefund -> refund_manual_payment), and after one
 *  office cash tip (bulkMarkInvoicesPaid with tipCents, the path
 *  RecordPaymentDialog takes, which calls recordOfficeTip). "Agree" is:
 *
 *    - the dashboard's collected equals /reports' collected,
 *    - the dashboard's open AR equals /reports' outstanding equals the sum of
 *      the aging buckets, and
 *    - what was billed less what was collected is what is still owed, so a
 *      refund that moves the money moves the receivable by the same amount.
 *
 *  A tip is not revenue and not a receivable (revenue.ts: tipsReceivedCents
 *  is its own figure, "never summed" into collected). This holds the screens
 *  to that rule as written; it does not invent a new one.
 *
 *  Only the framework wrapper is stood in for: each handler runs with the
 *  owner's own authenticated client, the context the auth middleware builds,
 *  and the service-role client is the real one on the local stack. No Stripe
 *  call is made: every payment here is cash, so no invoice has a payment
 *  intent and the pay-page sync returns before it reaches Stripe.
 *
 *  Skipped without TEST_SUPABASE_* env, like every file here. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { dbEnabled, insertRow, makeWalkOrg, type WalkOrg } from "../support/walk-db";
import { orgDay } from "../support/org-day";

const caller = vi.hoisted(() => ({ supabase: null as unknown, userId: "" }));

vi.mock("@tanstack/react-start", () => {
  const createServerFn = () => {
    let validate: (d: unknown) => unknown = (d) => d;
    type Builder = {
      middleware: () => Builder;
      inputValidator: (v: (d: unknown) => unknown) => Builder;
      handler: (
        h: (ctx: { data: unknown; context: unknown }) => unknown,
      ) => (opts?: { data?: unknown }) => unknown;
    };
    const b: Builder = {
      middleware: () => b,
      inputValidator: (v) => ((validate = v), b),
      handler:
        (h: (ctx: { data: unknown; context: unknown }) => unknown) =>
        (opts: { data?: unknown } = {}) =>
          h({
            data: validate(opts.data ?? {}),
            context: { supabase: caller.supabase, userId: caller.userId },
          }),
    };
    return b;
  };
  return { createServerFn, createServerOnlyFn: <T>(fn: T) => fn };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", async () => {
  const { createClient } = await import("@supabase/supabase-js");
  return {
    supabaseAdmin: createClient(
      process.env.TEST_SUPABASE_URL ?? "http://127.0.0.1:1",
      process.env.TEST_SUPABASE_SERVICE_KEY ?? "unset",
      { auth: { persistSession: false } },
    ),
  };
});

/** A server function, as the stand-in wrapper above returns it. */
type Handler = (opts?: unknown) => Promise<unknown>;

// UTC, so the org's day and the test's day are the same day.
const today = orgDay("UTC");
const monthStart = `${today.slice(0, 7)}-01`;
const dayFromToday = (n: number) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

let org: WalkOrg;
let nightService: string;
let clientId: string;
let tonight: { stayId: string; invoiceId: string; depositId: string };
let later: { stayId: string; invoiceId: string; depositId: string };

/** The three screens, as the owner sees them. */
type Screens = {
  dashboard: {
    collectedCents: number;
    grossCents: number;
    refundsCents: number;
    arOpenCents: number;
  };
  reports: {
    collectedNetCents: number;
    collectedGrossCents: number;
    refundsNetCents: number;
    billedCents: number;
    outstandingCents: number;
    openInvoiceCount: number;
  };
  aging: { current: number; d30: number; d60: number; d90: number; totalCents: number };
};

async function asOwner() {
  caller.supabase = org.owner.client;
  caller.userId = org.owner.userId;
}

async function readScreens(): Promise<Screens> {
  await asOwner();
  const { getDashboardSummary } = await import("@/lib/dashboard.functions");
  const { getReports } = await import("@/lib/reports.functions");
  const d = (await (getDashboardSummary as unknown as Handler)()) as {
    mtdRevenueCents: number;
    mtdGrossCents: number;
    mtdRefundsCents: number;
    arOpenCents: number;
  };
  const r = (await (getReports as unknown as Handler)({
    data: { from: monthStart, to: today },
  })) as {
    collectedNetCents: number;
    collectedGrossCents: number;
    refundsNetCents: number;
    billedCents: number;
    outstandingCents: number;
    openInvoiceCount: number;
    arAsOf: string;
    aging: { current: number; d30: number; d60: number; d90: number };
  };
  expect(r.arAsOf).toBe(today);
  return {
    dashboard: {
      collectedCents: d.mtdRevenueCents,
      grossCents: d.mtdGrossCents,
      refundsCents: d.mtdRefundsCents,
      arOpenCents: d.arOpenCents,
    },
    reports: {
      collectedNetCents: r.collectedNetCents,
      collectedGrossCents: r.collectedGrossCents,
      refundsNetCents: r.refundsNetCents,
      billedCents: r.billedCents,
      outstandingCents: r.outstandingCents,
      openInvoiceCount: r.openInvoiceCount,
    },
    aging: {
      ...r.aging,
      totalCents: r.aging.current + r.aging.d30 + r.aging.d60 + r.aging.d90,
    },
  };
}

/** The three screens agree with each other, and with the books. */
function expectAgreement(s: Screens) {
  // Collected: the same money on the dashboard and on /reports.
  expect(s.dashboard.collectedCents, "dashboard collected vs /reports collected").toBe(
    s.reports.collectedNetCents,
  );
  expect(s.dashboard.grossCents).toBe(s.reports.collectedGrossCents);
  expect(s.dashboard.refundsCents).toBe(s.reports.refundsNetCents);
  // Receivables: the dashboard's open AR, /reports' outstanding and the aging
  // buckets are one figure.
  expect(s.dashboard.arOpenCents, "dashboard AR open vs /reports outstanding").toBe(
    s.reports.outstandingCents,
  );
  expect(s.aging.totalCents, "AR aging buckets vs /reports outstanding").toBe(
    s.reports.outstandingCents,
  );
  // And the books close: billed less collected is what is still owed. No tax
  // here, so billed is the whole of what the client was asked for.
  expect(
    s.reports.billedCents - s.reports.collectedNetCents,
    "billed less collected vs outstanding",
  ).toBe(s.reports.outstandingCents);
}

async function invoiceRow(id: string) {
  const r = await org.admin
    .from("invoices")
    .select("status, total_cents, amount_paid_cents, deposit_for_invoice_id")
    .eq("id", id)
    .single();
  if (r.error) throw new Error(r.error.message);
  return r.data;
}

/** A stay booked by the client and confirmed by the office at a set nightly
 *  price and deposit: portal_request_stay, then confirm_stay, which invoices
 *  the stay and links its deposit (D3). */
async function bookStay(
  startIn: number,
  nights: number,
  nightlyCents: number,
  depositCents: number,
) {
  const propertyId = await insertRow(org.admin, "properties", {
    organization_id: org.orgId,
    client_id: clientId,
    street: `${startIn} Audit St`,
    city: "Austin",
    postal_code: "78701",
  });
  const petId = await insertRow(org.admin, "dogs", {
    organization_id: org.orgId,
    property_id: propertyId,
    name: `Audit pet ${startIn}`,
    active: true,
  });
  const req = await org.admin.rpc("portal_request_stay", {
    _org_id: org.orgId,
    _client_id: clientId,
    _request_key: randomUUID(),
    _input: {
      propertyId,
      serviceId: nightService,
      startsOn: dayFromToday(startIn),
      endsOn: dayFromToday(startIn + nights),
      petIds: [petId],
    },
  });
  expect(req.error).toBeNull();
  const stayId = req.data as string;
  const confirmed = await org.owner.client.rpc("confirm_stay", {
    _stay_id: stayId,
    _price_cents: nightlyCents,
    _deposit_cents: depositCents,
  });
  expect(confirmed.error).toBeNull();
  const st = await org.admin
    .from("stays")
    .select("invoice_id, deposit_invoice_id")
    .eq("id", stayId)
    .single();
  if (st.error) throw new Error(st.error.message);
  return {
    stayId,
    invoiceId: st.data.invoice_id as string,
    depositId: st.data.deposit_invoice_id as string,
  };
}

/** The office's Record payment, as RecordPaymentDialog sends it. */
async function recordCash(
  invoiceId: string,
  extra: { amountCents?: number; tipCents?: number } = {},
) {
  await asOwner();
  const { bulkMarkInvoicesPaid } = await import("@/lib/invoices.functions");
  const r = (await (bulkMarkInvoicesPaid as unknown as Handler)({
    data: { ids: [invoiceId], method: "cash", ...extra },
  })) as { ok: number; failed: number; refusal: string | null; tipFailed: boolean };
  expect(r.refusal).toBeNull();
  expect(r).toMatchObject({ ok: 1, failed: 0, tipFailed: false });
}

async function paymentsOn(invoiceId: string) {
  const r = await org.admin
    .from("payments")
    .select("id, amount_cents, status, refunded_cents, tip_cents, stripe_payment_intent_id")
    .eq("invoice_id", invoiceId)
    .order("created_at");
  if (r.error) throw new Error(r.error.message);
  return r.data ?? [];
}

describe.skipIf(!dbEnabled)(
  "#653: the dashboard, /reports and AR aging agree after a stay deposit, a cash refund and a tip",
  () => {
    let before: Screens;
    let afterRefund: Screens;
    let afterTip: Screens;

    beforeAll(async () => {
      org = await makeWalkOrg("TEST #653 audit sitter (not a real business)");
      const changed = await org.admin
        .from("organizations")
        .update({ service_lines: ["pet_sitting"], sales_tax_rate_bps: 0 })
        .eq("id", org.orgId);
      expect(changed.error).toBeNull();
      nightService = await insertRow(org.admin, "services", {
        organization_id: org.orgId,
        name: "Overnight care",
        service_line: "pet_sitting",
        price_unit: "night",
        base_price_cents: 10000,
      });
      clientId = await insertRow(org.admin, "clients", {
        organization_id: org.orgId,
        display_name: "TEST audit client",
        account_type: "residential",
        active: true,
      });
      // Tonight's stay: two nights at $175 from today, $150 deposit.
      tonight = await bookStay(0, 2, 17500, 15000);
      // The later stay: two nights at $250, a month out, $150 deposit unpaid.
      later = await bookStay(30, 2, 25000, 15000);
    });
    afterAll(async () => {
      await org?.cleanup();
    });

    it("books the audit case: $350 and $500 stays, each with a linked $150 deposit", async () => {
      expect(await invoiceRow(tonight.invoiceId)).toMatchObject({
        status: "open",
        total_cents: 35000,
      });
      expect(await invoiceRow(later.invoiceId)).toMatchObject({
        status: "open",
        total_cents: 50000,
      });
      expect(await invoiceRow(tonight.depositId)).toMatchObject({
        total_cents: 15000,
        deposit_for_invoice_id: tonight.invoiceId,
      });
      expect(await invoiceRow(later.depositId)).toMatchObject({
        total_cents: 15000,
        deposit_for_invoice_id: later.invoiceId,
      });
    });

    it("the deposit paid in cash is part payment of its stay: $200 left tonight, 2 open · $700", async () => {
      await recordCash(tonight.depositId);
      const [deposit] = await paymentsOn(tonight.depositId);
      expect(deposit).toMatchObject({
        amount_cents: 15000,
        status: "succeeded",
        stripe_payment_intent_id: null,
      });
      expect(await invoiceRow(tonight.depositId)).toMatchObject({ status: "paid" });
      // D3: counted on the stay invoice, not posted as account credit.
      expect(await invoiceRow(tonight.invoiceId)).toMatchObject({
        status: "open",
        amount_paid_cents: 15000,
      });
      const credit = await org.admin
        .from("clients")
        .select("credit_balance_cents")
        .eq("id", clientId)
        .single();
      expect(credit.data?.credit_balance_cents).toBe(0);

      before = await readScreens();
      expect(before.reports.openInvoiceCount).toBe(2);
      expect(before.reports.outstandingCents).toBe(35000 - 15000 + 50000);
    });

    it("before any refund, the three screens already agree", () => {
      expectAgreement(before);
      expect(before.dashboard.collectedCents).toBe(15000);
      // The stays, once: a linked deposit is not billed on top of its stay.
      expect(before.reports.billedCents).toBe(35000 + 50000);
      expect(before.aging).toMatchObject({ current: 70000, d30: 0, d60: 0, d90: 0 });
    });

    it("after one cash refund with a reason, they still agree and all moved by the refund", async () => {
      const [deposit] = await paymentsOn(tonight.depositId);
      await asOwner();
      const { recordManualRefund } = await import("@/lib/refunds.functions");
      // The reason is required: refused without one, before anything moves.
      await expect(
        (async () =>
          (recordManualRefund as unknown as Handler)({
            data: { paymentId: deposit.id, amountCents: 5000, reason: "  ", kind: "refund" },
          }))(),
      ).rejects.toThrow();
      // And the database refuses one too, for a caller that skips the form.
      const bare = await org.owner.client.rpc("refund_manual_payment", {
        _payment_id: deposit.id,
        _amount_cents: 5000,
        _reason: "",
      });
      expect(bare.error?.message).toMatch(/Say why the money is going back/);
      expect((await paymentsOn(tonight.depositId))[0]).toMatchObject({ status: "succeeded" });

      const r = (await (recordManualRefund as unknown as Handler)({
        data: {
          paymentId: deposit.id,
          amountCents: 5000,
          reason: "Gave $50 of the deposit back in cash at the door",
          kind: "refund",
        },
      })) as { amountCents: number };
      expect(r.amountCents).toBe(5000);
      expect((await paymentsOn(tonight.depositId))[0]).toMatchObject({
        status: "refunded",
        refunded_cents: 5000,
      });

      afterRefund = await readScreens();
      expectAgreement(afterRefund);
      // Every screen moved by the same $50: collected down, owed up.
      expect(before.dashboard.collectedCents - afterRefund.dashboard.collectedCents).toBe(5000);
      expect(before.reports.collectedNetCents - afterRefund.reports.collectedNetCents).toBe(5000);
      expect(afterRefund.dashboard.arOpenCents - before.dashboard.arOpenCents).toBe(5000);
      expect(afterRefund.reports.outstandingCents - before.reports.outstandingCents).toBe(5000);
      expect(afterRefund.aging.totalCents - before.aging.totalCents).toBe(5000);
      // The gross is what arrived; the refund is shown beside it, not netted
      // away out of sight.
      expect(afterRefund.reports.collectedGrossCents).toBe(before.reports.collectedGrossCents);
      expect(afterRefund.reports.refundsNetCents).toBe(5000);
      // Nothing billed changed.
      expect(afterRefund.reports.billedCents).toBe(before.reports.billedCents);
      expect(await invoiceRow(tonight.invoiceId)).toMatchObject({
        status: "open",
        amount_paid_cents: 10000,
      });
    });

    it("after one office cash tip, collected agrees and moved by the payment, not the tip", async () => {
      // $100 more toward tonight's stay in cash, with a $20 tip handed over
      // beside it: RecordPaymentDialog's partial amount and tip.
      await recordCash(tonight.invoiceId, { amountCents: 10000, tipCents: 2000 });
      const payments = await paymentsOn(tonight.invoiceId);
      expect(payments).toHaveLength(1);
      expect(payments[0]).toMatchObject({
        amount_cents: 10000,
        tip_cents: 2000,
        status: "succeeded",
      });
      // $100 kept of the deposit, and this $100.
      expect(await invoiceRow(tonight.invoiceId)).toMatchObject({
        status: "open",
        amount_paid_cents: 20000,
      });

      afterTip = await readScreens();
      expect(afterTip.dashboard.collectedCents, "dashboard collected vs /reports collected").toBe(
        afterTip.reports.collectedNetCents,
      );
      expect(afterTip.dashboard.grossCents).toBe(afterTip.reports.collectedGrossCents);
      expect(afterTip.dashboard.refundsCents).toBe(afterTip.reports.refundsNetCents);
      // The payment moved collected by $100; the $20 tip moved nothing.
      expect(afterTip.dashboard.collectedCents - afterRefund.dashboard.collectedCents).toBe(10000);
      expect(afterTip.reports.collectedNetCents - afterRefund.reports.collectedNetCents).toBe(
        10000,
      );
      expect(afterTip.reports.billedCents).toBe(afterRefund.reports.billedCents);

      // The tip is its own figure, read the way the accountant's Tips
      // received sheet reads it, from the same payment rows.
      const { tipsReceivedCents } = await import("@/lib/revenue");
      const all = await org.admin
        .from("payments")
        .select("amount_cents, status, tip_cents")
        .eq("organization_id", org.orgId);
      expect(all.error).toBeNull();
      expect(tipsReceivedCents(all.data ?? [])).toBe(2000);
    });

    // #908: a later payment must not drop the kept part of the deposit.
    it("after the tip, the dashboard's AR, /reports' outstanding and aging all read $650", () => {
      // $350 - $100 kept of the deposit - $100 = $150 tonight, + $500 later.
      // The dashboard reads the live amount_paid_cents. /reports and its aging
      // date the stay's payments (attachDatedPartialPayments), and must count
      // the $100 the refund left on the deposit's payment as well.
      expect(afterTip.dashboard.arOpenCents).toBe(15000 + 50000);
      expectAgreement(afterTip);
      expect(afterRefund.reports.outstandingCents - afterTip.reports.outstandingCents).toBe(10000);
      expect(afterRefund.aging.totalCents - afterTip.aging.totalCents).toBe(10000);
    });
  },
);
