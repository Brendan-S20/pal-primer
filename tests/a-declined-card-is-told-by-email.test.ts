import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeAdmin, stripeSignature } from "./helpers/fake-supabase";

// A declined card on autopay is told to the client by email.
//
// Until 2026-10-06 the client heard about a declined autopay charge by text,
// from the PLATFORM's number. Since then a business's clients are texted only
// from the business's own number (endCustomerSmsSender), no business has one
// yet, and so the client heard nothing: autopay failed, the office got an
// in-app notice, and the one person who could fix the card was not told.
//
// Driven through the SHIPPED webhook handler and the REAL enqueueAppEmail,
// with a fake service-role client, so what is asserted is what reached the
// email queue (the `enqueue_email` RPC), rendered by the real template. Only
// the edges are stubbed: Stripe Connect's account lookup, the in-app notice,
// and Twilio, which is stubbed so that a text it was never asked to send can
// be proved never asked for.

const WEBHOOK_SECRET = "whsec_test_declined_do_not_use_anywhere_real";
const ORG = "11111111-1111-1111-1111-111111111111";
const INVOICE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CLIENT = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const ACCOUNT = "acct_declined";
const PORTAL_TOKEN = "tok_declined_portal";

// 2026-10-07 09:00 UTC, the day of the first decline.
const MONDAY_9AM = Date.UTC(2026, 9, 7, 9, 0, 0) / 1000;
const HOUR = 3600;

const fake = createFakeAdmin();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, p) => fake.admin[p as keyof typeof fake.admin] }),
}));
vi.mock("@/lib/stripe-connect.server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveOrgStripeAccount: async (orgId: string) => (orgId === ORG ? { accountId: ACCOUNT } : null),
  collectingOrgIdFor: async (orgId: string) => orgId,
}));
vi.mock("@/lib/activity.server", () => ({ logActivity: async () => {} }));
const officeNotices: Array<Record<string, unknown>> = [];
vi.mock("@/lib/notify-center.server", () => ({
  notifyRoles: async (_roles: string[], n: Record<string, unknown>) => {
    officeNotices.push(n);
  },
}));
const texts: unknown[] = [];
vi.mock("@/lib/twilio.server", () => ({
  sendTwilioSms: async (args: unknown) => {
    texts.push(args);
    return { sid: "SM_should_not_exist", status: "queued" };
  },
}));

async function deliver(
  object: Record<string, unknown>,
  opts: { id?: string; created?: number } = {},
) {
  const body = JSON.stringify({
    id: opts.id ?? `evt_${Math.random().toString(36).slice(2)}`,
    object: "event",
    type: "payment_intent.payment_failed",
    account: ACCOUNT,
    created: opts.created ?? MONDAY_9AM,
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
  expect(res.status).toBe(200);
  return body;
}

/** An autopay charge of $85.00 that the card declined. */
const declined = (over: { id?: string; source?: string } = {}) => ({
  id: over.id ?? "pi_declined_1",
  amount: 8_500,
  currency: "usd",
  status: "requires_payment_method",
  metadata: { source: over.source ?? "autopay", invoice_id: INVOICE, organization_id: ORG },
  last_payment_error: {
    code: "card_declined",
    decline_code: "insufficient_funds",
    message: "Your card has insufficient funds.",
    payment_method: { card: { brand: "visa", last4: "4242" } },
  },
});

/** What reached the email queue: one entry per `enqueue_email` call. */
const queued = () =>
  fake.rpcs
    .filter((r) => r.fn === "enqueue_email")
    .map((r) => r.args.payload as Record<string, string>);

beforeAll(async () => {
  await import("@/integrations/supabase/client.server");
  await import("@/lib/stripe-connect.server");
  await import("@/lib/email/enqueue.server");
  await import("@/lib/declined-card-email.server");
});

beforeEach(() => {
  process.env.STRIPE_CONNECT_SECRET_KEY = "sk_test_declined_placeholder";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = WEBHOOK_SECRET;
  officeNotices.length = 0;
  texts.length = 0;
  fake.reset({
    organizations: [
      {
        id: ORG,
        name: "Detroit Doo Disposal",
        contact_email: "office@detroitdoo.example",
        contact_phone: "(313) 555-0142",
        contact_address: "1 Woodward Ave, Detroit, MI",
        portal_slug: "detroit-doo",
        notify_email_overdue: true,
        // The texting toggle is ON, as it ships. Nothing may be texted
        // anyway: this business has no number of its own.
        notify_sms_payment_failed: true,
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
        primary_email: "pat@example.com",
        primary_phone: "+13135550199",
        email_opt_out: false,
        sms_opt_out: false,
        comms_paused: false,
        portal_token: PORTAL_TOKEN,
        autopay_failure_count: 0,
      },
    ],
    payments: [],
    email_send_log: [],
    suppressed_emails: [],
    client_unsubscribe_tokens: [],
    org_twilio_credentials: [],
  });
});

describe("a declined autopay charge", () => {
  it("sends the client one email, with the invoice, the amount and the portal link", async () => {
    await deliver(declined());

    expect(queued()).toHaveLength(1);
    const email = queued()[0];
    expect(email.to).toBe("pat@example.com");
    // From the business, replies to the business: the same envelope as every
    // other client email.
    expect(email.from).toMatch(/^Detroit Doo Disposal <noreply@/);
    expect(email.reply_to).toBe("office@detroitdoo.example");
    expect(email.label).toBe("payment-failed");
    expect(email.purpose).toBe("transactional");
    expect(email.subject).toBe(
      "Your card was declined for invoice INV-1042 from Detroit Doo Disposal",
    );

    for (const body of [email.html, email.text]) {
      expect(body).toContain("Pat Rivera");
      expect(body).toContain("INV-1042");
      expect(body).toContain("$85.00");
      expect(body).toContain("declined");
      // The overdue reminder's link: the client's own portal, by slug.
      expect(body).toContain(`/portal/detroit-doo/${PORTAL_TOKEN}`);
      // The business's contact details, as every other email shows them.
      expect(body).toContain("(313) 555-0142");
      expect(body).toContain("office@detroitdoo.example");
      expect(body).toContain("1 Woodward Ave, Detroit, MI");
    }
    expect(email.html).toContain("Update card or pay");
  });

  it("never names the decline reason or the card", async () => {
    await deliver(declined());
    const { html, text, subject } = queued()[0];
    for (const body of [html, text, subject]) {
      expect(body).not.toMatch(/insufficient/i);
      expect(body).not.toContain("4242");
      expect(body).not.toMatch(/visa/i);
      expect(body).not.toContain("card_declined");
      expect(body).not.toContain("—");
    }
  });

  it("is idempotent: a redelivery of the same event sends nothing", async () => {
    const event = { id: "evt_declined_once", created: MONDAY_9AM };
    await deliver(declined(), event);
    await deliver(declined(), event);
    expect(queued()).toHaveLength(1);
  });

  it("a redelivery that arrives the NEXT day is still the same decline", async () => {
    // Stripe retries a webhook for up to three days. The key is the day of the
    // decline, from the event, not the day the delivery happened to land.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(MONDAY_9AM * 1000));
      await deliver(declined(), { id: "evt_late", created: MONDAY_9AM });
      vi.setSystemTime(new Date((MONDAY_9AM + 30 * HOUR) * 1000));
      await deliver(declined(), { id: "evt_late", created: MONDAY_9AM });
    } finally {
      vi.useRealTimers();
    }
    expect(queued()).toHaveLength(1);
  });

  it("a second decline the same day sends nothing, and the next day's sends again", async () => {
    await deliver(declined({ id: "pi_monday_1" }), { created: MONDAY_9AM });
    await deliver(declined({ id: "pi_monday_2" }), { created: MONDAY_9AM + 6 * HOUR });
    expect(queued()).toHaveLength(1);

    await deliver(declined({ id: "pi_tuesday" }), { created: MONDAY_9AM + 24 * HOUR });
    expect(queued()).toHaveLength(2);
    // Two distinct messages, so the queue's own already-sent check does not
    // fold Tuesday's into Monday's.
    expect(new Set(queued().map((e) => e.message_id)).size).toBe(2);
  });

  it("tries again on a redelivery when the first one never reached the queue", async () => {
    let failNext = true;
    fake.onRpc("enqueue_email", () => null);
    const realRpc = fake.admin.rpc;
    fake.admin.rpc = async (fn, args) => {
      if (fn === "enqueue_email" && failNext) {
        failNext = false;
        fake.rpcs.push({ fn: "enqueue_email_refused", args });
        return { data: null, error: { message: "queue unavailable" } } as never;
      }
      return realRpc(fn, args);
    };
    try {
      const event = { id: "evt_retry", created: MONDAY_9AM };
      await deliver(declined(), event);
      expect(queued()).toHaveLength(0);
      await deliver(declined(), event);
      expect(queued()).toHaveLength(1);
    } finally {
      fake.admin.rpc = realRpc;
    }
  });

  it("sends nothing to a client who opted out of email", async () => {
    fake.tables.clients[0].email_opt_out = true;
    await deliver(declined());
    expect(queued()).toHaveLength(0);
  });

  it("sends nothing when the business turned overdue and declined-card emails off", async () => {
    fake.tables.organizations[0].notify_email_overdue = false;
    await deliver(declined());
    expect(queued()).toHaveLength(0);
  });

  it("sends nothing to a client on the imported comms hold, or a suppressed address", async () => {
    fake.tables.clients[0].comms_paused = true;
    await deliver(declined({ id: "pi_held" }), { created: MONDAY_9AM });
    fake.tables.clients[0].comms_paused = false;
    fake.tables.suppressed_emails = [{ email: "pat@example.com" }];
    await deliver(declined({ id: "pi_suppressed" }), { created: MONDAY_9AM + 24 * HOUR });
    expect(queued()).toHaveLength(0);
  });

  it("attempts no text message, though the texting toggle is on", async () => {
    await deliver(declined());
    expect(texts).toEqual([]);
    expect(fake.rpcs.some((r) => r.fn === "client_may_be_texted")).toBe(false);
    expect(fake.writes.some((w) => w.table === "messages")).toBe(false);
  });

  it("still tells the office, in the app", async () => {
    await deliver(declined());
    expect(officeNotices).toHaveLength(1);
    expect(officeNotices[0]).toMatchObject({ orgId: ORG, type: "payment_failed" });
  });
});

describe("a decline the client did not need telling about", () => {
  it("is not emailed when the client pressed Pay in their own portal and watched it fail", async () => {
    await deliver(declined({ source: "portal_saved_card" }));
    expect(queued()).toHaveLength(0);
  });

  it("is not emailed when staff charged the card and saw the error", async () => {
    await deliver(declined({ source: "staff_saved_card" }));
    expect(queued()).toHaveLength(0);
  });

  it("is not emailed for a typo in the pay form", async () => {
    await deliver(declined({ source: "portal_inline" }));
    expect(queued()).toHaveLength(0);
  });
});
