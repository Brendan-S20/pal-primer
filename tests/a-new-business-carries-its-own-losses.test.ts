/**
 * A new business carries its own losses (#825, acceptance item 3).
 *
 * Brendan, 2026-11-10, 1:57 AM ET: "Make new businesses liable, if Stripe
 * allows". Stripe allows it, generally available, with its Standard controller
 * settings: losses.payments "stripe", fees.payer "account",
 * requirement_collection "stripe", stripe_dashboard "full". Accounts that
 * already exist stay exactly as they are (Express: losses.payments
 * "application", fees.payer "application_express"), because Stripe fixes the
 * dashboard type and fee payer when an account is created.
 *
 * And the fee math has to follow the account: an old Express account still has
 * Radar passed through (the platform is billed), a new one never does (Stripe
 * bills the business, and adding it would bill them twice).
 *
 * Fixtures only. Nothing here talks to Stripe.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const h = vi.hoisted(() => ({
  orgRow: null as Record<string, unknown> | null,
  updates: [] as Array<Record<string, unknown>>,
  stripe: null as unknown as ReturnType<typeof fakeStripe>,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  type Chain = Record<string, unknown>;
  const p: Chain = {
    select: () => p,
    eq: () => p,
    update: (patch: Record<string, unknown>) => {
      h.updates.push(patch);
      return p;
    },
    maybeSingle: () => Promise.resolve({ data: h.orgRow }),
    then: (r: (v: unknown) => unknown, j: (e: unknown) => unknown) =>
      Promise.resolve({ data: null, error: null }).then(r, j),
  };
  return { supabaseAdmin: { from: () => p } };
});

vi.mock("@/lib/stripe-client.server", () => ({
  makeStripe: async () => h.stripe,
  STRIPE_API_VERSION: "2026-08-26.dahlia",
}));

import {
  NEW_CONNECTED_ACCOUNT_CONTROLLER,
  ensureConnectedAccount,
  newConnectedAccountParams,
} from "@/lib/stripe-connect.server";
import { NEW_CONNECTED_ACCOUNT_FEE_PAYER } from "@/lib/connect-account-settings";
import { radarPassThrough } from "@/lib/connect-fee-payer.server";
import { radarFeeSentence, withPassThroughFees } from "@/lib/radar-fee";
import { createCardPresentIntent, TAP_TO_PAY_FEE_CENTS } from "@/lib/tap-to-pay.server";
import { platformFeeCents } from "@/lib/platform-fee";

const ORG = "342d4d1e-56f7-4b6e-ad40-524d370e1a36";

/** A live account as it exists today: legacy Express. */
const EXISTING_EXPRESS = Object.freeze({
  id: "acct_existing_express",
  type: "express",
  controller: Object.freeze({
    type: "application",
    is_controller: true,
    fees: Object.freeze({ payer: "application_express" }),
    losses: Object.freeze({ payments: "application" }),
    requirement_collection: "stripe",
    stripe_dashboard: Object.freeze({ type: "express" }),
  }),
});

/** An account created from #825 on, as Stripe reports it. */
const NEW_STANDARD = Object.freeze({
  id: "acct_new_standard",
  type: "standard",
  controller: Object.freeze({
    type: "application",
    is_controller: true,
    fees: Object.freeze({ payer: "account" }),
    losses: Object.freeze({ payments: "stripe" }),
    requirement_collection: "stripe",
    stripe_dashboard: Object.freeze({ type: "full" }),
  }),
});

function fakeStripe(account: unknown = NEW_STANDARD) {
  return {
    accounts: {
      create: vi.fn(async () => ({ id: "acct_created", charges_enabled: false })),
      update: vi.fn(),
      del: vi.fn(),
      retrieve: vi.fn(async () => account),
    },
    terminal: {} as never,
    paymentIntents: {
      retrieve: vi.fn(),
      cancel: vi.fn(),
      create: vi.fn(async (params: unknown) => ({ id: "pi_x", params })),
    },
  };
}

beforeEach(() => {
  process.env.STRIPE_CONNECT_SECRET_KEY = "sk_test_fixture_not_a_key";
  h.orgRow = null;
  h.updates = [];
  h.stripe = fakeStripe();
});
afterEach(() => vi.clearAllMocks());

describe("the controller a new account is created with", () => {
  it("is Stripe's Standard configuration, so the business is liable", () => {
    expect(NEW_CONNECTED_ACCOUNT_CONTROLLER).toEqual({
      fees: { payer: "account" },
      losses: { payments: "stripe" },
      requirement_collection: "stripe",
      stripe_dashboard: { type: "full" },
    });
  });

  it("is written as controller properties, with no legacy type and nothing Express", () => {
    const params = newConnectedAccountParams({
      orgId: ORG,
      email: "o@example.com",
      businessName: "Scoops",
    });
    expect(params).not.toHaveProperty("type");
    expect(params.controller).toEqual(NEW_CONNECTED_ACCOUNT_CONTROLLER);
    expect(JSON.stringify(params)).not.toMatch(/express/);
    // application_express is not a creation parameter at all; it is what
    // Stripe assigns to `type: "express"`.
    expect(JSON.stringify(params)).not.toMatch(/application_express/);
  });

  it("keeps the rest of the create call as it was", () => {
    const params = newConnectedAccountParams({
      orgId: ORG,
      email: "o@example.com",
      businessName: "Scoops",
    });
    expect(params.country).toBe("US");
    expect(params.email).toBe("o@example.com");
    expect(params.business_profile).toEqual({ name: "Scoops" });
    expect(params.capabilities).toEqual({
      card_payments: { requested: true },
      transfers: { requested: true },
    });
    expect(params.metadata).toEqual({ organization_id: ORG });
  });

  it("is a fresh object each time, so a caller cannot edit the constant through it", () => {
    const a = newConnectedAccountParams({ orgId: ORG });
    (a.controller.fees as { payer: string }).payer = "application";
    expect(NEW_CONNECTED_ACCOUNT_CONTROLLER.fees.payer).toBe("account");
    expect(newConnectedAccountParams({ orgId: ORG }).controller.fees.payer).toBe("account");
  });

  it("matches what the Payments page tells a business before it connects", () => {
    expect(NEW_CONNECTED_ACCOUNT_FEE_PAYER).toBe("account");
  });
});

describe("creating one", () => {
  it("creates the account with those settings when the org has none", async () => {
    h.orgRow = null; // no account yet; org name lookup returns nothing
    const id = await ensureConnectedAccount(ORG, "o@example.com");
    expect(id).toBe("acct_created");
    expect(h.stripe.accounts.create).toHaveBeenCalledTimes(1);
    const [params] = h.stripe.accounts.create.mock.calls[0];
    expect(params.controller).toEqual(NEW_CONNECTED_ACCOUNT_CONTROLLER);
    expect(params).not.toHaveProperty("type");
    expect(h.updates[0]).toMatchObject({ stripe_connect_account_id: "acct_created" });
  });

  it("leaves an existing account alone: no create, no update, no migration", async () => {
    h.orgRow = {
      stripe_connect_account_id: EXISTING_EXPRESS.id,
      stripe_connect_charges_enabled: true,
    };
    const before = JSON.stringify(EXISTING_EXPRESS);
    expect(await ensureConnectedAccount(ORG, "o@example.com")).toBe(EXISTING_EXPRESS.id);
    expect(h.stripe.accounts.create).not.toHaveBeenCalled();
    expect(h.stripe.accounts.update).not.toHaveBeenCalled();
    expect(h.stripe.accounts.del).not.toHaveBeenCalled();
    expect(h.stripe.accounts.retrieve).not.toHaveBeenCalled();
    expect(h.updates).toEqual([]);
    expect(JSON.stringify(EXISTING_EXPRESS)).toBe(before);
  });

  it("nothing in src updates an account's controller or creates an Express account", () => {
    const code = (p: string) =>
      readFileSync(p, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
    const server = code("src/lib/stripe-connect.server.ts");
    expect(server).not.toMatch(/type:\s*"express"/);
    expect(server).toMatch(/stripe\.accounts\.create\(\s*newConnectedAccountParams\(/);
    for (const f of [
      "src/lib/stripe-connect.server.ts",
      "src/lib/stripe-connect.functions.ts",
      "src/lib/connect-fee-payer.server.ts",
    ]) {
      expect(code(f), f).not.toMatch(/accounts\.update\(/);
    }
  });

  it("uses no preview Stripe API version", () => {
    // Express Dashboard + losses.payments "stripe" is a public preview that
    // needs a preview version; this change deliberately does not use it.
    const pinned = readFileSync("src/lib/stripe-client.server.ts", "utf8");
    expect(pinned).toMatch(/STRIPE_API_VERSION: PinnedApiVersion = "2026-08-26\.dahlia"/);
    expect(pinned).not.toMatch(/\.preview"/);
    expect(readFileSync("src/lib/stripe-connect.server.ts", "utf8")).not.toMatch(
      /apiVersion|Stripe-Version|\.preview"/,
    );
  });
});

describe("the fee math follows the account", () => {
  it("an existing Express account still passes Radar through: the platform is billed", async () => {
    const r = await radarPassThrough(fakeStripe(EXISTING_EXPRESS), EXISTING_EXPRESS.id, ["card"]);
    expect(r.cents).toBe(5);
    expect(r.metadata).toEqual({ radar_fee_cents: "5", connect_fee_payer: "application_express" });
    expect(withPassThroughFees(platformFeeCents(6000), r.cents)).toBe(5);
  });

  it("a new Standard account passes nothing: Stripe bills Radar to the business", async () => {
    const r = await radarPassThrough(fakeStripe(NEW_STANDARD), NEW_STANDARD.id, ["card"]);
    expect(r.cents).toBe(0);
    expect(r.metadata).toEqual({ radar_fee_cents: "0", connect_fee_payer: "account" });
    // The application fee is HoundStack's own fee only, which is none today,
    // so the key stays omitted rather than set to anything of Stripe's.
    expect(withPassThroughFees(platformFeeCents(6000), r.cents)).toBeUndefined();
    expect(withPassThroughFees(50, r.cents)).toBe(50);
  });

  it("neither account's fixture is changed by being read", async () => {
    const before = [JSON.stringify(EXISTING_EXPRESS), JSON.stringify(NEW_STANDARD)];
    await radarPassThrough(fakeStripe(EXISTING_EXPRESS), "acct", ["card"]);
    await radarPassThrough(fakeStripe(NEW_STANDARD), "acct", ["card"]);
    expect([JSON.stringify(EXISTING_EXPRESS), JSON.stringify(NEW_STANDARD)]).toEqual(before);
  });

  const invoice = {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    organization_id: ORG,
    total_cents: 6000,
    tax_cents: 0,
    currency: "usd",
    stripe_payment_intent_id: null,
  };

  for (const [name, account] of [
    ["an existing Express account", EXISTING_EXPRESS],
    ["a new Standard account", NEW_STANDARD],
  ] as const) {
    it(`a tap on ${name} adds neither the tap fee nor Radar: Stripe bills both to the business`, async () => {
      const stripe = fakeStripe(account);
      await createCardPresentIntent(stripe as never, account.id, invoice, 6000, null);
      const [params] = stripe.paymentIntents.create.mock.calls[0] as [
        { application_fee_amount?: number; metadata: Record<string, string> },
      ];
      expect(params.application_fee_amount).toBeUndefined();
      expect(params.metadata.tap_to_pay_fee_cents).toBe("0");
      expect(params.metadata.radar_fee_cents).toBe("0");
      expect(params.metadata.connect_fee_payer).toBe(account.controller.fees.payer);
    });
  }

  it("a tap still carries the tap fee where the platform is billed (application)", async () => {
    const stripe = fakeStripe({ id: "acct_app", controller: { fees: { payer: "application" } } });
    await createCardPresentIntent(stripe as never, "acct_app", invoice, 6000, null);
    const [params] = stripe.paymentIntents.create.mock.calls[0] as [
      { application_fee_amount?: number; metadata: Record<string, string> },
    ];
    expect(params.application_fee_amount).toBe(TAP_TO_PAY_FEE_CENTS);
  });
});

describe("what each business is told", () => {
  it("a new business is not quoted five cents Stripe does not bill through HoundStack", () => {
    const s = radarFeeSentence("account");
    expect(s).not.toContain("$0.05");
    expect(s).not.toMatch(/application fee/);
    expect(s).toMatch(/Stripe Dashboard/);
    expect(s).not.toMatch(/Express/);
    expect(s).not.toMatch(/—|–/);
  });

  it("an existing Express business is told the five cents", () => {
    expect(radarFeeSentence("application_express")).toContain("$0.05");
    expect(radarFeeSentence(null)).toContain("$0.05");
  });

  it("the Payments page reads the business's own fee payer, and uses the new one before connecting", () => {
    const src = readFileSync("src/routes/_authenticated/payments.tsx", "utf8");
    expect(src).toMatch(/radarFeeSentence\(NEW_CONNECTED_ACCOUNT_FEE_PAYER\)/);
    expect(src).toMatch(/radarFeeSentence\(feePayerQ\.data\?\.feePayer\)/);
    expect(src).toMatch(/useServerFn\(getStripeConnectFeePayer\)/);
  });
});
