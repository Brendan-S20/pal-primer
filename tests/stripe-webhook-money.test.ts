import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFakeAdmin, stripeSignature } from "./helpers/fake-supabase";

// IMP-6, second half. tests/stripe-webhook.test.ts proves the handler refuses
// what it cannot verify. This file proves what it DOES with what it accepts —
// the money decisions — by giving it a fake `supabaseAdmin` and reading what
// it tried to write.
//
// Why a fake rather than the database: the interesting cases are the ones
// where the handler MUST NOT write (an attacker's event naming a victim's
// invoice, a webhook redelivered twice, an inquiry that never took money).
// Proving those against a real database means either accepting that a broken
// guard marks a real invoice paid, or building the fixture in production.
// Neither is acceptable, and a fake makes the assertions stronger anyway:
// "no payment row was inserted" is a fact about the call, not about whether
// some id happened to exist.
//
// Only two things are stubbed, both because they are pure database lookups
// with no logic worth testing here: which Stripe account an org is connected
// to, and which org collects for it. Everything else — the signature check,
// the source allowlist, the atomic paid-claim in markInvoicePaidFromStripe,
// planDisputeEvent, paymentIsReversedByDisputes — is the shipped code.

const WEBHOOK_SECRET = "whsec_test_imp6_do_not_use_anywhere_real";

const VICTIM_ORG = "11111111-1111-1111-1111-111111111111";
const ATTACKER_ORG = "22222222-2222-2222-2222-222222222222";
const VICTIM_INVOICE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CLIENT = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const PAYMENT = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const VICTIM_ACCOUNT = "acct_victim";
const ATTACKER_ACCOUNT = "acct_attacker";

const ACCOUNTS: Record<string, string> = {
  [VICTIM_ORG]: VICTIM_ACCOUNT,
  [ATTACKER_ORG]: ATTACKER_ACCOUNT,
};

// ── the fake ───────────────────────────────────────────────────────────────

const fake = createFakeAdmin();

/** Mirrors the SQL's kind mapping (20260731170000). A kind the SQL maps to
 *  NULL files nothing, which is what makes the inquiry cases meaningful. */
const ITEM_KIND: Record<string, string> = {
  refund: "payment_refunded",
  chargeback: "payment_chargeback",
  chargeback_won: "payment_chargeback_won",
  chargeback_lost: "payment_chargeback_lost",
  dispute_inquiry: "payment_dispute_inquiry",
  dispute_inquiry_closed: "payment_dispute_inquiry_closed",
};

// The reversal ledger the handler reads back to decide the payment's status is
// the one this RPC writes, so the fake has to write it too — otherwise the
// "second dispute still open" case can never arise.
fake.onRpc("file_reversal_review_item", (args) => {
  const kind = ITEM_KIND[String(args._kind)];
  if (!kind) return null;
  (fake.tables.review_items ??= []).push({
    organization_id: args._org_id,
    kind,
    subject_id: args._payment_id,
    dispute_ref: args._dispute_ref ?? null,
    detected_at: "2026-08-01T00:00:00Z",
    detail: { amount_cents: args._amount_cents },
  });
  return null;
});
fake.onRpc("record_franchise_adjustment", () => "adj_1");

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, p) => fake.admin[p as keyof typeof fake.admin] }),
}));

vi.mock("@/lib/stripe-connect.server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveOrgStripeAccount: async (orgId: string) =>
    ACCOUNTS[orgId] ? { accountId: ACCOUNTS[orgId] } : null,
  collectingOrgIdFor: async (orgId: string) => orgId,
}));

// Side effects of a successful payment that are not what these tests are
// about, and that would otherwise reach the email queue.
vi.mock("@/lib/activity.server", () => ({ logActivity: async () => {} }));
vi.mock("@/lib/email/enqueue.server", () => ({ enqueueAppEmail: async () => {} }));

// ── driving the shipped handler ────────────────────────────────────────────

async function deliver(type: string, object: Record<string, unknown>, account: string) {
  const body = JSON.stringify({
    id: `evt_${Math.random().toString(36).slice(2)}`,
    object: "event",
    type,
    account,
    data: { object },
  });
  const mod = await import("@/routes/api/public/hooks/stripe");
  const POST = (
    mod.Route as unknown as {
      options: { server: { handlers: { POST: (ctx: { request: Request }) => Promise<Response> } } };
    }
  ).options.server.handlers.POST;
  const res = (await POST({
    request: new Request("https://app.houndstack.com/api/public/hooks/stripe", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": stripeSignature(body, WEBHOOK_SECRET),
      },
      body,
    }),
  })) as Response;
  return res;
}

const openInvoice = () => ({
  id: VICTIM_INVOICE,
  organization_id: VICTIM_ORG,
  client_id: CLIENT,
  total_cents: 12_500,
  currency: "usd",
  status: "open",
  paid_at: null,
  stripe_payment_intent_id: null,
});

const paidPi = (metadata: Record<string, string>) => ({
  id: "pi_imp6",
  amount: 12_500,
  currency: "usd",
  metadata,
});

beforeAll(async () => {
  // The handler resolves these with `await import(...)` on every request. Two
  // concurrent requests therefore start two concurrent dynamic imports of the
  // same module, and vitest's mocker can lose that race and hand one of them
  // the REAL Supabase client. Resolving them once here puts them in the module
  // registry so the concurrency test measures the claim, not the mocker.
  await import("@/integrations/supabase/client.server");
  await import("@/lib/stripe-connect.server");
  await import("@/lib/invoice-reconcile.server");
});

const paymentRows = () => fake.tables.payments ?? [];
const invoice = () => fake.tables.invoices[0];

beforeEach(() => {
  process.env.STRIPE_CONNECT_SECRET_KEY = "sk_test_imp6_placeholder";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = WEBHOOK_SECRET;
  fake.reset({
    invoices: [openInvoice()],
    payments: [],
    clients: [{ id: CLIENT }],
    review_items: [],
  });
});

describe("paying an invoice", () => {
  it("marks it paid once and records one payment", async () => {
    const res = await deliver(
      "payment_intent.succeeded",
      paidPi({ source: "portal_inline", invoice_id: VICTIM_INVOICE }),
      VICTIM_ACCOUNT,
    );
    expect(res.status).toBe(200);
    expect(invoice().status).toBe("paid");
    expect(paymentRows()).toHaveLength(1);
    expect(paymentRows()[0]).toMatchObject({
      organization_id: VICTIM_ORG,
      invoice_id: VICTIM_INVOICE,
      amount_cents: 12_500,
      status: "succeeded",
    });
  });

  it("does not pay it twice when Stripe redelivers the event", async () => {
    // Stripe retries on any non-2xx and re-sends on its own schedule; a
    // duplicate delivery is normal traffic, not an edge case. Two payment rows
    // would double every revenue figure and, for a franchise, double the
    // royalty. Sequentially, the `inv.status !== "paid"` check stops it.
    const pi = paidPi({ source: "portal_inline", invoice_id: VICTIM_INVOICE });
    await deliver("payment_intent.succeeded", pi, VICTIM_ACCOUNT);
    await deliver("payment_intent.succeeded", pi, VICTIM_ACCOUNT);
    expect(paymentRows()).toHaveLength(1);
  });

  it("marks it paid from a completed Checkout session", async () => {
    // The other pay path. Hosted Checkout carries the invoice on the session,
    // not on the payment intent, and is finalized here rather than by
    // payment_intent.succeeded.
    const res = await deliver(
      "checkout.session.completed",
      {
        id: "cs_imp6",
        mode: "payment",
        amount_total: 12_500,
        currency: "usd",
        payment_intent: "pi_from_checkout",
        metadata: { invoice_id: VICTIM_INVOICE },
      },
      VICTIM_ACCOUNT,
    );
    expect(res.status).toBe(200);
    expect(invoice().status).toBe("paid");
    expect(paymentRows()).toHaveLength(1);
    expect(paymentRows()[0]).toMatchObject({
      stripe_checkout_session_id: "cs_imp6",
      amount_cents: 12_500,
    });
  });

  it("ignores a payment intent whose source is not a PI-first flow", async () => {
    // Checkout is finalized by checkout.session.completed. If this branch also
    // accepted it, the same money would be recorded twice from two events.
    await deliver(
      "payment_intent.succeeded",
      paidPi({ source: "checkout", invoice_id: VICTIM_INVOICE }),
      VICTIM_ACCOUNT,
    );
    expect(invoice().status).toBe("open");
    expect(paymentRows()).toHaveLength(0);
  });

  it("ignores a payment intent carrying no invoice at all", async () => {
    await deliver("payment_intent.succeeded", paidPi({ source: "portal_inline" }), VICTIM_ACCOUNT);
    expect(paymentRows()).toHaveLength(0);
  });
});

describe("two writers arriving at once", () => {
  // The case the `inv.status !== "paid"` check cannot catch, and the reason
  // the atomic claim exists: both writers read the invoice while it is still
  // open, so both get past every status check. What separates them is
  //
  //     .update({status:"paid"}).eq("id",…).neq("status","paid").select()
  //
  // — one changes the row, the other changes nothing, and only the one that
  // changed something records a payment. Real traffic produces this whenever
  // the webhook and the reconcile fallback arrive together, which is exactly
  // when a webhook misconfiguration is being repaired.
  //
  // Driven through markInvoicePaidFromStripe rather than through two HTTP
  // deliveries: the handler re-resolves its modules with `await import()` on
  // every request, and two of those in flight at once race vitest's mocker
  // into handing one of them the real Supabase client. That produced a green
  // test whose second writer had thrown rather than lost — a pass proving the
  // opposite of what it claimed.
  it("records one payment, not two", async () => {
    const { markInvoicePaidFromStripe } = await import("@/lib/invoice-reconcile.server");
    const args = {
      invoiceId: VICTIM_INVOICE,
      organizationId: VICTIM_ORG,
      amountCents: 12_500,
      currency: "usd",
      paymentIntentId: "pi_imp6",
      raw: {},
    };
    const [first, second] = await Promise.all([
      markInvoicePaidFromStripe(fake.admin as unknown as SupabaseClient, args),
      markInvoicePaidFromStripe(fake.admin as unknown as SupabaseClient, args),
    ]);
    // Exactly one writer may claim it. Both true is a double payment; both
    // false means nothing was ever recorded.
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(paymentRows(), "the losing writer recorded a payment too").toHaveLength(1);
    expect(invoice().status).toBe("paid");
  });
});

describe("one tenant cannot pay off another tenant's invoice", () => {
  // Security C1, behaviourally. The attacker controls every field of their own
  // event's metadata, so they put the VICTIM's invoice id in it. They do not
  // control `event.account` — Stripe sets it to the account that raised the
  // event. This is the entire defense.

  it("refuses an event from an account that does not own the invoice", async () => {
    await deliver(
      "payment_intent.succeeded",
      paidPi({ source: "portal_inline", invoice_id: VICTIM_INVOICE }),
      ATTACKER_ACCOUNT,
    );
    expect(invoice().status, "the victim's invoice was marked paid").toBe("open");
    expect(paymentRows(), "a payment was recorded for the victim").toHaveLength(0);
  });

  it("returns 200 so Stripe stops retrying an event that can never apply", async () => {
    // A 4xx/5xx here would put the event into Stripe's retry loop for days and
    // fill the delivery log with failures, which is how a real problem gets
    // missed. "Received and discarded" is the correct answer.
    const res = await deliver(
      "payment_intent.succeeded",
      paidPi({ source: "portal_inline", invoice_id: VICTIM_INVOICE }),
      ATTACKER_ACCOUNT,
    );
    expect(res.status).toBe(200);
  });

  it("refuses a Checkout session from an account that does not own the invoice", async () => {
    // The same attack down the other pay path. Both branches read the invoice
    // id from metadata the attacker wrote, so both need the guard — and a
    // mutation that removed it from only one of them went unnoticed until
    // this test existed.
    await deliver(
      "checkout.session.completed",
      {
        id: "cs_attack",
        mode: "payment",
        amount_total: 12_500,
        currency: "usd",
        payment_intent: "pi_attack",
        metadata: { invoice_id: VICTIM_INVOICE },
      },
      ATTACKER_ACCOUNT,
    );
    expect(invoice().status).toBe("open");
    expect(paymentRows()).toHaveLength(0);
  });

  it("refuses a Checkout session naming the invoice by client_reference_id", async () => {
    // `client_reference_id` is the other way in — the branch accepts it as a
    // fallback for the invoice id, and it is equally attacker-controlled.
    await deliver(
      "checkout.session.completed",
      {
        id: "cs_attack_ref",
        mode: "payment",
        amount_total: 12_500,
        currency: "usd",
        client_reference_id: VICTIM_INVOICE,
      },
      ATTACKER_ACCOUNT,
    );
    expect(invoice().status).toBe("open");
    expect(paymentRows()).toHaveLength(0);
  });

  it("refuses an event from an account connected to no organization", async () => {
    await deliver(
      "payment_intent.succeeded",
      paidPi({ source: "portal_inline", invoice_id: VICTIM_INVOICE }),
      "acct_not_connected_to_anything",
    );
    expect(invoice().status).toBe("open");
    expect(paymentRows()).toHaveLength(0);
  });
});

describe("a reversal", () => {
  const succeeded = () => ({
    id: PAYMENT,
    organization_id: VICTIM_ORG,
    amount_cents: 12_500,
    status: "succeeded",
    stripe_payment_intent_id: "pi_imp6",
  });

  beforeEach(() => {
    fake.tables.payments = [succeeded()];
  });

  const payment = () => fake.tables.payments[0];
  const adjustments = () => fake.rpcs.filter((r) => r.fn === "record_franchise_adjustment");

  it("bills the franchise and marks the payment refunded on a real chargeback", async () => {
    await deliver(
      "charge.dispute.created",
      { id: "dp_1", status: "needs_response", amount: 12_500, payment_intent: "pi_imp6" },
      VICTIM_ACCOUNT,
    );
    expect(adjustments()).toHaveLength(1);
    expect(adjustments()[0].args).toMatchObject({
      _payment_id: PAYMENT,
      _kind: "chargeback",
      _amount_cents: 12_500,
      // The dispute's own id, not the payment's. A payment can be disputed
      // more than once and keying on the payment discarded every dispute
      // after the first (20260801070000).
      _dispute_ref: "dp_1",
    });
    expect(payment().status).toBe("refunded");
  });

  it("takes no money and bills nobody for a bank inquiry", async () => {
    // BUILD-12's central case. An inquiry withdraws nothing. Treating it as a
    // chargeback deducts the amount from revenue and charges a franchise
    // location for money that never left anyone's account.
    await deliver(
      "charge.dispute.created",
      { id: "dp_2", status: "warning_needs_response", amount: 12_500, payment_intent: "pi_imp6" },
      VICTIM_ACCOUNT,
    );
    expect(adjustments(), "an inquiry was billed as a chargeback").toHaveLength(0);
    expect(payment().status).toBe("succeeded");
    // It is still filed, because the owner has to answer it — an unanswered
    // inquiry is what becomes a chargeback.
    expect(fake.rpcs.some((r) => r.fn === "file_reversal_review_item")).toBe(true);
  });

  it("takes no money when a dropped inquiry closes", async () => {
    await deliver(
      "charge.dispute.closed",
      { id: "dp_3", status: "warning_closed", amount: 12_500, payment_intent: "pi_imp6" },
      VICTIM_ACCOUNT,
    );
    expect(adjustments()).toHaveLength(0);
    expect(payment().status).toBe("succeeded");
  });

  it("restores the payment when a chargeback is won", async () => {
    // The money comes back, so the payment is revenue again.
    fake.tables.payments = [{ ...succeeded(), status: "refunded" }];
    fake.tables.review_items = [
      {
        organization_id: VICTIM_ORG,
        kind: "payment_chargeback",
        subject_id: PAYMENT,
        dispute_ref: "dp_4",
        detected_at: "2026-07-01T00:00:00Z",
        detail: { amount_cents: 12_500 },
      },
    ];
    await deliver(
      "charge.dispute.closed",
      { id: "dp_4", status: "won", amount: 12_500, payment_intent: "pi_imp6" },
      VICTIM_ACCOUNT,
    );
    expect(payment().status).toBe("succeeded");
  });

  it("does not restore a payment that carries a second, still-open dispute", async () => {
    // Deriving the status from the WHOLE ledger rather than from this one
    // event. Flipping straight to 'succeeded' on a win restored the full gross
    // of a payment the bank was still holding money against.
    fake.tables.payments = [{ ...succeeded(), status: "refunded" }];
    fake.tables.review_items = [
      {
        organization_id: VICTIM_ORG,
        kind: "payment_chargeback",
        subject_id: PAYMENT,
        dispute_ref: "dp_5",
        detected_at: "2026-07-01T00:00:00Z",
        detail: { amount_cents: 6_000 },
      },
      {
        organization_id: VICTIM_ORG,
        kind: "payment_chargeback",
        subject_id: PAYMENT,
        dispute_ref: "dp_6",
        detected_at: "2026-07-02T00:00:00Z",
        detail: { amount_cents: 6_500 },
      },
    ];
    await deliver(
      "charge.dispute.closed",
      { id: "dp_5", status: "won", amount: 6_000, payment_intent: "pi_imp6" },
      VICTIM_ACCOUNT,
    );
    expect(payment().status, "dp_6 is still open and its money is still gone").toBe("refunded");
  });

  it("refuses a reversal raised by an account that does not own the payment", async () => {
    await deliver(
      "charge.dispute.created",
      { id: "dp_7", status: "needs_response", amount: 12_500, payment_intent: "pi_imp6" },
      ATTACKER_ACCOUNT,
    );
    expect(adjustments()).toHaveLength(0);
    expect(payment().status).toBe("succeeded");
  });

  it("marks a refunded charge refunded", async () => {
    await deliver(
      "charge.refunded",
      { id: "ch_1", amount_refunded: 12_500, payment_intent: "pi_imp6" },
      VICTIM_ACCOUNT,
    );
    expect(adjustments()[0].args).toMatchObject({ _kind: "refund", _amount_cents: 12_500 });
    expect(payment().status).toBe("refunded");
  });

  it("ignores a reversal for a payment intent this system never recorded", async () => {
    fake.tables.payments = [];
    const res = await deliver(
      "charge.dispute.created",
      { id: "dp_8", status: "needs_response", amount: 12_500, payment_intent: "pi_unknown" },
      VICTIM_ACCOUNT,
    );
    expect(res.status).toBe(200);
    expect(fake.rpcs).toHaveLength(0);
  });
});

describe("connect account state", () => {
  it("keys charge-readiness on the account id, never on metadata", async () => {
    fake.tables.organizations = [
      { stripe_connect_account_id: VICTIM_ACCOUNT, stripe_connect_charges_enabled: false },
    ];
    await deliver(
      "account.updated",
      { id: VICTIM_ACCOUNT, charges_enabled: true, payouts_enabled: true, details_submitted: true },
      VICTIM_ACCOUNT,
    );
    expect(fake.tables.organizations[0].stripe_connect_charges_enabled).toBe(true);
    const update = fake.writes.find((w) => w.table === "organizations" && w.op === "update");
    expect(update?.payload).toHaveProperty("stripe_connect_status");
  });
});
