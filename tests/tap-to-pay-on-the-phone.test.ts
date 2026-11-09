// Tap to Pay on the phone (#579).
//
// Four things are pinned here:
//   1. the Stripe calls: connection token, the lazily-created Terminal
//      Location, and the card_present PaymentIntent, all on the CONNECTED
//      account (`stripeAccount`), with the same application fee as Take payment;
//   2. the server functions refuse anyone who cannot already Take payment;
//   3. the button is never drawn on the web, on an ineligible phone, or for a
//      role that cannot take a payment;
//   4. the existing payment_intent.succeeded webhook credits the charge without
//      changing (read-only: hooks/stripe.ts is not edited by this feature).
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  allowed: true,
  orgId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  invoice: null as any,
  org: null as any,
  updates: [] as any[],
  stripe: null as any,
  reconcile: "not_paid" as string,
}));

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate = (d: any) => d;
    const b: any = {
      middleware: () => b,
      inputValidator: (v: any) => {
        validate = v;
        return b;
      },
      handler:
        (h: any) =>
        async (opts: any = {}) =>
          h({ data: validate(opts.data), context: { supabase: db(), userId: "user-1" } }),
    };
    return b;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/lib/authz.server", () => ({
  requirePermission: vi.fn(async (_s: unknown, _u: string, permission: string) => {
    if (!state.allowed) throw new Error("Not authorized");
    return { orgId: state.orgId, role: "owner", permission };
  }),
}));
vi.mock("@/lib/stripe-connect.server", () => ({
  requireOrgStripeAccount: vi.fn(async () => ({
    accountId: "acct_tenant",
    chargesEnabled: true,
    collectedByParent: false,
  })),
  connectStripe: vi.fn(async () => state.stripe),
  connectSecret: () => "sk_test_platform",
  verifyClientStripeCustomer: vi.fn(async () => "cus_existing"),
}));
vi.mock("@/lib/invoice-reconcile.server", () => ({
  reconcileInvoicePayment: vi.fn(async () => state.reconcile),
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => {
      const q: any = {
        select: () => q,
        eq: () => q,
        single: async () => ({ data: state.org, error: null }),
      };
      return q;
    },
  },
}));

function db() {
  return {
    from: (table: string) => {
      const q: any = {
        select: () => q,
        eq: () => q,
        update: (row: any) => {
          state.updates.push({ table, row });
          return q;
        },
        single: async () => ({ data: table === "invoices" ? state.invoice : null, error: null }),
        maybeSingle: async () => ({
          data: table === "clients" ? { id: "client-1", stripe_customer_id: "cus_existing" } : null,
          error: null,
        }),
        then: (r: any, j: any) => Promise.resolve({ data: null, error: null }).then(r, j),
      };
      return q;
    },
  };
}

function fakeStripe(opts: { locations?: any[]; existingPi?: any } = {}) {
  return {
    terminal: {
      locations: {
        list: vi.fn(async () => ({ data: opts.locations ?? [] })),
        create: vi.fn(async () => ({ id: "tml_new" })),
      },
      connectionTokens: { create: vi.fn(async () => ({ secret: "pst_test_secret" })) },
    },
    paymentIntents: {
      retrieve: vi.fn(async () => opts.existingPi ?? null),
      cancel: vi.fn(async () => ({})),
      create: vi.fn(async (params: any) => ({
        id: "pi_tap",
        client_secret: "pi_tap_secret",
        currency: params.currency,
      })),
    },
  };
}

import { platformFeeCents } from "@/lib/platform-fee";
import {
  createCardPresentIntent,
  createConnectionToken,
  ensureTerminalLocation,
  parseLocationAddress,
  TAP_TO_PAY_ADDRESS_MISSING,
  TAP_TO_PAY_SOURCE,
} from "@/lib/tap-to-pay.server";
import {
  createTapToPayConnectionToken,
  createTapToPayPaymentIntent,
  prepareTapToPay,
} from "@/lib/tap-to-pay.functions";
import {
  deviceCanTapToPay,
  describeTapToPayError,
  tapToPayGate,
  TAP_TO_PAY_MESSAGES,
  type TapToPayGateInput,
} from "@/lib/tap-to-pay";

const INVOICE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ORG = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "Pawsitive Scoops",
  contact_address: "123 Main St, Springfield, IL 62704",
  country: "US",
};

beforeEach(() => {
  vi.clearAllMocks();
  state.allowed = true;
  state.updates = [];
  state.reconcile = "not_paid";
  state.org = ORG;
  state.stripe = fakeStripe();
  state.invoice = {
    id: INVOICE_ID,
    organization_id: ORG.id,
    client_id: "client-1",
    total_cents: 100,
    tax_cents: 0,
    credit_applied_cents: 0,
    amount_paid_cents: 0,
    currency: "usd",
    status: "open",
    stripe_checkout_session_id: null,
    stripe_payment_intent_id: null,
  };
});

describe("the Terminal Location", () => {
  it("reads the business address the settings form stores", () => {
    expect(parseLocationAddress("123 Main St, Springfield, IL 62704, USA", "US")).toEqual({
      line1: "123 Main St",
      city: "Springfield",
      state: "IL",
      postal_code: "62704",
      country: "US",
    });
    expect(parseLocationAddress("Suite 4, 9 Elm Rd, Austin, tx 78701-1234", null)?.line1).toBe(
      "Suite 4, 9 Elm Rd",
    );
  });

  it("refuses an address it cannot read rather than guessing one", () => {
    expect(parseLocationAddress("", "US")).toBeNull();
    expect(parseLocationAddress("Springfield", "US")).toBeNull();
    expect(parseLocationAddress("123 Main St, Springfield", "US")).toBeNull();
  });

  it("is created on the connected account the first time, once, idempotently", async () => {
    const stripe = fakeStripe();
    const id = await ensureTerminalLocation(stripe as any, "acct_tenant", ORG);
    expect(id).toBe("tml_new");
    expect(stripe.terminal.locations.list).toHaveBeenCalledWith(
      { limit: 100 },
      { stripeAccount: "acct_tenant" },
    );
    const [params, opts] = stripe.terminal.locations.create.mock.calls[0] as any[];
    expect(opts).toEqual({
      stripeAccount: "acct_tenant",
      idempotencyKey: `tap-to-pay-location:${ORG.id}`,
    });
    expect(params.metadata).toEqual({ houndstack_tap_to_pay: "1", organization_id: ORG.id });
    expect(params.address.postal_code).toBe("62704");
  });

  it("is found again afterwards, and another business's location on a shared account is not", async () => {
    const stripe = fakeStripe({
      locations: [
        {
          id: "tml_other",
          metadata: { houndstack_tap_to_pay: "1", organization_id: "someone-else" },
        },
        { id: "tml_mine", metadata: { houndstack_tap_to_pay: "1", organization_id: ORG.id } },
      ],
    });
    expect(await ensureTerminalLocation(stripe as any, "acct_tenant", ORG)).toBe("tml_mine");
    expect(stripe.terminal.locations.create).not.toHaveBeenCalled();
  });

  it("says what to fix when the business has no usable address", async () => {
    const stripe = fakeStripe();
    await expect(
      ensureTerminalLocation(stripe as any, "acct_tenant", { ...ORG, contact_address: null }),
    ).rejects.toThrow(TAP_TO_PAY_ADDRESS_MISSING);
    expect(stripe.terminal.locations.create).not.toHaveBeenCalled();
  });
});

describe("the connection token", () => {
  it("is minted on the connected account, scoped to the location", async () => {
    const stripe = fakeStripe();
    expect(await createConnectionToken(stripe as any, "acct_tenant", "tml_1")).toBe(
      "pst_test_secret",
    );
    expect(stripe.terminal.connectionTokens.create).toHaveBeenCalledWith(
      { location: "tml_1" },
      { stripeAccount: "acct_tenant" },
    );
  });
});

describe("the card_present PaymentIntent", () => {
  it("is a direct charge for the amount due with Take payment's fee", async () => {
    const stripe = fakeStripe();
    const inv = { ...state.invoice, total_cents: 25_000, tax_cents: 2_000 };
    await createCardPresentIntent(stripe as any, "acct_tenant", inv, 25_000, "cus_1");
    const [params, opts] = stripe.paymentIntents.create.mock.calls[0] as any[];
    expect(opts).toEqual({ stripeAccount: "acct_tenant" });
    expect(params.amount).toBe(25_000);
    expect(params.payment_method_types).toEqual(["card_present"]);
    expect(params.capture_method).toBe("automatic");
    expect(params.customer).toBe("cus_1");
    // The same helper, the same inputs, as createInvoicePaymentIntent.
    expect(params.application_fee_amount).toBe(platformFeeCents(25_000, inv));
    expect(Object.hasOwn(params, "application_fee_amount")).toBe(true);
    // What the webhook needs to credit the invoice.
    expect(params.metadata).toMatchObject({
      invoice_id: INVOICE_ID,
      organization_id: ORG.id,
      source: "staff_inline",
      channel: "tap_to_pay",
      tip_cents: "0",
    });
    // Nothing that would save the card.
    expect(params.setup_future_usage).toBeUndefined();
  });

  it("refuses while a bank payment is processing", async () => {
    const stripe = fakeStripe({ existingPi: { id: "pi_old", status: "processing" } });
    await expect(
      createCardPresentIntent(
        stripe as any,
        "acct_tenant",
        { ...state.invoice, stripe_payment_intent_id: "pi_old" },
        100,
        null,
      ),
    ).rejects.toThrow(/already processing/);
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
  });

  it("cancels an intent still open in the customer's portal, so they cannot pay twice", async () => {
    const stripe = fakeStripe({ existingPi: { id: "pi_old", status: "requires_payment_method" } });
    await createCardPresentIntent(
      stripe as any,
      "acct_tenant",
      { ...state.invoice, stripe_payment_intent_id: "pi_old" },
      100,
      null,
    );
    expect(stripe.paymentIntents.cancel).toHaveBeenCalledWith(
      "pi_old",
      {},
      { stripeAccount: "acct_tenant" },
    );
    expect(stripe.paymentIntents.create).toHaveBeenCalled();
  });
});

describe("the server functions", () => {
  it("prepare: creates the location on the connected account and says the keys are test keys", async () => {
    const r = await prepareTapToPay({ data: { invoiceId: INVOICE_ID } });
    expect(r).toEqual({
      locationId: "tml_new",
      stripeAccount: "acct_tenant",
      merchantDisplayName: ORG.name,
      isTest: true,
    });
  });

  it("connection token: for the caller's own business", async () => {
    const { requireOrgStripeAccount } = await import("@/lib/stripe-connect.server");
    expect(await createTapToPayConnectionToken()).toEqual({ secret: "pst_test_secret" });
    expect(requireOrgStripeAccount).toHaveBeenCalledWith(state.orgId);
  });

  it("payment intent: a $1.00 invoice becomes a 100-cent card_present intent the invoice points at", async () => {
    const r = await createTapToPayPaymentIntent({ data: { invoiceId: INVOICE_ID } });
    expect(r).toEqual({ clientSecret: "pi_tap_secret", amountCents: 100, currency: "usd" });
    const [params, opts] = state.stripe.paymentIntents.create.mock.calls[0];
    expect(opts).toEqual({ stripeAccount: "acct_tenant" });
    expect(params.amount).toBe(100);
    expect(params.application_fee_amount).toBe(platformFeeCents(100, state.invoice));
    expect(state.updates).toContainEqual({
      table: "invoices",
      row: { stripe_payment_intent_id: "pi_tap", status: "open" },
    });
  });

  it("payment intent: charges what is still owed, not the gross", async () => {
    state.invoice = {
      ...state.invoice,
      total_cents: 5_000,
      credit_applied_cents: 1_000,
      amount_paid_cents: 1_500,
    };
    const r = await createTapToPayPaymentIntent({ data: { invoiceId: INVOICE_ID } });
    expect(r.amountCents).toBe(2_500);
  });

  it("payment intent: a missed webhook is reconciled, not charged again", async () => {
    state.invoice = { ...state.invoice, stripe_payment_intent_id: "pi_paid" };
    state.reconcile = "marked_paid";
    await expect(createTapToPayPaymentIntent({ data: { invoiceId: INVOICE_ID } })).rejects.toThrow(
      "Invoice already paid",
    );
    expect(state.stripe.paymentIntents.create).not.toHaveBeenCalled();
  });

  for (const status of ["paid", "void", "draft"]) {
    it(`payment intent: refuses a ${status} invoice`, async () => {
      state.invoice = { ...state.invoice, status };
      await expect(
        createTapToPayPaymentIntent({ data: { invoiceId: INVOICE_ID } }),
      ).rejects.toThrow();
      expect(state.stripe.paymentIntents.create).not.toHaveBeenCalled();
    });
  }

  it("every one requires manage_client_billing, the permission Take payment requires", async () => {
    const { requirePermission } = await import("@/lib/authz.server");
    await prepareTapToPay({ data: { invoiceId: INVOICE_ID } });
    await createTapToPayConnectionToken();
    await createTapToPayPaymentIntent({ data: { invoiceId: INVOICE_ID } });
    const perms = (requirePermission as any).mock.calls.map((c: any[]) => c[2]);
    expect(perms).toEqual([
      "manage_client_billing",
      "manage_client_billing",
      "manage_client_billing",
    ]);
    const takePayment = readFileSync("src/lib/invoices.functions.ts", "utf8");
    expect(takePayment).toMatch(
      /createInvoicePaymentIntent[\s\S]{0,400}requirePermission\(supabase, context\.userId, "manage_client_billing"\)/,
    );
  });

  it("a role that cannot take a payment reaches no Stripe call at all", async () => {
    state.allowed = false;
    await expect(prepareTapToPay({ data: { invoiceId: INVOICE_ID } })).rejects.toThrow(
      "Not authorized",
    );
    await expect(createTapToPayConnectionToken()).rejects.toThrow("Not authorized");
    await expect(createTapToPayPaymentIntent({ data: { invoiceId: INVOICE_ID } })).rejects.toThrow(
      "Not authorized",
    );
    expect(state.stripe.terminal.locations.list).not.toHaveBeenCalled();
    expect(state.stripe.terminal.connectionTokens.create).not.toHaveBeenCalled();
    expect(state.stripe.paymentIntents.create).not.toHaveBeenCalled();
  });
});

const IPHONE_17 =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const IPHONE_16_3 =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const IPAD =
  "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const ANDROID_14 =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
const ANDROID_12 =
  "Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";

const ok: TapToPayGateInput = {
  isNativeBundle: true,
  platform: "ios",
  userAgent: IPHONE_17,
  role: "owner",
  cardPaymentsReady: true,
  invoiceStatus: "open",
  dueCents: 100,
};

describe("who sees the button", () => {
  it("an owner or office manager on an eligible iPhone or Android 13+ phone", () => {
    expect(tapToPayGate(ok)).toEqual({ show: true });
    expect(tapToPayGate({ ...ok, role: "office_manager" })).toEqual({ show: true });
    expect(tapToPayGate({ ...ok, platform: "android", userAgent: ANDROID_14 })).toEqual({
      show: true,
    });
  });

  it("never on the web or the PWA, whatever the browser claims to be", () => {
    for (const userAgent of [IPHONE_17, ANDROID_14]) {
      expect(tapToPayGate({ ...ok, isNativeBundle: false, userAgent })).toEqual({
        show: false,
        reason: "web",
      });
    }
    expect(tapToPayGate({ ...ok, platform: "web" })).toEqual({ show: false, reason: "platform" });
  });

  it("never on an ineligible device", () => {
    expect(tapToPayGate({ ...ok, userAgent: IPAD })).toEqual({ show: false, reason: "device" });
    expect(tapToPayGate({ ...ok, userAgent: IPHONE_16_3 })).toEqual({
      show: false,
      reason: "device",
    });
    expect(tapToPayGate({ ...ok, platform: "android", userAgent: ANDROID_12 })).toEqual({
      show: false,
      reason: "device",
    });
    expect(deviceCanTapToPay("android", "")).toBe(false);
    expect(deviceCanTapToPay("ios", "")).toBe(false);
  });

  it("never for a role that cannot already Take payment", () => {
    for (const role of ["tech", "dispatcher", null, undefined] as const) {
      expect(tapToPayGate({ ...ok, role })).toEqual({ show: false, reason: "role" });
    }
  });

  it("not before the business can take cards, and not on an invoice with nothing to collect", () => {
    expect(tapToPayGate({ ...ok, cardPaymentsReady: false })).toEqual({
      show: false,
      reason: "no_stripe",
    });
    for (const invoiceStatus of ["paid", "void", "draft"]) {
      expect(tapToPayGate({ ...ok, invoiceStatus })).toEqual({
        show: false,
        reason: "not_payable",
      });
    }
    expect(tapToPayGate({ ...ok, dueCents: 0 })).toEqual({ show: false, reason: "not_payable" });
  });
});

describe("honest errors", () => {
  it("no network", () => {
    expect(describeTapToPayError(new Error("anything"), { online: false })).toBe(
      TAP_TO_PAY_MESSAGES.offline,
    );
    expect(describeTapToPayError(new Error("The Internet connection appears to be offline."))).toBe(
      TAP_TO_PAY_MESSAGES.offline,
    );
  });

  it("an ineligible device", () => {
    expect(describeTapToPayError(new Error("Tap to Pay is not supported on this device"))).toBe(
      TAP_TO_PAY_MESSAGES.ineligible,
    );
    expect(describeTapToPayError(new Error("Developer options are enabled"))).toBe(
      TAP_TO_PAY_MESSAGES.ineligible,
    );
  });

  it("Apple's terms not accepted, from isTapToPayAccountLinked or from the SDK", () => {
    expect(
      describeTapToPayError(new Error("Connect failed"), { online: true, termsLinked: false }),
    ).toBe(TAP_TO_PAY_MESSAGES.terms);
    expect(
      describeTapToPayError(new Error("Terms of Service acceptance requires an Apple ID")),
    ).toBe(TAP_TO_PAY_MESSAGES.terms);
  });

  it("anything else keeps the SDK's own words rather than a guess", () => {
    expect(describeTapToPayError(new Error("Weird thing 42"))).toBe(
      `${TAP_TO_PAY_MESSAGES.generic} (Weird thing 42)`,
    );
  });
});

describe("the wiring around it", () => {
  it("the pay form draws the button only in the native bundle", () => {
    const form = readFileSync("src/components/StaffInvoicePayForm.tsx", "utf8");
    expect(form).toMatch(/\{IS_NATIVE_BUNDLE && TapToPayButton && \(\s*<Suspense/);
    // Lazily, behind the flag: no static import for the web build to keep.
    expect(form).toMatch(/const TapToPayButton =\s*import\.meta\.env\.VITE_NATIVE_BUNDLE === "1"\s*\?\s*lazy\(/);
    expect(form).not.toMatch(/^import .*TapToPayButton/m);
  });

  it("the plugin is pinned to an exact version", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.dependencies["@capacitor-community/stripe-terminal"]).toBe("8.3.0");
  });

  it("src/lib/native.ts is left alone", () => {
    expect(readFileSync("src/lib/native.ts", "utf8")).not.toMatch(/stripe-terminal|tap.to.pay/i);
  });

  it("iOS carries the Tap to Pay entitlement, Android declares NFC as optional", () => {
    const ent = readFileSync("ios/App/App/App.entitlements", "utf8");
    expect(ent).toMatch(
      /<key>com\.apple\.developer\.proximity-reader\.payment\.acceptance<\/key>\s*<true\/>/,
    );
    const manifest = readFileSync("android/app/src/main/AndroidManifest.xml", "utf8");
    expect(manifest).toMatch(/android\.hardware\.nfc" android:required="false"/);
    expect(readFileSync("android/variables.gradle", "utf8")).toMatch(/minSdkVersion = 26/);
  });

  it("the existing payment_intent.succeeded webhook already credits the source this charge carries", () => {
    // Read-only: #750 owns hooks/stripe.ts. The tap charge is tagged with a
    // source that branch already handles, so no webhook change is needed.
    const hook = readFileSync("src/routes/api/public/hooks/stripe.ts", "utf8");
    const branch = hook.slice(hook.indexOf('event.type === "payment_intent.succeeded") {'));
    expect(branch).toContain(`source === "${TAP_TO_PAY_SOURCE}"`);
    expect(branch).toContain("markInvoicePaidFromStripe");
    // And it filters on source, never on payment_method_types.
    expect(branch.slice(0, 4000)).not.toMatch(/payment_method_types|"card"\s*\)/);
  });
});
