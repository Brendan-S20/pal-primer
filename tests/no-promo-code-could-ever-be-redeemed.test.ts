// Promo codes were broken end to end, in three separate places, and each break
// hid the next one.
//
//   1. `portal_redeem_promo` branched on `discount_type = 'amount'`. The column
//      carries CHECK (discount_type IN ('percent','fixed')), so that branch was
//      unreachable by construction and EVERY code fell into the ELSE. Measured
//      on the live database: 6 codes, 0 that could redeem.
//
//   2. The ELSE said "Percent codes are applied automatically to your next
//      invoice." Nothing applies them. A fixed-amount code — the kind that was
//      meant to work — got told it was a percent code AND told a discount was
//      already on its way. The customer closes the tab and waits.
//
//   3. `sendWinBack` inserted `applies_to: 'subscription'`, which the CHECK
//      constraint rejects. Every send raised "Promo create failed". The button
//      had never worked for anyone since it shipped. It also asked for a
//      percent code, so fixing only the constraint would have started mailing
//      lapsed customers codes their portal turns away — inert is better than
//      that.
//
// The assertions below are the decisions, not the implementation. Each one is
// something a later edit could quietly undo.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/**
 * Every file below explains the bug it fixes by quoting the broken code. A
 * `not.toMatch` on the bare string therefore fails against the comment that
 * documents the fix — which is the test being wrong, not the code. Four of
 * these assertions failed exactly that way on first run.
 *
 * So the negative assertions run against the file with comment lines removed.
 * Line-based and deliberately crude: it does not need to be a parser, it needs
 * to stop prose from impersonating code.
 */
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("--") || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");

const migration = read(
  "supabase/migrations/20260805100000_no-promo-code-could-ever-be-redeemed.sql",
);
const churn = read("src/lib/churn.functions.ts");
const promoFns = read("src/lib/promotions.functions.ts");
const promoPage = read("src/routes/_authenticated/settings.promotions.tsx");
const winBackEmail = read("src/lib/email-templates/win-back.tsx");
const analytics = read("src/routes/_authenticated/analytics.tsx");

describe("the redemption branch is reachable", () => {
  it("compares against a value the column can actually hold", () => {
    expect(migration).toMatch(/'_p\.discount_type = ''amount'''/);
    expect(migration).toMatch(/'_p\.discount_type = ''fixed'''/);
  });

  it("asserts each splice landed exactly once instead of hoping", () => {
    // A `replace()` that matches nothing returns the original string, so an
    // unguarded splice installs an unpatched copy and reports success. Both
    // replacements count their anchor first and raise if it is not 1.
    const guards = migration.match(/RAISE EXCEPTION 'expected exactly 1/g) ?? [];
    expect(guards).toHaveLength(2);
  });

  it("is a splice, not a retyped body", () => {
    // The body carries the expiry check, the redemption-limit check and the
    // already-used check. Restating ~30 lines to change one string literal is
    // how one of those silently disappears.
    expect(migration).toMatch(/pg_get_functiondef/);
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.portal_redeem_promo/);
  });

  it("is safe to re-run", () => {
    expect(migration).toMatch(/already patched'; RETURN;/);
  });
});

describe("the refusal message stopped reassuring", () => {
  it("replaces the old message with the new one, in that direction", () => {
    // Pinning the pair rather than the absence of the old string: the header
    // comment quotes the old wording on purpose, and it should keep doing so.
    expect(migration).toMatch(
      /'Percent codes are applied automatically to your next invoice',\s*\n\s*'This is a percentage code\./,
    );
  });

  it("installs no surviving copy of the reassurance", () => {
    expect(codeOnly(migration)).not.toMatch(
      /RAISE EXCEPTION 'Percent codes are applied automatically/,
    );
  });

  it("says the feature does not exist and what to do instead", () => {
    expect(migration).toMatch(/Percentage discounts are not supported yet/);
    expect(migration).toMatch(/ask us to apply it to your invoice/);
  });
});

describe("win-back creates a code that can actually be created", () => {
  it("uses an applies_to value the CHECK constraint allows", () => {
    // CHECK (applies_to IN ('first_visit','recurring','one_time')).
    expect(codeOnly(churn)).not.toMatch(/applies_to: "subscription"/);
    expect(churn).toMatch(/applies_to: "one_time"/);
  });

  it("issues a fixed amount, not a percentage", () => {
    expect(churn).toMatch(/discount_type: "fixed"/);
    expect(churn).toMatch(/discount_value_cents: data\.discountCents/);
    expect(churn).not.toMatch(/discount_percent: data\./);
  });

  it("takes cents and bounds them", () => {
    expect(churn).toMatch(/discountCents: z\.number\(\)\.int\(\)\.min\(100\)\.max\(20000\)/);
    expect(churn).not.toMatch(/discountPercent: z\.number\(\)/);
  });
});

describe("the win-back email states what the code is worth", () => {
  it("no longer offers a percentage off a month of service", () => {
    // There is no monthly figure to take a percentage of —
    // `subscriptions.price_cents` is per visit and no visits-per-cycle rule
    // exists anywhere in this codebase.
    expect(codeOnly(winBackEmail)).not.toMatch(/% off your next month of service/);
    expect(codeOnly(winBackEmail)).not.toMatch(/discountPercent/);
  });

  it("names the amount and where to enter the code", () => {
    expect(winBackEmail).toMatch(/discountAmount/);
    expect(winBackEmail).toMatch(/of credit toward your next service/);
    expect(winBackEmail).toMatch(/customer portal/);
  });

  it("the sender passes a formatted amount, matching the template's prop", () => {
    expect(churn).toMatch(/discountAmount: `\$\$?\{/);
  });
});

describe("the win-back control asks for dollars", () => {
  it("is a currency field, not a percent field", () => {
    expect(analytics).toMatch(/Credit offered/);
    expect(analytics).not.toMatch(/Discount %/);
    expect(analytics).toMatch(/discountCents: Math\.round\(discountDollars \* 100\)/);
  });

  it("says what sending one actually does", () => {
    expect(analytics).toMatch(/emails a single-use code worth the credit below/);
  });
});

describe("no new unredeemable codes get minted", () => {
  it("the form does not offer a percent option", () => {
    expect(promoPage).not.toMatch(/<SelectItem value="percent">/);
    expect(promoPage).not.toMatch(/Percent off/);
  });

  it("the server refuses percent too, because a removed SelectItem is not a closed endpoint", () => {
    expect(promoFns).toMatch(/data\.discountType === "percent"/);
    expect(promoFns).toMatch(/Percentage codes are not supported yet/);
  });

  it("still accepts 'percent' in the schema so existing rows read back", () => {
    expect(promoFns).toMatch(/discountType: z\.enum\(\["percent", "fixed"\]\)/);
  });

  it("drops the recurring-cycles promise, which credited once regardless", () => {
    expect(codeOnly(promoPage)).not.toMatch(/Recurring \(N cycles\)/);
    expect(codeOnly(promoPage)).not.toMatch(/cycles`/);
  });
});

describe("the codes already on file are labelled, not hidden", () => {
  it("percent codes still render, marked not redeemable", () => {
    expect(promoPage).toMatch(/p\.discount_type === "percent" && \(/);
    expect(promoPage).toMatch(/not redeemable/);
    expect(promoPage).toMatch(/a customer entering this in/);
  });
});
