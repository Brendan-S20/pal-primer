import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  PLATFORM_FEE_BPS,
  PLATFORM_FEE_THRESHOLD_CENTS,
  feeReversalCents,
  platformFeeCents,
} from "@/lib/platform-fee";

// The platform's cut of a tenant→client charge. Currently ZERO — see the header
// of src/lib/platform-fee.ts for why, which is a pricing decision rather than a
// disabled feature.
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
//
// That block still earns its keep at a rate of zero — arguably more than it did
// at 50 bps. The wiring is what makes the rate a one-line change, so the wiring
// is what has to stay proven while nothing is being collected through it.

describe("the fee itself", () => {
  it("is zero, deliberately, and not as a placeholder", () => {
    // HoundStack posts Stripe's 2.9% + 30¢ as the whole cost of taking a
    // payment. On a direct charge Stripe bills that to the TENANT'S connected
    // account, so anything added here makes the real cost exceed the published
    // one — which is a pricing problem no wording solves.
    expect(PLATFORM_FEE_BPS).toBe(0);
    // The floor is part of the term, not part of the rate, and outlives it.
    expect(PLATFORM_FEE_THRESHOLD_CENTS).toBe(1000);
  });

  it("collects nothing at any amount", () => {
    for (const cents of [1_001, 4_500, 10_000, 20_000, 250_000, 9_999_999]) {
      expect(platformFeeCents(cents)).toBeUndefined();
    }
  });

  it("returns undefined rather than 0, so the key never reaches Stripe", () => {
    // This is the whole reason the rate could be turned off without editing ten
    // payment paths. Each call site spends the return value straight into
    // `application_fee_amount`: undefined omits the key, 0 would send a field we
    // do not mean on every charge the platform makes.
    const fee = platformFeeCents(10_000);
    expect(fee).toBeUndefined();
    expect(fee).not.toBe(0);
    // And the omission is real at the object level, not just falsy.
    expect(Object.hasOwn({ application_fee_amount: fee }, "application_fee_amount")).toBe(true);
    expect(JSON.stringify({ application_fee_amount: fee })).toBe("{}");
  });

  it("returns undefined rather than NaN for unusable input", () => {
    // A NaN reaching Stripe as an application fee fails the whole charge, and
    // the customer's payment matters more than our fee — at any rate.
    expect(platformFeeCents(Number.NaN)).toBeUndefined();
    expect(platformFeeCents(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(platformFeeCents(-5_000)).toBeUndefined();
    expect(platformFeeCents(0)).toBeUndefined();
  });

  it("has expected numbers written for whatever rate is set", () => {
    // The guard that makes the next rate change safe. platformFeeCents reads the
    // constant directly, so the arithmetic cases below can only run at the rate
    // they were written for. Any THIRD value arrives with no cases at all —
    // which is exactly the silent change the module header says must not happen.
    // Set a new rate, and this fails until its numbers are written.
    expect([0, 50]).toContain(PLATFORM_FEE_BPS);
  });
});

// Kept, not deleted. These took the two decisions that define the term — "$10
// is a threshold, not a deduction", and round rather than truncate — and they
// come back the moment the rate does. `describe.skip` would hide them from the
// count; this form re-arms them automatically at 50 bps.
const at50 = PLATFORM_FEE_BPS === 50 ? describe : describe.skip;
at50("the 50 bps arithmetic, when that is the rate", () => {
  it("charges half a percent of the FULL amount, not of the excess", () => {
    // "$10 is a threshold, not a deduction". $100 → 50¢, which is 0.5% of $100.
    // The other reading gives 45¢ (0.5% of $90) and this case is the whole
    // difference between them.
    expect(platformFeeCents(10_000)).toBe(50);
    expect(platformFeeCents(20_000)).toBe(100);
    expect(platformFeeCents(4_500)).toBe(23); // 22.5¢ → 23
  });

  it("is free at exactly $10 and charged at $10.01", () => {
    expect(platformFeeCents(999)).toBeUndefined();
    expect(platformFeeCents(1_000)).toBeUndefined();
    // 0.5% of $10.01 is 5.005¢ → 5. The fee does not ramp up from zero at the
    // floor, it steps straight to half a percent.
    expect(platformFeeCents(1_001)).toBe(5);
  });

  it("rounds to the nearest cent rather than truncating", () => {
    expect(platformFeeCents(3_740)).toBe(19); // 18.7 → 19
    expect(platformFeeCents(3_720)).toBe(19); // 18.6 → 19
    expect(platformFeeCents(3_660)).toBe(18); // 18.3 → 18
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

  it("reverses nothing when no fee was taken", () => {
    // Nothing was collected, so there is nothing to give back. At a zero rate
    // that is every charge; at 50 bps it was every charge under the floor. The
    // reversal side is rate-independent by design — it works from the fee Stripe
    // reports on the charge, not from a recomputation — which is why the rest of
    // this block still means something with the rate off.
    const fee = platformFeeCents(900);
    expect(fee).toBeUndefined();
    expect(feeReversalCents(fee ?? 0, 900, 900)).toBe(0);
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
  // Tap to Pay on the phone (#579): the card_present intent.
  "src/lib/tap-to-pay.server.ts",
];

/** `paymentIntents.create(` occurrences, and whether the fee is within reach. */
function chargeSites(src: string): Array<{ at: number; hasFee: boolean; hasRadar: boolean }> {
  const out: Array<{ at: number; hasFee: boolean; hasRadar: boolean }> = [];
  const re = /paymentIntents\.create\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    // The params are either inline or spread from a `createParams` object built
    // just above — three call sites use the spread form so that a card-only
    // retry after a bank-debit failure cannot drift from the first attempt.
    // Looking back as well as forward covers both without parsing TypeScript.
    //
    // The fee may be wrapped in withPassThroughFees (#825), which adds the
    // Radar fee Stripe bills the platform for the business's charge. The
    // window reaches further back than it once did because the tap site
    // explains, above its create call, why its Radar fee is zero.
    const window = src.slice(Math.max(0, m.index - 1400), m.index + 900);
    out.push({
      at: m.index,
      hasFee: /application_fee_amount:\s*(?:withPassThroughFees\(\s*)?platformFeeCents\(/.test(
        window,
      ),
      hasRadar: /application_fee_amount:\s*withPassThroughFees\(/.test(window),
    });
  }
  return out;
}

describe("no charge escapes the fee", () => {
  const found = CHARGING_FILES.map((f) => ({ file: f, src: readFileSync(f, "utf8") }));

  it("still finds all eleven charge sites", () => {
    // If this number drops, either a payment path was deleted or a filename in
    // CHARGING_FILES went stale and the assertions below stopped measuring it.
    const total = found.reduce((n, f) => n + chargeSites(f.src).length, 0);
    expect(total).toBe(11);
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

  for (const f of found) {
    it(`${f.file} passes Stripe's Radar fee through at every charge (#825)`, () => {
      // Brendan, 2026-11-10: "Pass Radar fees to each business, like the tap
      // fee". A charge site that sets the platform fee but not the Radar
      // pass-through leaves the platform paying the business's screening,
      // and while the platform fee is zero nothing else would show it.
      const missing = chargeSites(f.src).filter((s) => !s.hasRadar).length;
      expect(
        missing,
        `${f.file} builds ${missing} PaymentIntent(s) whose application fee does not go ` +
          `through withPassThroughFees(...) from @/lib/radar-fee. Stripe bills Radar for ` +
          `that charge to the platform under application_express.`,
      ).toBe(0);
    });
  }

  it("computes the fee from the amount owed, whatever it ends up charging", () => {
    // A fee derived from the WRONG variable is the subtle version of this bug:
    // it collects, so nothing looks broken, but it collects on the wrong number
    // — the gross rather than the amount left after credit was applied, say.
    //
    // Until pass-through processing fees the rule was simply "same variable as
    // `amount`". It is now two rules, because those two numbers legitimately
    // differ: a surcharged charge is base + surcharge, and we deliberately do
    // NOT take 50 bps of a fee the tenant is recovering from Stripe. So:
    //
    //   application_fee_amount  must come from the invoice amount (dueCents /
    //                           amountCents) — the base, always.
    //   amount                  must be either that same base, or the quoted
    //                           total that was derived from it.
    //
    // Anything else — a fee on `quote.totalCents`, or a charge on some third
    // variable — is the original bug wearing a new shape.
    const BASE_VARS = new Set(["dueCents", "amountCents"]);
    const CHARGE_VARS = new Set([...BASE_VARS, "quote.totalCents"]);
    for (const f of found) {
      const pairs = [
        ...f.src.matchAll(
          // An optional second argument, the invoice: the fee is not taken on
          // its sales tax (20260929110000).
          // The fee may be wrapped in withPassThroughFees (#825).
          /amount:\s*([\w.]+),\s*\n\s*application_fee_amount:\s*(?:withPassThroughFees\(\s*)?platformFeeCents\((\w+)(?:, \w+)?\)/g,
        ),
      ];
      expect(pairs.length, `${f.file} has no amount/fee pair to check`).toBeGreaterThan(0);
      for (const [, amountVar, feeVar] of pairs) {
        expect(
          BASE_VARS.has(feeVar),
          `${f.file}: platform fee computed from ${feeVar}. It must be the invoice ` +
            `amount — taking 50 bps of a pass-through processing fee bills the tenant ` +
            `for recovering Stripe's own charge.`,
        ).toBe(true);
        expect(
          CHARGE_VARS.has(amountVar),
          `${f.file}: charges ${amountVar}, which is neither the invoice amount nor a ` +
            `quoted total derived from it.`,
        ).toBe(true);
      }
    }
  });
});
