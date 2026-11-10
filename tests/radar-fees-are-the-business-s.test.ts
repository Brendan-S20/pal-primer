/**
 * Radar fees are the business's, not the platform's (#825).
 *
 * Brendan, 2026-11-10, 1:45 AM ET: "Pass Radar fees to each business, like the
 * tap fee". The live check on #825 found Radar debits of -$0.30, -$0.15 and
 * -$0.10 on the PLATFORM balance while both live connected accounts are
 * Express (`controller.fees.payer: "application_express"`), and while
 * `platformFeeCents()` is zero, so no application fee was set at all and there
 * was nothing to recover the fee from. Every case below is about that.
 *
 * Fixtures only. Nothing here talks to Stripe.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  RADAR_SCREENING_FEE_CENTS,
  methodTypesForRail,
  platformBilledForRadar,
  radarFeeCents,
  radarFeeFromMetadata,
  radarFeeLabel,
  radarFeeMetadata,
  radarFeeSentence,
  radarScreens,
  withPassThroughFees,
} from "@/lib/radar-fee";
import { connectedAccountFeePayer, radarPassThrough } from "@/lib/connect-fee-payer.server";
import {
  passedThroughFeeCents,
  readChargeMetadata,
  reversibleApplicationFeeCents,
  reversibleFeeBaseCents,
} from "@/lib/tap-to-pay";
import { createCardPresentIntent, TAP_TO_PAY_FEE_CENTS } from "@/lib/tap-to-pay.server";
import { feeReversalCents, platformFeeCents } from "@/lib/platform-fee";

/** Every fee payer Stripe documents, plus the two ways a read can come back empty. */
const PAYERS = ["account", "application", "application_express", "application_custom"] as const;

function fakeAccounts(payer: string | null | "fails" | "fails-once") {
  let calls = 0;
  return {
    accounts: {
      retrieve: vi.fn(async () => {
        calls++;
        if (payer === "fails" || (payer === "fails-once" && calls === 1)) {
          throw new Error("Stripe unavailable");
        }
        const p = payer === "fails-once" ? "application_express" : payer;
        return { id: "acct_tenant", controller: { fees: { payer: p } } };
      }),
    },
  };
}

describe("the fee", () => {
  it("is a named constant of five cents", () => {
    expect(RADAR_SCREENING_FEE_CENTS).toBe(5);
    expect(radarFeeLabel()).toBe("$0.05");
  });

  it("is told to the business in plain words, in the tap fee's style", () => {
    const s = radarFeeSentence("application_express");
    expect(s).toContain("$0.05");
    expect(s).toContain("taken out of the payout and shown in Stripe");
    expect(s).not.toMatch(/—|–/); // no em or en dashes
    expect(s).not.toMatch(/seamless|robust|elevate|unlock|delve/i);
  });
});

describe("who Stripe bills for Radar on a direct charge", () => {
  // Stripe's table (direct-charges-fee-payer-behavior): account -> connected
  // account, application -> platform, express/custom -> "Varies", and the
  // live check put HoundStack's express accounts on the platform.
  it("is the business only under `account`", () => {
    expect(platformBilledForRadar("account")).toBe(false);
    expect(platformBilledForRadar("application")).toBe(true);
    expect(platformBilledForRadar("application_express")).toBe(true);
    expect(platformBilledForRadar("application_custom")).toBe(true);
  });

  it("counts an unreadable or unknown payer as the platform", () => {
    expect(platformBilledForRadar(null)).toBe(true);
    expect(platformBilledForRadar("something_new")).toBe(true);
  });

  it("differs from the tap fee under application_express, which is the case that hit the platform", () => {
    // The tap fee is NOT added under application_express (Stripe bills that
    // to the business); Radar IS. Pinned side by side so nobody "unifies" them.
    expect(radarFeeCents("application_express", ["card"])).toBe(5);
  });
});

describe("what Radar screens", () => {
  it("screens online cards and Link", () => {
    expect(radarScreens(["card"])).toBe(true);
    expect(radarScreens(["link"])).toBe(true);
    expect(radarScreens(["card", "us_bank_account"])).toBe(true);
  });

  it("does not screen a bank debit or an in-person tap", () => {
    expect(radarScreens(["us_bank_account"])).toBe(false);
    expect(radarScreens(["card_present"])).toBe(false);
  });

  it("treats unpinned methods as possibly a card", () => {
    expect(radarScreens(undefined)).toBe(true);
    expect(radarScreens(null)).toBe(true);
    expect(radarScreens([])).toBe(true);
  });

  it("maps a saved method's rail to what it is", () => {
    expect(methodTypesForRail("card")).toEqual(["card"]);
    expect(methodTypesForRail("ach")).toEqual(["us_bank_account"]);
    expect(radarFeeCents("application_express", methodTypesForRail("ach"))).toBe(0);
  });
});

describe("radarFeeCents for every fee payer and method", () => {
  const cases: Array<[string | null, readonly string[] | undefined, number]> = [
    ["account", ["card"], 0],
    ["account", undefined, 0],
    ["application", ["card"], 5],
    ["application_express", ["card"], 5],
    ["application_express", ["card", "us_bank_account"], 5],
    ["application_express", ["us_bank_account"], 0],
    ["application_express", ["card_present"], 0],
    ["application_custom", ["card"], 5],
    [null, ["card"], 5],
    [null, ["card_present"], 0],
  ];
  for (const [payer, methods, cents] of cases) {
    it(`${payer ?? "unreadable"} + ${methods?.join("/") ?? "automatic"} -> ${cents}`, () => {
      expect(radarFeeCents(payer, methods)).toBe(cents);
    });
  }
});

describe("adding it to the application fee", () => {
  it("sets a fee where there was none: the platform fee is zero today", () => {
    // platformFeeCents is undefined for every amount, so application_fee_amount
    // is omitted. That is exactly when the platform paid on #825.
    const platform = platformFeeCents(6000);
    expect(platform).toBeUndefined();
    expect(withPassThroughFees(platform, 5)).toBe(5);
  });

  it("adds to a real platform fee rather than replacing it", () => {
    expect(withPassThroughFees(50, 5)).toBe(55);
    expect(withPassThroughFees(50, TAP_TO_PAY_FEE_CENTS + 5)).toBe(65);
  });

  it("leaves the platform fee alone, undefined included, when nothing is passed through", () => {
    expect(withPassThroughFees(undefined, 0)).toBeUndefined();
    expect(withPassThroughFees(50, 0)).toBe(50);
    expect(withPassThroughFees(50, Number.NaN)).toBe(50);
    expect(withPassThroughFees(50, -5)).toBe(50);
  });

  it("never charges the client more: only the application fee moves", () => {
    // The charge amount is computed elsewhere and untouched; this helper only
    // ever returns an application fee. A $60.00 charge stays $60.00, and the
    // business is paid $60.00 minus Stripe's fee minus $0.05.
    expect(
      withPassThroughFees(platformFeeCents(6000), radarFeeCents("application_express", ["card"])),
    ).toBe(5);
  });

  it("records what it did in metadata, always, zero included", () => {
    expect(radarFeeMetadata(5, "application_express")).toEqual({
      radar_fee_cents: "5",
      connect_fee_payer: "application_express",
    });
    expect(radarFeeMetadata(0, "account")).toEqual({
      radar_fee_cents: "0",
      connect_fee_payer: "account",
    });
    expect(radarFeeMetadata(5, null).connect_fee_payer).toBe("unknown");
  });
});

describe("reading the account", () => {
  for (const payer of PAYERS) {
    it(`under ${payer}`, async () => {
      const stripe = fakeAccounts(payer);
      const r = await radarPassThrough(stripe, "acct_tenant", ["card"]);
      expect(stripe.accounts.retrieve).toHaveBeenCalledWith("acct_tenant");
      expect(r.cents).toBe(payer === "account" ? 0 : 5);
      expect(r.metadata).toEqual({
        radar_fee_cents: payer === "account" ? "0" : "5",
        connect_fee_payer: payer,
      });
    });
  }

  it("retries once, then charges as if the platform pays", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const down = fakeAccounts("fails");
    const r = await radarPassThrough(down, "acct_tenant", ["card"]);
    expect(down.accounts.retrieve).toHaveBeenCalledTimes(2);
    expect(r).toEqual({
      cents: 5,
      metadata: { radar_fee_cents: "5", connect_fee_payer: "unknown" },
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("recovers from one blip", async () => {
    const blip = fakeAccounts("fails-once");
    expect(await connectedAccountFeePayer(blip, "acct_tenant")).toBe("application_express");
    expect(blip.accounts.retrieve).toHaveBeenCalledTimes(2);
  });

  it("treats an account with no controller as unreadable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await radarPassThrough(fakeAccounts(null), "acct_tenant", ["card"]);
    expect(r.cents).toBe(5);
    expect(r.metadata.connect_fee_payer).toBe("unknown");
    warn.mockRestore();
  });

  it("adds nothing to a bank debit, whatever the payer", async () => {
    for (const payer of PAYERS) {
      const r = await radarPassThrough(fakeAccounts(payer), "acct_tenant", ["us_bank_account"]);
      expect(r.cents).toBe(0);
    }
  });
});

describe("refunds and disputes keep it", () => {
  it("hands none of it back on a full refund at today's zero platform fee", () => {
    const md = { radar_fee_cents: "5" };
    expect(reversibleApplicationFeeCents(5, md)).toBe(0);
    expect(feeReversalCents(reversibleApplicationFeeCents(5, md), 6000, 6000)).toBe(0);
  });

  it("hands back only the platform-fee part, pro rata, when there is one", () => {
    const md = { radar_fee_cents: "5" };
    const base = reversibleApplicationFeeCents(55, md);
    expect(base).toBe(50);
    expect(feeReversalCents(base, 10_000, 10_000)).toBe(50); // full refund
    expect(feeReversalCents(base, 10_000, 5_000)).toBe(25); // half
  });

  it("keeps a tap's fee and a Radar fee together", () => {
    const md = { tap_to_pay_fee_cents: "10", radar_fee_cents: "5" };
    expect(passedThroughFeeCents(md)).toBe(15);
    expect(reversibleApplicationFeeCents(65, md)).toBe(50);
  });

  it("is the same on a lost dispute: the dispute branch uses the same base", () => {
    const md = { radar_fee_cents: "5" };
    const read = { readable: true as const, metadata: md };
    const base = reversibleFeeBaseCents(55, read);
    expect(base).toBe(50);
    expect(feeReversalCents(base!, 10_000, 2_500)).toBe(13);
  });

  it("reverses nothing when the metadata cannot be read", async () => {
    const read = await readChargeMetadata(null, "pi_1", async () => {
      throw new Error("Stripe unavailable");
    });
    expect(read.readable).toBe(false);
    expect(reversibleFeeBaseCents(5, read)).toBeNull();
  });

  it("treats a charge from before #825 as carrying no Radar fee", () => {
    expect(radarFeeFromMetadata({ source: "portal_inline" })).toBe(0);
    expect(radarFeeFromMetadata({ radar_fee_cents: "abc" })).toBe(0);
    expect(radarFeeFromMetadata(null)).toBe(0);
    expect(reversibleApplicationFeeCents(50, { source: "portal_inline" })).toBe(50);
  });
});

describe("the tap path does not miss it", () => {
  // Radar does not screen an in-person tap, so the tap's Radar fee is zero by
  // construction; the point is that it is COMPUTED and recorded, not skipped.
  const invoice = {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    organization_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    total_cents: 6000,
    tax_cents: 0,
    currency: "usd",
    stripe_payment_intent_id: null,
  };
  const tapStripe = (payer: string | null | "fails") => ({
    ...fakeAccounts(payer),
    terminal: {} as never,
    paymentIntents: {
      retrieve: vi.fn(),
      cancel: vi.fn(),
      create: vi.fn(async (params: unknown) => ({ id: "pi_tap", params })),
    },
  });

  for (const payer of [...PAYERS, "fails"] as const) {
    it(`records radar_fee_cents "0" under ${payer}, and the tap fee as before`, async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const stripe = tapStripe(payer);
      await createCardPresentIntent(stripe as never, "acct_tenant", invoice, 6000, null);
      const [params] = stripe.paymentIntents.create.mock.calls[0] as [
        Record<string, unknown> & { metadata: Record<string, string> },
      ];
      expect(params.payment_method_types).toEqual(["card_present"]);
      expect(params.metadata.radar_fee_cents).toBe("0");
      const platformPaysTap = payer === "application" || payer === "fails";
      expect(params.application_fee_amount).toBe(
        platformPaysTap ? TAP_TO_PAY_FEE_CENTS : undefined,
      );
      expect(params.amount).toBe(6000);
      warn.mockRestore();
    });
  }
});

describe("every charge path carries it", () => {
  // The platform-fee coverage test (the-platform-fee-has-one-definition)
  // checks every connected-account create wraps its fee in
  // withPassThroughFees. These pin the other half: the amount comes from the
  // account read, and the metadata a refund needs is written.
  const code = (p: string) =>
    readFileSync(p, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  const SITES: Array<[string, number]> = [
    // Take payment (inline card/bank) and the staff saved-card charge, and the
    // public pay link.
    ["src/lib/invoices.functions.ts", 3],
    // Portal pay page and portal saved card.
    ["src/lib/portal.functions.ts", 2],
    // The nightly autopay run, which nobody watches.
    ["src/routes/api/public/hooks/nightly.ts", 1],
    // Online signup prepay.
    ["src/lib/signup.functions.ts", 1],
  ];
  for (const [file, n] of SITES) {
    it(`${file} reads the account and writes the metadata at each of its ${n} charge path(s)`, () => {
      const src = code(file);
      expect(src.match(/radarPassThrough\(/g)?.length ?? 0).toBe(n);
      expect(src.match(/\.\.\.radar\.metadata/g)?.length ?? 0).toBe(n);
      expect(src).not.toMatch(/application_fee_amount:\s*platformFeeCents\(/);
    });
  }

  it("the saved-method paths judge by the method's rail, so a bank debit is not charged", () => {
    for (const file of [
      "src/lib/invoices.functions.ts",
      "src/lib/portal.functions.ts",
      "src/routes/api/public/hooks/nightly.ts",
    ]) {
      expect(code(file)).toMatch(
        /radarPassThrough\([\s\S]{0,80}methodTypesForRail\(quote\.rail\),?\s*\)/,
      );
    }
  });

  it("the tap path computes it and writes it", () => {
    const src = code("src/lib/tap-to-pay.server.ts");
    expect(src).toMatch(/radarFeeCents\(feePayer, tapMethodTypes\)/);
    expect(src).toMatch(/\.\.\.radarFeeMetadata\(radarCents, feePayer\)/);
  });

  it("reconcile keeps it when it shrinks a stale intent", () => {
    // The amount sync rewrites application_fee_amount. Recomputing it from
    // platformFeeCents alone would drop the Radar (and tap) fee set at create.
    expect(code("src/lib/invoice-reconcile.server.ts")).toMatch(
      /application_fee_amount:\s*withPassThroughFees\(\s*platformFeeCents\(dueCents, inv\),\s*passedThroughFeeCents\(pi\.metadata\),?\s*\)/,
    );
  });

  it("the automatic signup refund does not hand the Radar fee back", () => {
    // provisionSignup used to send refund_application_fee: true, which returns
    // the whole application fee, Radar part included.
    const src = code("src/routes/api/public/hooks/stripe.ts");
    expect(src).toMatch(/refund_application_fee:\s*!keepFee/);
    expect(src).not.toMatch(/refund_application_fee:\s*true/);
    expect(src).toMatch(/passedThroughFeeCents\(read\.metadata\) > 0/);
  });
});
