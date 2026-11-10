// Tap to Pay on iPhone: the gaps Apple's review guide (v1.8) found in #757,
// for case 23404969. The rules and the server; the screens are in
// tap-to-pay-apple-review-screens.test.tsx.
//
//   gap 1  live taps on the real phone reader for the production demo org
//          only (by id); Detroit Doo Disposal refused by id through
//          TAP_TO_PAY_NEVER_LIVE_ORG_IDS; every other org refused live; test
//          keys stay on the simulator for everyone
//   1.4    an iPhone before iOS 17.6 is told to update to the latest iOS
//   1.5    warm-up at launch and on every return to the foreground
//   3.8    only the owner accepts Apple's terms; 3.8.1 everyone else is told
//   3.9.1  reader setup progress from ReaderSoftwareUpdateProgress
//   5.4    "Tap to Pay on iPhone", never with the amount
//   5.10   a receipt after an approval and after a decline
//   5.12   a push when a tap was not approved because the app closed
//
// Stripe is never called: every Stripe object here is a fixture.
/* eslint-disable @typescript-eslint/no-explicit-any -- Stripe and Supabase fixtures */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Demo Pet Waste Co, the production demo org, as the migrations name it.
const DEMO_ORG = "342d4d1e-56f7-4b6e-ad40-524d370e1a36";
// Stands for Detroit Doo Disposal's id, which is not in the repo: ops puts
// the real one in TAP_TO_PAY_NEVER_LIVE_ORG_IDS.
const DETROIT_DOO_ORG = "0d0d0d0d-dddd-4ddd-8ddd-000000000d00";
const OTHER_ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INVOICE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const state = vi.hoisted(() => ({
  secret: "sk_live_platform",
  role: "owner" as string,
  orgId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  orgName: "Recording Demo Co",
  invoice: null as any,
  piStatus: "requires_payment_method" as string,
  pushes: [] as any[],
  chargesEnabled: true,
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
vi.mock("@/lib/authz.server", async () => {
  const { hasPermission } = await import("@/lib/permissions");
  const caller = () => ({ orgId: state.orgId, role: state.role, userId: "user-1" });
  return {
    resolveCaller: vi.fn(async () => caller()),
    requirePermission: vi.fn(async (_s: unknown, _u: string, permission: any) => {
      if (!hasPermission(state.role as any, permission)) throw new Error("Not authorized");
      return caller();
    }),
  };
});
vi.mock("@/lib/stripe-connect.server", () => ({
  requireOrgStripeAccount: vi.fn(async () => ({
    accountId: "acct_demo",
    chargesEnabled: state.chargesEnabled,
    collectedByParent: false,
  })),
  connectStripe: vi.fn(async () => stripeFixture()),
  connectSecret: () => state.secret,
  verifyClientStripeCustomer: vi.fn(async () => null),
}));
vi.mock("@/lib/org-country-column", () => ({ isMissingCountryColumn: () => false }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: {
              id: state.orgId,
              name: state.orgName,
              contact_address: "1 Main St, Ann Arbor, MI 48104",
              country: "US",
            },
            error: null,
          }),
        }),
      }),
    }),
  },
}));
vi.mock("@/lib/push.server", () => ({
  sendPushToUser: vi.fn(async (userId: string, payload: unknown) => {
    state.pushes.push({ userId, payload });
    return { sent: 1, failed: 0 };
  }),
}));

function stripeFixture() {
  return {
    terminal: {
      locations: {
        list: async () => ({
          data: [
            {
              id: "tml_demo",
              metadata: { houndstack_tap_to_pay: "1", organization_id: state.orgId },
            },
          ],
        }),
        create: async () => ({ id: "tml_new" }),
      },
      connectionTokens: { create: async () => ({ secret: "pst_secret" }) },
    },
    paymentIntents: {
      retrieve: async (id: string) => ({ id, status: state.piStatus }),
      cancel: async () => ({}),
      create: async () => ({ id: "pi_new", client_secret: "pi_new_secret", currency: "usd" }),
    },
    accounts: {
      retrieve: async () => ({ controller: { fees: { payer: "application_express" } } }),
    },
  };
}

function db() {
  return {
    from: (table: string) => {
      const q: any = {
        select: () => q,
        eq: () => q,
        update: () => ({ eq: async () => ({ error: null }) }),
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => ({
          data: table === "invoices" ? state.invoice : null,
          error: null,
        }),
      };
      return q;
    },
  };
}

import {
  canAcceptTapToPayTerms,
  classifyTapToPayError,
  iosUpdateAdvice,
  readerSetupPercent,
  tapToPayGate,
  tapToPayInterruptedOutcome,
  tapToPayLabel,
  tapToPayNotApprovedPush,
  tapToPayReceiptText,
  TAP_TO_PAY_MESSAGES,
  TAP_TO_PAY_SF_SYMBOL,
} from "@/lib/tap-to-pay";
import {
  parseOrgIds,
  tapToPayReaderMode,
  TAP_TO_PAY_LIVE_DEMO_ORG_ID,
  TAP_TO_PAY_NEVER_LIVE_ORG_IDS_ENV,
  TAP_TO_PAY_NOT_AVAILABLE,
} from "@/lib/tap-to-pay.server";
import {
  createTapToPayConnectionToken,
  getTapToPayStatus,
  prepareTapToPay,
  reportTapToPayInterrupted,
} from "@/lib/tap-to-pay.functions";

const ua = (v: string) =>
  `Mozilla/5.0 (iPhone; CPU iPhone OS ${v} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148`;

beforeEach(() => {
  state.secret = "sk_live_platform";
  state.role = "owner";
  state.orgId = DEMO_ORG;
  state.orgName = "Recording Demo Co";
  state.piStatus = "requires_payment_method";
  state.pushes = [];
  state.chargesEnabled = true;
  state.invoice = {
    id: INVOICE_ID,
    organization_id: DEMO_ORG,
    status: "open",
    stripe_payment_intent_id: "pi_open",
  };
  process.env[TAP_TO_PAY_NEVER_LIVE_ORG_IDS_ENV] = DETROIT_DOO_ORG;
});

describe("gap 1: live taps for the production demo org only; Detroit Doo refused", () => {
  const never = parseOrgIds(`${DETROIT_DOO_ORG}, not-an-id`);
  const mode = (id: string, testKeys = false, neverLiveOrgIds = never) =>
    tapToPayReaderMode({ testKeys, org: { id }, neverLiveOrgIds });

  it("the demo org is the one the migrations name for Demo Pet Waste Co", () => {
    expect(TAP_TO_PAY_LIVE_DEMO_ORG_ID).toBe(DEMO_ORG);
    expect(
      readFileSync(
        "supabase/migrations/20260911200000_the-demo-org-was-still-driving-manhattan.sql",
        "utf8",
      ),
    ).toMatch(/Demo Pet Waste Co[\s\S]*WHERE id = '342d4d1e-56f7-4b6e-ad40-524d370e1a36'/);
  });

  it("the demo org is allowed live taps", () => {
    expect(mode(DEMO_ORG)).toBe("live");
    expect(mode(DEMO_ORG.toUpperCase())).toBe("live");
  });

  it("Detroit Doo is refused live taps, by id", () => {
    expect(mode(DETROIT_DOO_ORG)).toBe("off");
    // The deny list wins over everything, the demo org included.
    expect(mode(DEMO_ORG, false, parseOrgIds(DEMO_ORG))).toBe("off");
  });

  it("any other org is refused live, with or without a deny list", () => {
    expect(mode(OTHER_ORG)).toBe("off");
    expect(mode(OTHER_ORG, false, parseOrgIds(undefined))).toBe("off");
    // With no deny list set, Detroit Doo is still refused: it is not the demo org.
    expect(mode(DETROIT_DOO_ORG, false, parseOrgIds(undefined))).toBe("off");
  });

  it("test mode is unchanged for everyone: Stripe's simulated reader", () => {
    for (const id of [DEMO_ORG, DETROIT_DOO_ORG, OTHER_ORG])
      expect(mode(id, true)).toBe("simulated");
  });

  it("a name has no say: the mode reads the org id only", () => {
    const src = readFileSync("src/lib/tap-to-pay.server.ts", "utf8");
    const fn = src.slice(src.indexOf("export function tapToPayReaderMode"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    // No regex on a business name anywhere, and the mode never reads a name.
    expect(src).not.toMatch(/\/detroit/i);
    expect(body).toMatch(/org: \{ id: string \}/);
    expect(body).not.toMatch(/name/);
    expect(parseOrgIds("Detroit Doo Disposal, , x").size).toBe(0);
  });

  it("prepare, live keys, the demo org: the real reader (isTest false)", async () => {
    const r = await prepareTapToPay({ data: { invoiceId: INVOICE_ID } });
    expect(r).toMatchObject({ readerMode: "live", isTest: false, locationId: "tml_demo" });
  });

  it("prepare, live keys, Detroit Doo or any other org: refused before any Stripe call", async () => {
    for (const org of [DETROIT_DOO_ORG, OTHER_ORG]) {
      state.orgId = org;
      state.invoice = { ...state.invoice, organization_id: org };
      await expect(prepareTapToPay({ data: { invoiceId: INVOICE_ID } })).rejects.toThrow(
        TAP_TO_PAY_NOT_AVAILABLE,
      );
      await expect(createTapToPayConnectionToken()).rejects.toThrow(TAP_TO_PAY_NOT_AVAILABLE);
    }
  });

  it("prepare, test keys, Detroit Doo: the simulated reader, as before", async () => {
    state.secret = "sk_test_platform";
    state.orgId = DETROIT_DOO_ORG;
    state.invoice = { ...state.invoice, organization_id: DETROIT_DOO_ORG };
    const r = await prepareTapToPay({ data: { invoiceId: INVOICE_ID } });
    expect(r).toMatchObject({ readerMode: "simulated", isTest: true });
  });

  it("prepare with no invoice (Enable from Settings, the warm-up) uses the caller's business", async () => {
    state.secret = "sk_test_platform";
    const r = await prepareTapToPay({ data: {} });
    expect(r).toMatchObject({ readerMode: "simulated", isTest: true, locationId: "tml_demo" });
  });

  it("the physical test-card path is not built: no non-simulated reader on test keys anywhere", () => {
    const fns = readFileSync("src/lib/tap-to-pay.functions.ts", "utf8");
    expect(fns).toMatch(/isTest: readerMode === "simulated"/);
    expect(readFileSync("src/lib/tap-to-pay.server.ts", "utf8")).toMatch(
      /if \(input\.testKeys\) return "simulated";/,
    );
  });
});

describe("status for every screen: who may tap, who may accept Apple's terms", () => {
  it("the owner may tap and accept the terms", async () => {
    expect(await getTapToPayStatus()).toEqual({
      available: true,
      readerMode: "live",
      canTap: true,
      canAcceptTerms: true,
    });
  });

  it("an office manager may tap but not accept the terms; a tech may do neither", async () => {
    state.secret = "sk_test_platform";
    state.role = "office_manager";
    expect(await getTapToPayStatus()).toMatchObject({ canTap: true, canAcceptTerms: false });
    state.role = "tech";
    expect(await getTapToPayStatus()).toMatchObject({ canTap: false, canAcceptTerms: false });
    expect(canAcceptTapToPayTerms("owner")).toBe(true);
    expect(canAcceptTapToPayTerms("office_manager")).toBe(false);
  });

  it("not available to a business that is not the demo org", async () => {
    state.orgId = OTHER_ORG;
    expect(await getTapToPayStatus()).toMatchObject({ available: false, readerMode: "off" });
  });
});

describe("Apple 1.4: an iPhone before iOS 17.6 is told to update", () => {
  it("below 16.4 is required, 16.4 to 17.5 recommended, 17.6 and later nothing", () => {
    expect(iosUpdateAdvice("ios", ua("16_3"))).toBe("required");
    expect(iosUpdateAdvice("ios", ua("16_4"))).toBe("recommended");
    expect(iosUpdateAdvice("ios", ua("17_5"))).toBe("recommended");
    expect(iosUpdateAdvice("ios", ua("17_6"))).toBeNull();
    expect(iosUpdateAdvice("ios", ua("18_1"))).toBeNull();
    expect(iosUpdateAdvice("android", "Android 14")).toBeNull();
  });

  it("the old iPhone gets the update prompt on the invoice, not a missing option", () => {
    const g = tapToPayGate({
      isNativeBundle: true,
      platform: "ios",
      userAgent: ua("15_8"),
      role: "owner",
      cardPaymentsReady: true,
      invoiceStatus: "open",
      dueCents: 100,
    });
    expect(g).toEqual({ show: true, mode: "update_ios" });
  });

  it("the words say the latest iOS, not a version number", () => {
    for (const m of [
      TAP_TO_PAY_MESSAGES.updateIosRequired,
      TAP_TO_PAY_MESSAGES.updateIosRecommended,
      TAP_TO_PAY_MESSAGES.ineligible,
    ]) {
      expect(m).toMatch(/latest version of iOS/);
      expect(m).not.toMatch(/16\.4/);
    }
  });
});

describe("Apple 5.4, 5.5: the label and the icon", () => {
  it('is "Tap to Pay on iPhone" on an iPhone, with no amount and no lowercase p', () => {
    expect(tapToPayLabel("ios")).toBe("Tap to Pay on iPhone");
    expect(tapToPayLabel("android")).toBe("Tap to Pay");
    expect(TAP_TO_PAY_SF_SYMBOL).toBe("wave.3.right.circle");
  });

  it("no screen labels a button with the amount, the old lowercase name, or an Apple logo", () => {
    for (const f of [
      "src/components/TapToPayButton.tsx",
      "src/components/tap-to-pay/TapToPaySettingsCard.tsx",
      "src/components/tap-to-pay/TapToPayAnnouncement.tsx",
    ]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/Tap to pay/);
      expect(src, f).not.toMatch(/`Tap to Pay[^`]*\$\{currencyLabel\}/);
      expect(src, f).not.toMatch(/SmartphoneNfc||apple-logo|AppleLogo/);
    }
  });
});

describe("Apple 3.9.1, 5.7: reader setup progress", () => {
  it("turns the plugin's 0 to 1 into a whole, clamped percent", () => {
    expect(readerSetupPercent(0)).toBe(0);
    expect(readerSetupPercent(0.374)).toBe(37);
    expect(readerSetupPercent(1)).toBe(100);
    expect(readerSetupPercent(4)).toBe(100);
    expect(readerSetupPercent(-1)).toBe(0);
    expect(readerSetupPercent("nope")).toBe(0);
  });
});

describe("Apple 5.10: a receipt after an approval and after a decline", () => {
  const at = new Date("2026-11-10T15:04:00Z");
  it("approved", () => {
    const t = tapToPayReceiptText({
      businessName: "Recording Demo Co",
      amountLabel: "$1.00",
      outcome: "approved",
      invoiceLabel: "INV-12",
      at,
    });
    expect(t).toMatch(/^Receipt from Recording Demo Co/);
    expect(t).toMatch(/Payment approved: \$1\.00/);
    expect(t).toMatch(/Invoice: INV-12/);
  });
  it("declined says the card was not charged", () => {
    const t = tapToPayReceiptText({
      businessName: "Recording Demo Co",
      amountLabel: "$1.00",
      outcome: "declined",
      at,
    });
    expect(t).toMatch(/Payment declined: \$1\.00/);
    expect(t).toMatch(/not charged/);
  });
  it("a decline is recognised as one", () => {
    expect(classifyTapToPayError(new Error("Card declined by issuer")).kind).toBe("declined");
  });
});

describe("Apple 5.12: a tap the app was closed in the middle of", () => {
  it("what each intent status means", () => {
    expect(tapToPayInterruptedOutcome("succeeded")).toBe("approved");
    expect(tapToPayInterruptedOutcome("processing")).toBe("pending");
    expect(tapToPayInterruptedOutcome("requires_payment_method")).toBe("not_approved");
    expect(tapToPayInterruptedOutcome("canceled")).toBe("not_approved");
    expect(tapToPayInterruptedOutcome(null)).toBe("unknown");
  });

  it("not approved: the person who started it gets a push that opens the invoice", async () => {
    const r = await reportTapToPayInterrupted({
      data: { invoiceId: INVOICE_ID, amountLabel: "$1.00" },
    });
    expect(r).toEqual({ approved: false, notified: true });
    expect(state.pushes).toHaveLength(1);
    expect(state.pushes[0].userId).toBe("user-1");
    expect(state.pushes[0].payload).toMatchObject({
      ...tapToPayNotApprovedPush("$1.00"),
      url: `/invoices/${INVOICE_ID}`,
    });
  });

  it("approved, or still processing: no push", async () => {
    state.piStatus = "succeeded";
    expect(
      await reportTapToPayInterrupted({ data: { invoiceId: INVOICE_ID, amountLabel: "$1.00" } }),
    ).toEqual({ approved: true, notified: false });
    state.piStatus = "processing";
    await reportTapToPayInterrupted({ data: { invoiceId: INVOICE_ID, amountLabel: "$1.00" } });
    expect(state.pushes).toHaveLength(0);
  });

  it("on the next launch it asks without pushing", async () => {
    const r = await reportTapToPayInterrupted({
      data: { invoiceId: INVOICE_ID, amountLabel: "$1.00", push: false },
    });
    expect(r).toEqual({ approved: false, notified: false });
    expect(state.pushes).toHaveLength(0);
  });

  it("refuses a role that cannot take a payment", async () => {
    state.role = "tech";
    await expect(
      reportTapToPayInterrupted({ data: { invoiceId: INVOICE_ID, amountLabel: "$1.00" } }),
    ).rejects.toThrow("Not authorized");
  });
});

describe("the wiring", () => {
  it("Tap to Pay is first in the payment options, above Saved card and Account credit (5.2)", () => {
    const form = readFileSync("src/components/StaffInvoicePayForm.tsx", "utf8");
    const render = form.slice(form.indexOf("<SectionLabel>Amount due</SectionLabel>"));
    const tap = render.indexOf("<TapToPayButton");
    expect(tap).toBeGreaterThan(0);
    expect(tap).toBeLessThan(render.indexOf("<SectionLabel>Saved card</SectionLabel>"));
    expect(tap).toBeLessThan(render.indexOf("<SectionLabel>Account credit</SectionLabel>"));
    expect(tap).toBeLessThan(render.indexOf("<SectionLabel>New card</SectionLabel>"));
  });

  it("the warm-up starts from the signed-in shell, native only", () => {
    const shell = readFileSync("src/routes/_authenticated/route.tsx", "utf8");
    expect(shell).toMatch(
      /if \(import\.meta\.env\.VITE_NATIVE_BUNDLE === "1"\) \{\s*removeTapToPay = await step\("tap_to_pay_warm_up"/,
    );
    expect(shell).toMatch(
      /const TapToPayAnnouncement =\s*import\.meta\.env\.VITE_NATIVE_BUNDLE === "1"/,
    );
  });

  it("the Settings entry is in Payments, Account tab, native only", () => {
    const page = readFileSync("src/routes/_authenticated/payments.tsx", "utf8");
    expect(page).toMatch(
      /const TapToPaySettingsCard =\s*import\.meta\.env\.VITE_NATIVE_BUNDLE === "1"/,
    );
    expect(page).toMatch(/<TapToPaySettingsCard \/>/);
  });

  it("Apple's ProximityReaderDiscovery is a local iOS plugin, registered and in the target", () => {
    const swift = readFileSync("ios/App/App/TapToPay/TapToPayEducationPlugin.swift", "utf8");
    expect(swift).toMatch(/ProximityReaderDiscovery\(\)/);
    expect(swift).toMatch(/\.payment\(\.howToTap\)/);
    expect(swift).toMatch(/#available\(iOS 18\.0, \*\)/);
    expect(swift).toMatch(/jsName = "TapToPayEducation"/);
    expect(readFileSync("ios/App/App/HSBridgeViewController.swift", "utf8")).toMatch(
      /registerPluginInstance\(TapToPayEducationPlugin\(\)\)/,
    );
    const pbx = readFileSync("ios/App/App.xcodeproj/project.pbxproj", "utf8");
    expect(pbx).toMatch(/TapToPayEducationPlugin\.swift in Sources \*\/ = \{isa = PBXBuildFile/);
    const sources = pbx.slice(pbx.indexOf("/* Begin PBXSourcesBuildPhase section */"));
    expect(sources.slice(0, sources.indexOf("};"))).toMatch(
      /TapToPayEducationPlugin\.swift in Sources/,
    );
  });

  it("setup.tsx is not touched by Tap to Pay (the end-of-onboarding offer, 3.4, waits)", () => {
    for (const f of ["src/routes/_authenticated/setup.tsx", "src/routes/setup.tsx"]) {
      let src = "";
      try {
        src = readFileSync(f, "utf8");
      } catch {
        continue;
      }
      expect(src, f).not.toMatch(/tap.to.pay/i);
    }
  });
});
