import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  PLATFORM_FEE_BPS,
  PLATFORM_FEE_THRESHOLD_CENTS,
  feeReversalCents,
  platformFeeCents,
} from "@/lib/platform-fee";

// 50 basis points of a tenant→client charge, on charges over $10.
//
// Two things are pinned here, and the second matters more than the first.
//
// The arithmetic is easy to get right and easy to change by accident, so the
// expected numbers are written out in dollars rather than derived from the
// constants — a test that computes the answer the same way the code does agrees
// with the code even when both are wrong.
//
// The COVERAGE is the real subject. Ten places in src/ create a PaymentIntent on
// a connected account: three in portal.functions.ts, five in
// invoices.functions.ts, one in signup.functions.ts and one in the unattended
// nightly autopay run. A fee added to nine of them does not error, does not
// warn, and does not fail any test — it silently does not collect on whichever
// path was missed, and nightly.ts is the likely one because nobody watches it.
// This repo has already paid twice for that shape: twenty-four hardcoded app
// hosts that disagreed, and one revenue figure with three implementations
// (BUG-21). So the last describe block reads the source and refuses a charge
// built without the fee.

describe("the fee itself", () => {
  it("is 50 bps over a $10 floor", () => {
    expect(PLATFORM_FEE_BPS).toBe(50);
    expect(PLATFORM_FEE_THRESHOLD_CENTS).toBe(1000);
  });

  it("charges half a percent of the FULL amount, not of the excess", () => {
    // The decision was "$10 is a threshold, not a deduction". $100 → 50¢, which
    // is 0.5% of $100. The other reading gives 45¢ (0.5% of $90) and this case
    // is the whole difference between them.
    expect(platformFeeCents(10_000)).toBe(50);
    expect(platformFeeCents(20_000)).toBe(100);
    expect(platformFeeCents(4_500)).toBe(23); // 22.5¢ → 23
  });

  it("is free at exactly $10 and charged at $10.01", () => {
    // "Over $10" is strictly greater. Off-by-one here is a real, if small,
    // policy change applied to every transaction at the floor.
    expect(platformFeeCents(999)).toBe(0);
    expect(platformFeeCents(1_000)).toBe(0);
    // 0.5% of $10.01 is 5.005¢, which rounds to 5 — the fee does not ramp up
    // from zero at the floor, it steps straight to half a percent.
    expect(platformFeeCents(1_001)).toBe(5);
  });

  it("rounds to the nearest cent rather than truncating", () => {
    // application_fee_amount must be an integer. Truncating would give away a
    // fraction of a cent on most transactions for no reason.
    expect(platformFeeCents(3_740)).toBe(19); // 18.7 → 19
    expect(platformFeeCents(3_720)).toBe(19); // 18.6 → 19
    expect(platformFeeCents(3_660)).toBe(18); // 18.3 → 18
  });

  it("returns zero rather than NaN for unusable input", () => {
    // A NaN reaching Stripe as an application fee fails the whole charge, and
    // the customer's payment matters more than our fee.
    expect(platformFeeCents(Number.NaN)).toBe(0);
    expect(platformFeeCents(Number.POSITIVE_INFINITY)).toBe(0);
    expect(platformFeeCents(-5_000)).toBe(0);
    expect(platformFeeCents(0)).toBe(0);
  });
});

describe("giving it back on a refund", () => {
  it("returns the whole fee on a full refund", () => {
    expect(feeReversalCents(50, 10_000, 10_000)).toBe(50);
  });

  it("returns a proportional share on a partial refund", () => {
    expect(feeReversalCents(50, 10_000, 5_000)).toBe(25);
    expect(feeReversalCents(50, 10_000, 2_500)).toBe(13); // 12.5 → 13
  });

  it("is a cumulative TARGET, not an increment", () => {
    // This is the entire reason the function exists rather than a `×` inline.
    // Stripe fires charge.refunded once per refund and `amount_refunded` is
    // cumulative, so a handler reversing `proportion × fee` every time would
    // over-refund from the second partial refund onward.
    //
    // Two $25 refunds against a $100 charge: the caller sends target − already.
    const first = feeReversalCents(50, 10_000, 2_500);
    expect(first).toBe(13);
    const second = feeReversalCents(50, 10_000, 5_000) - first;
    expect(second).toBe(12);
    expect(first + second).toBe(25); // half the charge, half the fee
  });

  it("never returns more than the fee, even on absurd input", () => {
    // Stripe rejects a fee refund larger than the fee, and that error would
    // surface as a failure of the whole refund branch.
    expect(feeReversalCents(50, 10_000, 999_999)).toBe(50);
    expect(feeReversalCents(50, 0, 10_000)).toBe(0);
    expect(feeReversalCents(0, 10_000, 10_000)).toBe(0);
    expect(feeReversalCents(Number.NaN, 10_000, 10_000)).toBe(0);
    expect(feeReversalCents(50, 10_000, Number.NaN)).toBe(0);
  });

  it("reverses nothing when the charge was under the floor", () => {
    // No fee was taken, so there is nothing to give back.
    const fee = platformFeeCents(900);
    expect(fee).toBe(0);
    expect(feeReversalCents(fee, 900, 900)).toBe(0);
  });
});

/**
 * Every file that charges a client on a connected account.
 *
 * Listed by hand on purpose. A glob would quietly shrink to zero if the paths
 * moved, and a test that asserts things about an empty set passes — the exact
 * failure this suite keeps finding elsewhere. If a file here is renamed, this
 * breaks loudly and someone has to look.
 */
const CHARGING_FILES = [
  "src/lib/portal.functions.ts",
  "src/lib/invoices.functions.ts",
  "src/lib/signup.functions.ts",
  "src/routes/api/public/hooks/nightly.ts",
];

/** `paymentIntents.create(` occurrences, and whether the fee is within reach. */
function chargeSites(src: string): Array<{ at: number; hasFee: boolean }> {
  const out: Array<{ at: number; hasFee: boolean }> = [];
  const re = /paymentIntents\.create\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    // The params are either inline or spread from a `createParams` object built
    // just above — three call sites use the spread form so that a card-only
    // retry after a bank-debit failure cannot drift from the first attempt.
    // Looking back as well as forward covers both without parsing TypeScript.
    const window = src.slice(Math.max(0, m.index - 900), m.index + 900);
    out.push({ at: m.index, hasFee: /application_fee_amount:\s*platformFeeCents\(/.test(window) });
  }
  return out;
}

describe("no charge escapes the fee", () => {
  const found = CHARGING_FILES.map((f) => ({ file: f, src: readFileSync(f, "utf8") }));

  it("still finds all ten charge sites", () => {
    // If this number drops, either a payment path was deleted or a filename in
    // CHARGING_FILES went stale and the assertions below stopped measuring it.
    const total = found.reduce((n, f) => n + chargeSites(f.src).length, 0);
    expect(total).toBe(10);
  });

  for (const f of found) {
    it(`${f.file} applies the fee at every charge`, () => {
      const sites = chargeSites(f.src);
      expect(sites.length).toBeGreaterThan(0);
      const missing = sites.filter((s) => !s.hasFee).length;
      expect(
        missing,
        `${f.file} builds ${missing} PaymentIntent(s) on a connected account without ` +
          `application_fee_amount: platformFeeCents(...). That charge collects nothing ` +
          `for the platform, and nothing anywhere will report it — the money simply ` +
          `does not arrive. Use the helper in @/lib/platform-fee.`,
      ).toBe(0);
    });
  }

  it("computes the fee from the same amount it charges", () => {
    // A fee derived from a DIFFERENT variable than `amount` is the subtle
    // version of this bug: it collects, so nothing looks broken, but it collects
    // on the wrong number — the gross rather than the amount left after credit
    // was applied, for instance.
    for (const f of found) {
      const pairs = [...f.src.matchAll(
        /amount:\s*(\w+),\s*\n\s*application_fee_amount:\s*platformFeeCents\((\w+)\)/g,
      )];
      expect(pairs.length, `${f.file} has no amount/fee pair to check`).toBeGreaterThan(0);
      for (const [, amountVar, feeVar] of pairs) {
        expect(feeVar, `${f.file}: fee computed from ${feeVar} but charge is ${amountVar}`)
          .toBe(amountVar);
      }
    }
  });
});
