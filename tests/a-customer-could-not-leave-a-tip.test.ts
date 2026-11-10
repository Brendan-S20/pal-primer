import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  TIP_CUSTOM_MAX_CENTS,
  TipRefused,
  customTipCapCents,
  parseTipDollars,
  percentTipCents,
  tipCentsFor,
  tipChoiceSchema,
  tipFromMetadata,
  tipMetadata,
  tippedCharge,
} from "@/lib/tips";
import { invoiceAppliedCents, tipAppliedCents } from "@/lib/processing-fee.server";
import { splitRefund } from "@/lib/refund-split";
import { grossReceivedCents, tipsReceivedCents } from "@/lib/revenue";
import { tipsByMonth } from "@/lib/cpa-reports";
import { buildTimesheet, timesheetCsvRows, TIMESHEET_CSV_HEADERS } from "@/lib/time-clock";
import { platformFeeCents } from "@/lib/platform-fee";
import { canOfferRefund } from "@/lib/refunds";
import { surchargeSplit, describePaymentSplit } from "@/lib/format";

// Customers could not leave a tip. Jobber and Housecall Pro both offer one on
// the pay screen and pet-waste operators ask for it; HoundStack had nothing.
//
// The whole design is one rule, the one surcharge_cents was added under: the
// tip sits BESIDE `payments.amount_cents`, never inside it. `amount_cents` is
// money applied to the invoice on every row ever written, and revenue, AR,
// franchise royalties and the platform fee all read it. So the tests below are
// mostly about keeping a tip out of places, and about the server deciding the
// tip itself from a choice it can check, rather than trusting a total.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
/** Source with comments removed, so an explanatory comment cannot satisfy or
 *  trip a check meant for code. */
const code = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

/** The body of one exported server function, up to the next export. */
function serverFn(file: string, name: string): string {
  const src = code(read(file));
  const start = src.indexOf(`export const ${name}`);
  expect(start, `${name} in ${file}`).toBeGreaterThan(-1);
  const next = src.indexOf("\nexport ", start + 10);
  return src.slice(start, next === -1 ? undefined : next);
}

// ── the arithmetic ─────────────────────────────────────────────────────────

describe("tip math", () => {
  it("takes a percent of the amount due, to the nearest cent", () => {
    expect(percentTipCents(6_000, 15)).toBe(900);
    expect(percentTipCents(10_400, 10)).toBe(1_040);
    expect(percentTipCents(10_400, 15)).toBe(1_560);
    expect(percentTipCents(10_400, 20)).toBe(2_080);
    // Half a cent rounds up: 15% of $45.75 is $6.8625, drawn and charged as $6.86.
    expect(percentTipCents(4_575, 15)).toBe(686);
    expect(percentTipCents(3_333, 15)).toBe(500);
  });

  it("offers exactly No tip, 10, 15 and 20 percent, and a custom amount", () => {
    expect(tipCentsFor({ kind: "none" }, 6_000)).toBe(0);
    expect(tipCentsFor(undefined, 6_000)).toBe(0);
    expect(tipCentsFor({ kind: "percent", percent: 10 }, 6_000)).toBe(600);
    expect(tipCentsFor({ kind: "percent", percent: 15 }, 6_000)).toBe(900);
    expect(tipCentsFor({ kind: "percent", percent: 20 }, 6_000)).toBe(1_200);
    expect(tipCentsFor({ kind: "custom", cents: 750 }, 6_000)).toBe(750);
  });

  it("caps a custom tip at the invoice amount, or $50 on a small invoice, never above $1,000", () => {
    expect(customTipCapCents(12_000)).toBe(12_000);
    expect(customTipCapCents(1_200)).toBe(5_000);
    expect(customTipCapCents(0)).toBe(5_000);
    expect(customTipCapCents(500_000)).toBe(TIP_CUSTOM_MAX_CENTS);
    expect(tipCentsFor({ kind: "custom", cents: 12_000 }, 12_000)).toBe(12_000);
    expect(() => tipCentsFor({ kind: "custom", cents: 12_001 }, 12_000)).toThrow(TipRefused);
  });

  it("reads dollars typed into the custom box, and refuses what is not an amount", () => {
    expect(parseTipDollars("5")).toBe(500);
    expect(parseTipDollars("5.5")).toBe(550);
    expect(parseTipDollars("$1,005.50")).toBe(100_550);
    for (const bad of ["", "abc", "5.555", "-5", "1e3", "5,5.00x"]) {
      expect(parseTipDollars(bad)).toBeNull();
    }
  });

  it("round-trips through Stripe metadata as a plain integer string", () => {
    expect(tipMetadata(1_560)).toEqual({ tip_cents: "1560" });
    expect(tipFromMetadata(tipMetadata(1_560))).toBe(1_560);
    // Always written, zero included: Stripe merges metadata on update.
    expect(tipMetadata(0)).toEqual({ tip_cents: "0" });
    for (const bad of ["", "abc", "-50", "NaN", "1e9999", "15.5"]) {
      expect(tipFromMetadata({ tip_cents: bad })).toBe(0);
    }
    expect(tipFromMetadata(null)).toBe(0);
  });
});

// ── the server decides the tip ─────────────────────────────────────────────

describe("the server refuses a forged tip", () => {
  it("parses only the choices the pay screen offers", () => {
    const bad = [
      { kind: "percent", percent: 25 },
      { kind: "percent", percent: 15.5 },
      { kind: "percent", percent: "15" },
      { kind: "custom", cents: -500 },
      { kind: "custom", cents: 0 },
      { kind: "custom", cents: 12.5 },
      { kind: "custom", cents: TIP_CUSTOM_MAX_CENTS + 1 },
      { kind: "custom", cents: "500" },
      { kind: "total", cents: 1 },
      { cents: 500 },
    ];
    for (const b of bad) {
      expect(tipChoiceSchema.safeParse(b).success, JSON.stringify(b)).toBe(false);
    }
  });

  it("ignores a total, or cents on a percent, that the browser adds", () => {
    // A forged request that names its own figures. zod strips unknown keys,
    // and the charge is computed from the percent against the server's own
    // amount due, so the $1 "total" and the 1¢ "tip" go nowhere.
    const parsed = tipChoiceSchema.parse({
      kind: "percent",
      percent: 20,
      cents: 1,
      amountCents: 100,
      totalCents: 100,
    });
    expect(parsed).toEqual({ kind: "percent", percent: 20 });
    const charge = tippedCharge({ dueCents: 10_000, choice: parsed, tipsEnabled: true });
    expect(charge.tipCents).toBe(2_000);
    expect(charge.amountCents).toBe(12_000);
  });

  it("refuses a tip when the business has tipping off, rather than dropping it", () => {
    expect(() =>
      tippedCharge({
        dueCents: 10_000,
        choice: { kind: "percent", percent: 15 },
        tipsEnabled: false,
      }),
    ).toThrow(TipRefused);
    // No tip asked for is fine either way.
    expect(
      tippedCharge({ dueCents: 10_000, choice: { kind: "none" }, tipsEnabled: false }),
    ).toEqual({
      dueCents: 10_000,
      tipCents: 0,
      amountCents: 10_000,
      platformFeeBaseCents: 10_000,
      metadata: { tip_cents: "0" },
    });
  });

  it("refuses a custom tip over the cap even when it parsed", () => {
    // $900 on a $60 invoice passes the absolute ceiling and fails the
    // relative one, which only the server knows because only it read the invoice.
    const choice = tipChoiceSchema.parse({ kind: "custom", cents: 90_000 });
    expect(() => tippedCharge({ dueCents: 6_000, choice, tipsEnabled: true })).toThrow(
      /at most \$60\.00/,
    );
  });

  it("re-validates a choice that skipped the schema", () => {
    // tippedCharge is what the charge is built from; it must not depend on
    // its caller having parsed anything.
    expect(() => tipCentsFor({ kind: "percent", percent: 50 as never }, 10_000)).toThrow(
      TipRefused,
    );
    expect(() => tipCentsFor({ kind: "custom", cents: 1.5 }, 10_000)).toThrow(TipRefused);
    expect(() => tipCentsFor({ kind: "custom", cents: Number.NaN }, 10_000)).toThrow(TipRefused);
  });

  const PAY_SCREENS = [
    ["src/lib/invoices.functions.ts", "createPublicInvoicePaymentIntent"],
    ["src/lib/portal.functions.ts", "portalCreateInvoicePaymentIntent"],
  ] as const;

  it.each(PAY_SCREENS)("%s %s takes a tip CHOICE and prices it itself", (file, name) => {
    const fn = serverFn(file, name);
    expect(fn).toContain("tip: tipChoiceSchema.optional()");
    // `invoice` rides along since sales tax (20260929110000): the platform fee
    // is taken on the invoice's pre-tax share, so tippedCharge needs its tax.
    expect(fn).toMatch(/tippedCharge\(\{\s*dueCents, choice: data\.tip, tipsEnabled(?:, invoice)? \}\)/);
    // tipsEnabled comes from the organization row, never from the request.
    expect(fn).toMatch(/tips_enabled/);
    expect(fn).not.toMatch(/data\.tipsEnabled|data\.amount|data\.total/);
  });

  it.each(PAY_SCREENS)(
    "%s %s charges the priced total, and the fee on the invoice",
    (file, name) => {
      const fn = serverFn(file, name);
      const amounts = [...fn.matchAll(/\bamount: ([\w.]+),/g)].map((m) => m[1]);
      expect(amounts.length).toBe(2); // the update and the create
      for (const a of amounts) expect(a).toBe("charge.amountCents");
      // Wrapped in withPassThroughFees since #825 (Stripe's Radar fee on top).
      const fees = [
        ...fn.matchAll(
          /application_fee_amount:\s*(?:withPassThroughFees\(\s*)?platformFeeCents\(([\w.]+)\)/g,
        ),
      ].map((m) => m[1]);
      expect(fees.length).toBe(2);
      for (const f of fees) expect(f).toBe("charge.platformFeeBaseCents");
      // And the tip travels to the webhook with the charge.
      expect(fn).toContain("...charge.metadata");
    },
  );

  it("the tip picker only ever sends a choice", () => {
    for (const f of [
      "src/routes/pay.i.$token.tsx",
      "src/routes/portal.$slug.$token.pay.$invoiceId.tsx",
    ]) {
      const src = code(read(f));
      expect(src, f).toMatch(/tip: choice/);
      expect(src, f).not.toMatch(/tipCents:\s*\w+\s*[,}]\s*\}\s*\}\)/);
    }
  });
});

// ── the surcharge ──────────────────────────────────────────────────────────

describe("the tip is never surcharged", () => {
  // Decision: a surcharge is quoted on the INVOICE (`baseCents: dueCents`) at
  // every site that quotes one, and the two tipping screens do not surcharge
  // at all (processing-fee.server.ts: FOUR paths do NOT surcharge). So the
  // tipped charge is exactly due + tip, and a tip can never grow a card fee.

  it("prices a tipped charge as the invoice plus the tip, nothing else", () => {
    const c = tippedCharge({
      dueCents: 10_400,
      choice: { kind: "percent", percent: 15 },
      tipsEnabled: true,
    });
    expect(c.amountCents).toBe(10_400 + 1_560);
    expect(c.amountCents - c.dueCents - c.tipCents).toBe(0);
  });

  it("every surcharge quote is taken on the invoice, not on a tipped total", () => {
    for (const f of [
      "src/lib/portal.functions.ts",
      "src/lib/invoices.functions.ts",
      "src/routes/api/public/hooks/nightly.ts",
    ]) {
      const src = code(read(f));
      const bases = [...src.matchAll(/baseCents: ([\w.]+),/g)].map((m) => m[1]);
      expect(bases.length, f).toBeGreaterThan(0);
      for (const b of bases) expect(b, f).toBe("dueCents");
    }
  });

  it("takes the platform fee on the invoice, not on the tip", () => {
    const c = tippedCharge({
      dueCents: 10_000,
      choice: { kind: "custom", cents: 5_000 },
      tipsEnabled: true,
    });
    // The base, not the fee: PLATFORM_FEE_BPS is 0 today, so comparing fees
    // would pass whatever the base was. The base is what a future rate reads.
    expect(c.platformFeeBaseCents).toBe(10_000);
    expect(c.amountCents).toBe(15_000);
    expect(platformFeeCents(c.platformFeeBaseCents)).toBe(platformFeeCents(10_000));
  });
});

// ── what reaches the ledger ────────────────────────────────────────────────

describe("the charge splits back into invoice, surcharge and tip", () => {
  it("credits the invoice only its own amount", () => {
    expect(invoiceAppliedCents(14_000, { tip_cents: "1500" })).toBe(12_500);
    expect(tipAppliedCents(14_000, { tip_cents: "1500" })).toBe(1_500);
    expect(invoiceAppliedCents(14_375, { tip_cents: "1500", surcharge_cents: "375" })).toBe(12_500);
  });

  it("never credits a negative payment from metadata larger than the charge", () => {
    expect(invoiceAppliedCents(1_000, { tip_cents: "5000" })).toBe(0);
    expect(tipAppliedCents(1_000, { tip_cents: "5000" })).toBe(1_000);
    expect(invoiceAppliedCents(1_000, { tip_cents: "800", surcharge_cents: "500" })).toBe(0);
    expect(tipAppliedCents(1_000, { tip_cents: "800", surcharge_cents: "500" })).toBe(500);
  });

  it("clears a stale tip wherever an intent is re-priced without one", () => {
    // Stripe MERGES metadata on update. An intent a customer tipped on and
    // abandoned, then re-priced to the bare invoice by staff or by a credit
    // application, would otherwise keep tip_cents and the webhook would
    // under-credit the invoice by a tip that was never charged.
    const staff = serverFn("src/lib/invoices.functions.ts", "createInvoicePaymentIntent");
    expect(staff).toContain("...tipMetadata(0)");
    const recon = code(read("src/lib/invoice-reconcile.server.ts"));
    expect(recon).toMatch(/metadata: tipMetadata\(0\)/);
  });

  it("every path that marks an invoice paid passes the tip beside the amount", () => {
    for (const f of [
      "src/routes/api/public/hooks/stripe.ts",
      "src/lib/invoice-reconcile.server.ts",
    ]) {
      expect(code(read(f)), f).toMatch(/tipCents: tipAppliedCents\(/);
    }
    expect(code(read("src/lib/invoice-reconcile.server.ts"))).toContain("tip_cents: tipCents");
  });
});

describe("revenue excludes tips", () => {
  const rows = [
    { amount_cents: 12_500, tip_cents: 1_500, surcharge_cents: 0, status: "succeeded" },
    { amount_cents: 6_000, tip_cents: 900, surcharge_cents: 180, status: "refunded" },
    { amount_cents: 4_000, tip_cents: 600, status: "failed" },
  ];

  it("sums the invoice amount only", () => {
    expect(grossReceivedCents(rows)).toBe(18_500);
  });

  it("counts tips on their own, on the same received rule", () => {
    expect(tipsReceivedCents(rows)).toBe(2_400);
  });

  it("no SQL revenue, royalty or settlement path reads tip_cents", () => {
    // Every figure computed in the database — franchise settlements, the
    // rollup, the dashboards' RPCs — sums payments.amount_cents. The only
    // migration that may mention tip_cents is the one that adds it.
    const dir = join(ROOT, "supabase/migrations");
    const mentioning = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => readFileSync(join(dir, f), "utf8").includes("tip_cents"));
    expect(mentioning).toEqual(["20260929030000_a-customer-could-not-leave-a-tip.sql"]);
  });

  it("the cash income sheet sums amount_cents and says where the tips went", () => {
    const src = code(read("src/lib/cpa-reports.functions.ts"));
    const cash = src.slice(
      src.indexOf("async function buildIncomeCash"),
      src.indexOf("async function buildTipsReceived"),
    );
    // incomeOf(p) since sales tax: amount_cents less its tax share, and still
    // never the tip.
    expect(cash).toContain("b.gross += incomeOf(p);");
    expect(src).toMatch(/\(p\.amount_cents \?\? 0\) - Math\.max\(0, p\.tax_cents \?\? 0\)/);
    expect(cash).not.toMatch(/tip_cents/);
    expect(cash).toMatch(/Tips received report/);
  });

  it("the 1099-K sheet includes the tip, because Stripe reports the charge", () => {
    const src = code(read("src/lib/cpa-reports.functions.ts"));
    const k = src.slice(src.indexOf("async function build1099k"));
    // Both halves: this org's own receipts, and what it collected for its
    // locations. Either one without the tip leaves the sheet short of the form.
    const charged = k.match(
      /\(p\.amount_cents \?\? 0\) \+ \(p\.surcharge_cents \?\? 0\) \+ \(p\.tip_cents \?\? 0\)/g,
    );
    expect(charged?.length).toBe(2);
    expect(k).not.toMatch(/\(p\.amount_cents \?\? 0\) \+ \(p\.surcharge_cents \?\? 0\);/);
  });

  it("the Tips received report nets refunded tips, month by month", () => {
    const rows = tipsByMonth(
      ["2026-08", "2026-09"],
      [
        { day: "2026-08-03", tipCents: 1_500 },
        { day: "2026-08-20", tipCents: 0 },
        { day: "2026-09-02", tipCents: 900 },
      ],
      [{ day: "2026-09-10", tipCents: 750 }],
    );
    expect(rows).toEqual([
      {
        month: "2026-08",
        tipsCents: 1_500,
        tipsRefundedCents: 0,
        netTipsCents: 1_500,
        tippedPaymentCount: 1,
      },
      {
        month: "2026-09",
        tipsCents: 900,
        tipsRefundedCents: 750,
        netTipsCents: 150,
        tippedPaymentCount: 1,
      },
    ]);
  });
});

// ── refunds ────────────────────────────────────────────────────────────────

describe("the refund split with a tip", () => {
  it("takes only the invoice off revenue when the whole charge is refunded", () => {
    const s = splitRefund(14_000, 14_000, 0, 1_500);
    expect(s).toEqual({
      refundedCents: 14_000,
      revenueCents: 12_500,
      surchargeCents: 0,
      tipCents: 1_500,
      taxCents: 0,
    });
  });

  it("splits a partial refund in the charge's own ratio", () => {
    // $100 invoice + $15 tip, refunded $57.50: half of each.
    const s = splitRefund(5_750, 11_500, 0, 1_500);
    expect(s.revenueCents).toBe(5_000);
    expect(s.tipCents).toBe(750);
  });

  it("divides three ways when a surcharge and a tip share the charge", () => {
    const s = splitRefund(10_750, 10_750, 250, 500);
    expect(s).toEqual({
      refundedCents: 10_750,
      revenueCents: 10_000,
      surchargeCents: 250,
      tipCents: 500,
      taxCents: 0,
    });
  });

  it("never loses or invents a cent, and sums to the whole across partials", () => {
    for (const refunded of [1, 7, 33, 99, 1234, 5749, 11_499, 11_500]) {
      const s = splitRefund(refunded, 11_800, 300, 1_500);
      expect(s.revenueCents + s.surchargeCents + s.tipCents).toBe(s.refundedCents);
      expect(s.surchargeCents).toBeGreaterThanOrEqual(0);
      expect(s.tipCents).toBeGreaterThanOrEqual(0);
      expect(s.revenueCents).toBeLessThanOrEqual(s.refundedCents);
    }
    const a = splitRefund(3_000, 11_500, 0, 1_500);
    const rest = splitRefund(8_500, 11_500, 0, 1_500);
    const whole = splitRefund(11_500, 11_500, 0, 1_500);
    expect(a.revenueCents + rest.revenueCents).toBe(whole.revenueCents);
    expect(a.tipCents + rest.tipCents).toBe(whole.tipCents);
  });

  it("is exactly the old split when there is no tip", () => {
    for (const r of [1, 5_150, 10_300]) {
      const withTipArg = splitRefund(r, 10_300, 300, 0);
      const without = splitRefund(r, 10_300, 300);
      expect(withTipArg).toEqual(without);
      expect(without.tipCents).toBe(0);
    }
  });

  it("the webhook and the refund dialog both pass the tip to the split", () => {
    const hook = code(read("src/routes/api/public/hooks/stripe.ts"));
    // Followed by the payment's sales tax since 20260929110000.
    expect(
      hook.match(/Number\((?:rpay|pay)\.tip_cents \?\? 0\),\s*(?:Number\((?:rpay|pay)\.tax_cents \?\? 0\),\s*)?\)/g)
        ?.length,
    ).toBe(2);
    expect(code(read("src/lib/refunds.server.ts"))).toMatch(
      /splitRefund\(\s*amount,\s*quote\.chargedCents,\s*quote\.surchargeCents,\s*quote\.tipCents,?\s*(?:quote\.taxCents \?\? 0,?\s*)?\)/,
    );
  });

  it("offers a refund on a payment that is only tip left", () => {
    // $125 invoice + $15 tip, $125 refunded: $15 of the charge is still refundable.
    expect(
      canOfferRefund("owner", {
        status: "refunded",
        stripe_payment_intent_id: "pi_1",
        amount_cents: 12_500,
        tip_cents: 1_500,
        refunded_cents: 12_500,
      }),
    ).toBe(true);
  });
});

// ── what the office sees ───────────────────────────────────────────────────

describe("the tip on the invoice", () => {
  it("shows the charged total and its parts", () => {
    const split = surchargeSplit(12_500, 0, 1_500);
    expect(split).toEqual({
      chargedCents: 14_000,
      baseCents: 12_500,
      feeCents: 0,
      tipCents: 1_500,
    });
    const money = (c: number) => `$${(c / 100).toFixed(2)}`;
    expect(describePaymentSplit(split!, money)).toBe("$125.00 service + $15.00 tip");
    expect(describePaymentSplit(surchargeSplit(12_500, 375, 1_500)!, money)).toBe(
      "$125.00 service + $3.75 card fee + $15.00 tip",
    );
    expect(surchargeSplit(12_500, 0, 0)).toBeNull();
  });
});

// ── techs ──────────────────────────────────────────────────────────────────

describe("tips on the timesheet", () => {
  const CHI = "America/Chicago";
  const A = "aaaaaaaa-0000-4000-8000-000000000001";
  const B = "bbbbbbbb-0000-4000-8000-000000000002";
  const sheet = buildTimesheet({
    weekStart: "2026-09-21",
    tz: CHI,
    now: Date.parse("2026-09-27T12:00:00Z"),
    staff: [
      { id: A, display_name: "Alex" },
      { id: B, display_name: "Bea" },
    ],
    entries: [
      {
        id: "e1",
        staff_id: A,
        clock_in: "2026-09-21T13:00:00Z",
        clock_out: "2026-09-21T21:00:00Z",
      } as never,
    ],
    visits: [],
    tips: [
      // Monday evening in Chicago, Tuesday in UTC: counted on MONDAY.
      { tip_staff_id: A, tip_cents: 1_500, paid_at: "2026-09-22T01:30:00Z" },
      { tip_staff_id: A, tip_cents: 900, paid_at: "2026-09-21T18:00:00Z" },
      // Bea never clocked in and was tipped on Wednesday.
      { tip_staff_id: B, tip_cents: 1_000, paid_at: "2026-09-23T17:00:00Z" },
      // Unattributed, and a tip outside the week: neither is anybody's pay here.
      { tip_staff_id: null, tip_cents: 700, paid_at: "2026-09-23T17:00:00Z" },
      { tip_staff_id: A, tip_cents: 400, paid_at: "2026-09-29T17:00:00Z" },
    ],
  });

  it("totals each person's tips on the org's day", () => {
    const alex = sheet.rows.find((r) => r.staff.id === A)!;
    const bea = sheet.rows.find((r) => r.staff.id === B)!;
    expect(alex.tipsCents).toBe(2_400);
    expect(alex.days[0].tipsCents).toBe(2_400);
    expect(bea.tipsCents).toBe(1_000);
    expect(bea.days[2].tipsCents).toBe(1_000);
    expect(sheet.tipsCents).toBe(3_400);
  });

  it("puts tips in the payroll CSV, once per day, summing to the week", () => {
    expect(TIMESHEET_CSV_HEADERS).toContain("Tips");
    const col = TIMESHEET_CSV_HEADERS.indexOf("Tips");
    const rows = timesheetCsvRows(sheet, CHI);
    const total = rows.reduce((n, r) => n + Math.round(Number(r[col] || 0) * 100), 0);
    expect(total).toBe(3_400);
    // Bea's tipped day has no time and no visits, and still gets its row.
    expect(rows.filter((r) => r[0] === "Bea")).toEqual([
      ["Bea", "2026-09-23", "", "", "0.00", "0", "10.00", "No time recorded"],
    ]);
  });

  it("the timesheet reads only received, attributed tips, scoped to the org", () => {
    const src = code(read("src/lib/time-clock.functions.ts"));
    const fn = src.slice(src.indexOf("async function loadWeekTips"));
    expect(fn).toMatch(/\.select\("tip_staff_id, tip_cents, paid_at"\)/);
    expect(fn).toMatch(/\.eq\("organization_id", orgId\)/);
    expect(fn).toMatch(/\.in\("status", receivedPaymentStatuses\(\)\)/);
    // After the manage_users check, not before it.
    const list = src.slice(src.indexOf("export const listTimesheet"));
    expect(list.indexOf('"manage_users"')).toBeLessThan(list.indexOf("loadWeekTips("));
  });
});

// ── the migration ──────────────────────────────────────────────────────────

describe("the migration", () => {
  const sql = read("supabase/migrations/20260929030000_a-customer-could-not-leave-a-tip.sql");

  it("defaults tipping on for new organizations and off for existing ones", () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS tips_enabled boolean NOT NULL DEFAULT true/);
    expect(sql).toMatch(/UPDATE public\.organizations SET tips_enabled = false;/);
  });

  it("keeps tip_cents beside amount_cents, defaulted and never negative", () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS tip_cents integer NOT NULL DEFAULT 0/);
    expect(sql).toMatch(/CHECK \(tip_cents >= 0\)/);
  });

  it("gives the attribution lookup to service_role and nobody else", () => {
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.tip_staff_for_invoice\(uuid\) FROM PUBLIC, anon, authenticated;/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.tip_staff_for_invoice\(uuid\) TO service_role;/,
    );
    expect(sql).toMatch(/DO \$check\$/);
  });

  it("attributes to the most recent COMPLETED visit, in the invoice's own organization", () => {
    expect(sql).toMatch(/v\.status = 'completed'/);
    expect(sql).toMatch(/v\.organization_id = i\.organization_id/);
    expect(sql).toMatch(/ORDER BY v\.completed_at DESC NULLS LAST/);
  });
});
