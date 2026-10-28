// A groom can be booked from the booking link (#560).
//
// Brendan, 2026-10-28: a groom on the link needs both paths. The priced
// request stays; beside it, a visitor picks a day and an open start time and
// pays for the first groom. The webhook books it with the office's own
// bookGroomAppointment, for the pets it has just written with the size each
// was priced at.
//
// The pure rules are tested directly. The booking is driven through the
// shipped webhook with a fake supabaseAdmin, as
// a-signup-that-paid-for-a-first-cleanup-gets-an-invoice-for-it.test.ts
// drives it, so what is asserted is what provisionSignup actually did.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeAdmin, stripeSignature } from "./helpers/fake-supabase";
import { bookingCadenceLabel } from "@/lib/booking-copy";
import { priceVisitWithExtras } from "@/lib/booking-extras";
import { groomQuote } from "@/lib/groom";
import { signupChargeFromQuote } from "@/lib/signup-charge";
import {
  bookedGroomPhrase,
  bookedGroomSentence,
  groomDayProblem,
  groomEveryWeeks,
  groomTimeLabel,
  onlineGroomBookingFrom,
  onlineGroomStarts,
} from "@/lib/groom-online";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

// ── The rules ───────────────────────────────────────────────────────────────

describe("the rules for a groom booked online", () => {
  it("repeats in whole weeks, from the cadence the form offered", () => {
    expect(groomEveryWeeks("biweekly")).toBe(2);
    expect(groomEveryWeeks("monthly")).toBe(4);
    expect(groomEveryWeeks("twice_weekly")).toBeNull();
  });

  it("refuses a day the business cannot groom on, in words", () => {
    const base = { earliest: "2026-11-02", workDays: [1, 2, 3, 4, 5], blackout: false };
    expect(groomDayProblem({ ...base, date: "2026-11-03" })).toBeNull(); // a Tuesday
    expect(groomDayProblem({ ...base, date: "2026-11-01" })).toMatch(/too soon/);
    expect(groomDayProblem({ ...base, date: "2026-11-07" })).toMatch(/don't groom/); // Saturday
    expect(groomDayProblem({ ...base, date: "2026-11-03", blackout: true })).toMatch(/closed/);
    expect(groomDayProblem({ ...base, date: "" })).toMatch(/Pick a day/);
  });

  it("offers only the openings a groom this long fits into, beside every groom that day", () => {
    const open = onlineGroomStarts(90, [{ start: "09:00", minutes: 120 }]);
    expect(open).not.toContain("09:00");
    expect(open).not.toContain("10:45");
    expect(open).toContain("11:00");
    expect(open).toContain("07:00");
    expect(open).not.toContain("07:45"); // 07:45 + 90 runs into 09:00
  });

  it("reads groom_booking defensively", () => {
    expect(onlineGroomBookingFrom(null)).toBeNull();
    expect(onlineGroomBookingFrom({ start_time: "9am" })).toBeNull();
    expect(
      onlineGroomBookingFrom({
        start_time: "09:30",
        pet_sizes: ["small", 3],
        add_on_ids: ["a"],
        every_weeks: 4,
      }),
    ).toEqual({ start_time: "09:30", pet_sizes: ["small"], add_on_ids: ["a"], every_weeks: 4 });
  });

  it("says a time the way a customer reads it", () => {
    expect(groomTimeLabel("09:30")).toBe("9:30 AM");
    expect(groomTimeLabel("12:00")).toBe("12:00 PM");
    expect(groomTimeLabel("15:15")).toBe("3:15 PM");
  });

  it("charges today exactly what the plan and its add-ons will bill for the first groom", () => {
    // The card pays for the first groom: the quote's per-groom total. The
    // plan stores the pets' price and charges each add-on when the groom is
    // done (bookGroomAppointment: price_cents is petCents, groom_addons the
    // rest), so the two must add up to the same number.
    const service = {
      name: "Full groom",
      price_unit: "visit" as const,
      base_price_cents: 8000,
      extra_pet_cents: 0,
      default_duration_min: 90,
    };
    const sizes = [
      { service_id: "g", size: "small" as const, price_cents: 6500 },
      { service_id: "g", size: "large" as const, price_cents: 9500 },
    ];
    const teeth = {
      id: "t",
      name: "Teeth brushing",
      service_line: "mobile_grooming" as const,
      unit_price_cents: 1200,
    };
    const priced = priceVisitWithExtras({
      service,
      baseCents: 16_000,
      petCount: 3,
      sizes: ["small", "large", ""],
      sizePrices: sizes,
      addOns: [teeth],
    });
    const charge = signupChargeFromQuote({
      recurring_price_cents: priced.perVisitCents,
      initial_cleanup_cents: 0,
    });

    const plan = groomQuote({
      service,
      rules: sizes.map((r) => ({
        size: r.size,
        coat_type: null,
        duration_min: 60,
        price_cents: r.price_cents,
      })),
      pets: [
        { id: "1", name: "A", size: "small", coat_type: null },
        { id: "2", name: "B", size: "large", coat_type: null },
        { id: "3", name: "C", size: null, coat_type: null },
      ],
      addons: [{ ...teeth, duration_min: 15, quantity: 1 }],
    });
    const petCents = plan.pets.reduce((sum, p) => sum + (p.cents ?? 0), 0);
    const addOnCents = plan.addons.reduce((sum, a) => sum + a.cents, 0);

    expect(charge.amountCents).toBe(6500 + 9500 + 8000 + 1200);
    expect(charge.amountCents).toBe(petCents + addOnCents);
    expect(charge.firstCleanupCents).toBe(0);
  });

  it("calls a monthly groom what it is: every four weeks", () => {
    expect(groomEveryWeeks("monthly")).toBe(4);
    expect(bookingCadenceLabel("mobile_grooming", "monthly")).toBe("Every 4 weeks");
    expect(bookingCadenceLabel("mobile_grooming", "biweekly")).toBe("Every 2 weeks");
    // Every other line keeps the cadence's own name.
    expect(bookingCadenceLabel("dog_walking", "monthly")).toBe("Monthly");
  });

  it("names the booked day and time, not a day to confirm", () => {
    const when = bookedGroomPhrase("Tuesday, November 3", "09:30");
    expect(when).toBe("Tuesday, November 3 at 9:30 AM");
    expect(bookedGroomSentence(when)).toBe(
      "Your first groom is booked for Tuesday, November 3 at 9:30 AM.",
    );
    const hook = read("src/routes/api/public/hooks/stripe.ts");
    expect(hook).toContain("bookedGroom: bookedGroomPhrase(");
    expect(read("src/lib/email-templates/welcome.tsx")).toContain(
      "Your first groom is booked for {bookedGroom}.",
    );
    expect(read("src/routes/signup.success.tsx")).toContain("bookedGroomSentence(");
  });

  it("checks the time before the card, against every groom on the day", () => {
    const server = read("src/lib/groom-online.server.ts");
    const times = server.slice(server.indexOf("export async function onlineGroomTimes"));
    // Every groom that day, assigned or not.
    expect(times).not.toMatch(/assigned_staff_id/);
    expect(times).toContain('.eq("scheduled_on", date)');
    // A vaccine rule that blocks a pet with no records sends the visitor to
    // the request instead.
    expect(server).toContain('settings.rule === "block"');
  });
});

// ── The webhook books it ────────────────────────────────────────────────────

const WEBHOOK_SECRET = "whsec_test_groom_online_do_not_use_anywhere_real";
const ORG = "0f000000-0000-4000-8000-0000000000a6";
const ACCOUNT = "acct_groom_online";
const SIGNUP = "5f000000-0000-4000-8000-0000000000a6";
const GROOM = "6f000000-0000-4000-8000-0000000000a6";
const TEETH = "7f000000-0000-4000-8000-0000000000a6";

const fake = createFakeAdmin();
const booked: Array<Record<string, unknown>> = [];

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, p) => fake.admin[p as keyof typeof fake.admin] }),
}));
vi.mock("@/lib/stripe-connect.server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveOrgStripeAccount: async (orgId: string) => (orgId === ORG ? { accountId: ACCOUNT } : null),
  collectingOrgIdFor: async (orgId: string) => orgId,
}));
vi.mock("@/lib/activity.server", () => ({ logActivity: async () => {} }));
vi.mock("@/lib/email/enqueue.server", () => ({ enqueueAppEmail: async () => ({ ok: true }) }));
vi.mock("@/lib/visit-generation.server", () => ({ generateVisitHorizon: async () => 0 }));
vi.mock("@/lib/portal-links.server", () => ({ buildPortalLink: async () => "https://x.test/p" }));
// The office's booking, which has its own tests: here, what it is asked.
vi.mock("@/lib/groom-booking.server", () => ({
  bookGroomAppointment: async (_db: unknown, input: Record<string, unknown>) => {
    booked.push(input);
    return { visitId: "v1", subscriptionId: "s1" };
  },
}));

async function deliver(type: string, object: Record<string, unknown>) {
  const body = JSON.stringify({
    id: `evt_${Math.random().toString(36).slice(2)}`,
    object: "event",
    type,
    account: ACCOUNT,
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

const signupRow = (over: Record<string, unknown> = {}) => ({
  id: SIGNUP,
  organization_id: ORG,
  zone_id: null,
  status: "pending",
  name: "Dana Whitfield",
  email: "dana@example.test",
  phone: null,
  street: "1 Proof Lane",
  city: "Austin",
  region: "TX",
  postal_code: "78704",
  dog_count: 2,
  frequency: "monthly",
  recurring_price_cents: 14_200,
  initial_cleanup_cents: 0,
  first_cleanup_tier_id: null,
  first_cleanup_label: null,
  currency: "usd",
  refunded_at: null,
  provisioned_client_id: null,
  service_id: GROOM,
  pets: [{ name: "Biscuit", breed: "Poodle" }],
  preferred_start_date: "2026-11-03",
  groom_booking: {
    start_time: "09:30",
    pet_sizes: ["small", "large"],
    add_on_ids: [TEETH],
    every_weeks: 4,
  },
  ...over,
});

beforeAll(async () => {
  await import("@/integrations/supabase/client.server");
  await import("@/lib/stripe-connect.server");
  await import("@/lib/groom-booking.server");
});

beforeEach(() => {
  process.env.STRIPE_CONNECT_SECRET_KEY = "sk_test_groom_online_placeholder";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = WEBHOOK_SECRET;
  booked.length = 0;
  fake.reset({
    signup_requests: [signupRow()],
    organizations: [{ id: ORG, timezone: "America/Chicago" }],
    clients: [],
    properties: [],
    dogs: [],
    subscriptions: [],
    invoices: [],
    invoice_line_items: [],
    payments: [],
    credit_ledger: [],
  });
});

describe("a groom booked and paid for on the link", () => {
  it("is booked by the office's rule, for the pets it priced, prepaid", async () => {
    const res = await deliver("payment_intent.succeeded", {
      id: "pi_groom_online",
      amount: 14_200,
      currency: "usd",
      metadata: { signup_request_id: SIGNUP, organization_id: ORG, source: "signup_inline" },
    });
    expect(res.status).toBe(200);
    expect(fake.tables.signup_requests[0].status).toBe("provisioned");

    // One pet row per pet counted, named as given or "Pet 2", each with the
    // size it was priced at.
    const dogs = fake.tables.dogs;
    expect(dogs.map((d: Record<string, unknown>) => [d.name, d.breed, d.weight_class])).toEqual([
      ["Biscuit", "Poodle", "small"],
      ["Pet 2", null, "large"],
    ]);

    expect(booked).toHaveLength(1);
    expect(booked[0]).toMatchObject({
      orgId: ORG,
      serviceId: GROOM,
      petIds: dogs.map((d: Record<string, unknown>) => d.id),
      addons: [{ addonServiceId: TEETH, quantity: 1 }],
      scheduledOn: "2026-11-03",
      startTime: "09:30",
      everyWeeks: 4,
      staffId: null,
      billingCadence: "prepaid",
      // The service role has no auth.uid() for the visit wrapper (#560).
      asService: true,
    });
    // The plan is the booking's; no second, plain one is written.
    expect(fake.tables.subscriptions).toHaveLength(0);
    // The card's money is on the client's balance for the first groom.
    expect(fake.tables.credit_ledger).toHaveLength(1);
    expect(fake.tables.credit_ledger[0]).toMatchObject({ delta_cents: 14_200, kind: "prepayment" });
  });

  it("leaves every other signup the plain plan it always was", async () => {
    fake.reset({
      signup_requests: [
        signupRow({ groom_booking: null, service_id: null, frequency: "weekly", pets: [] }),
      ],
      organizations: [{ id: ORG, timezone: "America/Chicago" }],
      clients: [],
      properties: [],
      dogs: [],
      subscriptions: [],
      invoices: [],
      invoice_line_items: [],
      payments: [],
      credit_ledger: [],
    });
    const res = await deliver("payment_intent.succeeded", {
      id: "pi_plain",
      amount: 14_200,
      currency: "usd",
      metadata: { signup_request_id: SIGNUP, organization_id: ORG, source: "signup_inline" },
    });
    expect(res.status).toBe(200);
    expect(booked).toHaveLength(0);
    expect(fake.tables.subscriptions).toHaveLength(1);
    expect(fake.tables.subscriptions[0]).toMatchObject({ billing_cadence: "prepaid" });
  });
});
