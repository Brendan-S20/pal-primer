// Removing a saved card removes it IN STRIPE (Brendan, 2026-11-09, on #748).
//
// A locked owner (trial over, no active plan) still reaches Plan & billing,
// and removing a card there must detach it from the org's platform customer,
// not only drop it from the list. A detach Stripe refuses is an error the
// owner sees, never "Card removed"; a card that is already detached (or
// deleted) is the outcome that was asked for.
//
// The same rule for a client removing their card in the portal, which until
// this change swallowed a failed detach and cleared our copy anyway.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serverFnOpenWhenLocked } from "@/lib/account-lock";
import { removeOrgCard, type OrgCardStripe } from "@/lib/org-card-removal.server";
import {
  CARD_NOT_REMOVED_MESSAGE,
  detachPaymentMethod,
  isAlreadyDetachedError,
} from "@/lib/stripe-detach.server";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const CUS = "cus_org1";
const stripeErr = (code: string, message: string) => Object.assign(new Error(message), { code });

function fakeStripe(
  opts: {
    attachedTo?: string | null;
    retrieveError?: Error;
    detachError?: Error;
    cards?: string[];
    /** The customer's invoice default and the subscription's default. */
    customerDefault?: string | null;
    subDefault?: string | null;
  } = {},
) {
  const state = {
    customerDefault: opts.customerDefault === undefined ? "pm_1" : opts.customerDefault,
    subDefault: opts.subDefault === undefined ? "pm_1" : opts.subDefault,
  };
  // What is attached right now; a successful detach takes the card off it.
  const cards = [...(opts.cards ?? ["pm_1"])];
  const calls = {
    detach: [] as string[],
    customerUpdate: [] as unknown[],
    subUpdate: [] as unknown[],
  };
  const stripe: OrgCardStripe = {
    paymentMethods: {
      retrieve: vi.fn(async () => {
        if (opts.retrieveError) throw opts.retrieveError;
        return { customer: opts.attachedTo === undefined ? CUS : opts.attachedTo };
      }),
      detach: vi.fn(async (id: string) => {
        calls.detach.push(id);
        if (opts.detachError) throw opts.detachError;
        if (cards.includes(id)) cards.splice(cards.indexOf(id), 1);
        return { id, customer: null };
      }),
    },
    customers: {
      retrieve: vi.fn(async () => ({
        id: CUS,
        invoice_settings: { default_payment_method: state.customerDefault },
      })),
      listPaymentMethods: vi.fn(async () => ({ data: cards.map((id) => ({ id, card: {} })) })),
      update: vi.fn(async (_id: string, p: object) => {
        calls.customerUpdate.push(p);
        state.customerDefault = (
          p as { invoice_settings: { default_payment_method: string } }
        ).invoice_settings.default_payment_method;
        return {};
      }),
    },
    subscriptions: {
      retrieve: vi.fn(async () => ({ default_payment_method: state.subDefault })),
      update: vi.fn(async (_id: string, p: object) => {
        calls.subUpdate.push(p);
        state.subDefault = (p as { default_payment_method: string }).default_payment_method;
        return {};
      }),
    },
  };
  return { stripe, calls };
}

// The locked owner: trial ended, no subscription.
const lockedOwner = (stripe: OrgCardStripe, paymentMethodId = "pm_1") =>
  removeOrgCard({
    stripe,
    customerId: CUS,
    subscriptionId: null,
    billingStatus: "free",
    paymentMethodId,
    defaultIdFor: async () => "pm_1",
  });

afterEach(() => vi.restoreAllMocks());

describe("a locked owner removing their saved card", () => {
  it("reaches the removal: Plan & billing stays open while the account is locked", () => {
    expect(
      serverFnOpenWhenLocked({
        filename: "src/lib/billing.functions.ts",
        name: "removeOrgPaymentMethod",
      }),
    ).toBe(true);
  });

  it("detaches the card in Stripe, on the platform customer", async () => {
    const { stripe, calls } = fakeStripe();
    await expect(lockedOwner(stripe)).resolves.toEqual({ ok: true, outcome: "detached" });
    expect(calls.detach).toEqual(["pm_1"]);
    // The platform customer, not a connected account.
    expect(stripe.paymentMethods.detach).toHaveBeenCalledWith("pm_1");
  });

  it("promotes another card to default when the default is removed", async () => {
    const { stripe, calls } = fakeStripe({ cards: ["pm_1", "pm_2"] });
    await lockedOwner(stripe);
    expect(calls.detach).toEqual(["pm_1"]);
    expect(calls.customerUpdate).toEqual([
      { invoice_settings: { default_payment_method: "pm_2" } },
    ]);
  });

  it("surfaces a Stripe failure as an error, logged, and never claims success", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { stripe } = fakeStripe({ detachError: stripeErr("api_error", "Stripe is down") });
    await expect(lockedOwner(stripe)).rejects.toThrow(CARD_NOT_REMOVED_MESSAGE);
    expect(err).toHaveBeenCalledWith(
      "[org-card-removal] card detach failed",
      "pm_1",
      "api_error",
      "Stripe is down",
    );
  });

  it("does not promote a new default when the detach failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { stripe, calls } = fakeStripe({
      cards: ["pm_1", "pm_2"],
      detachError: stripeErr("rate_limit", "Too many requests"),
    });
    await expect(lockedOwner(stripe)).rejects.toThrow(CARD_NOT_REMOVED_MESSAGE);
    expect(calls.customerUpdate).toEqual([]);
  });

  it("treats a card Stripe says is already detached as removed", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { stripe } = fakeStripe({
      detachError: stripeErr(
        "payment_method_unexpected_state",
        "The payment method you provided is not attached to a customer so detachment is impossible.",
      ),
    });
    await expect(lockedOwner(stripe)).resolves.toEqual({ ok: true, outcome: "already_detached" });
  });

  it("treats a card already attached to nobody, or deleted, as removed without calling detach", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const detachedAlready = fakeStripe({ attachedTo: null });
    await expect(lockedOwner(detachedAlready.stripe)).resolves.toEqual({
      ok: true,
      outcome: "already_detached",
    });
    expect(detachedAlready.calls.detach).toEqual([]);

    const deleted = fakeStripe({
      retrieveError: stripeErr("resource_missing", "No such PaymentMethod: 'pm_1'"),
    });
    await expect(lockedOwner(deleted.stripe)).resolves.toEqual({
      ok: true,
      outcome: "already_detached",
    });
    expect(deleted.calls.detach).toEqual([]);
  });

  it("a retry after a failed promote finishes the job: the default moves to a card still attached", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    // pm_1 was detached last time, but promoting pm_2 failed, so the
    // subscription's default is still the detached pm_1.
    const { stripe, calls } = fakeStripe({ attachedTo: null, cards: ["pm_2"] });
    await expect(
      removeOrgCard({
        stripe,
        customerId: CUS,
        subscriptionId: "sub_1",
        billingStatus: "active",
        paymentMethodId: "pm_1",
        defaultIdFor: async () => "pm_1",
      }),
    ).resolves.toEqual({ ok: true, outcome: "already_detached" });
    expect(calls.detach).toEqual([]);
    expect(calls.customerUpdate).toEqual([
      { invoice_settings: { default_payment_method: "pm_2" } },
    ]);
    expect(calls.subUpdate).toEqual([{ default_payment_method: "pm_2" }]);
  });

  it("a retry finishes a subscription default the first attempt left on the detached card", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    // Last time: pm_1 detached, the customer moved to pm_2, the subscription
    // update failed. The customer default is valid; the subscription's is not.
    const { stripe, calls } = fakeStripe({
      attachedTo: null,
      cards: ["pm_2"],
      customerDefault: "pm_2",
      subDefault: "pm_1",
    });
    await removeOrgCard({
      stripe,
      customerId: CUS,
      subscriptionId: "sub_1",
      billingStatus: "active",
      paymentMethodId: "pm_1",
      defaultIdFor: async () => "pm_2",
    });
    expect(calls.customerUpdate).toEqual([]);
    expect(calls.subUpdate).toEqual([{ default_payment_method: "pm_2" }]);
  });

  it("leaves the default alone when a card that was not the default is removed", async () => {
    const { stripe, calls } = fakeStripe({ cards: ["pm_1", "pm_2"] });
    await removeOrgCard({
      stripe,
      customerId: CUS,
      subscriptionId: null,
      billingStatus: "free",
      paymentMethodId: "pm_2",
      defaultIdFor: async () => "pm_1",
    });
    expect(calls.detach).toEqual(["pm_2"]);
    expect(calls.customerUpdate).toEqual([]);
  });

  it("still refuses a card that belongs to someone else", async () => {
    const { stripe, calls } = fakeStripe({ attachedTo: "cus_someone_else" });
    await expect(lockedOwner(stripe)).rejects.toThrow("That card doesn't belong to your account.");
    expect(calls.detach).toEqual([]);
  });

  it("is what removeOrgPaymentMethod runs", () => {
    const src = read("src/lib/billing.functions.ts");
    const fn = src.slice(src.indexOf("export const removeOrgPaymentMethod"));
    expect(fn.slice(0, fn.indexOf("export const", 10))).toMatch(/removeOrgCard\(/);
  });
});

describe("the detach itself", () => {
  it("knows Stripe's ways of saying already gone, and nothing else", () => {
    expect(isAlreadyDetachedError(stripeErr("resource_missing", "No such PaymentMethod"))).toBe(
      true,
    );
    expect(isAlreadyDetachedError(stripeErr("api_error", "boom"))).toBe(false);
    expect(isAlreadyDetachedError(stripeErr("card_declined", "declined"))).toBe(false);
  });

  it("detaches on a connected account when one is named", async () => {
    const detach = vi.fn(async () => ({}));
    await detachPaymentMethod({ paymentMethods: { detach } }, "pm_9", {
      stripeAccount: "acct_1",
      context: "test",
    });
    expect(detach).toHaveBeenCalledWith("pm_9", {}, { stripeAccount: "acct_1" });
  });
});

describe("a client removing their card in the portal", () => {
  const src = read("src/lib/portal.functions.ts");
  const fn = src.slice(src.indexOf("export const portalRemoveCard"));
  const body = fn.slice(0, fn.indexOf("export const", 10));

  it("detaches through the same rule, and no longer swallows a failure", () => {
    expect(body).toMatch(/detachPaymentMethod\(/);
    expect(body).not.toMatch(/catch \(e\)/);
    // The detach comes before our copy is cleared, so a throw leaves it intact.
    expect(body.indexOf("detachPaymentMethod(")).toBeLessThan(
      body.indexOf("default_payment_method_id: null"),
    );
  });

  it("is not refused by the charge lock: removing a card is not a charge", () => {
    expect(body).not.toMatch(/loadStripe\(|requireOrgStripeAccount\(/);
    expect(body).toMatch(/resolveOrgStripeAccount\(/);
  });
});
