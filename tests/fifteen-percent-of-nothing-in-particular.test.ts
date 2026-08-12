// "15% off" — off what?
//
// `promo_codes.discount_percent` existed from the day the table was created and
// was never read by anything. The previous migration made `portal_redeem_promo`
// refuse percent codes honestly instead of failing them confusingly; this one
// answers the question the column never did.
//
// The answer had to come from the invoice generator, not from taste:
// `admin_generate_invoice_for_client` turns each completed visit into one line
// item at `subscriptions.price_cents`, so that number is the price of ONE
// VISIT. A percentage of it is the discount on one visit — which is exactly
// what the two surviving `applies_to` values, first_visit and one_time, mean.
//
// Verified against the live database before the code was written, with probes
// that RAISE at the end so every write rolls back:
//
//   15% of $99.00      -> 1485 cents, note "Promo: DEMOSPRING (15% of $99.00)"
//   second redemption  -> "You have already used this code"
//   DEMOSPRINGXL       -> 2475, i.e. a code whose name contains another code's
//                         name is NOT treated as already used
//   recurring + fixed  -> refused (it had been paying out as a lump credit)
//   percent, no plan   -> refused with a reason, fixed code on the same client
//                         still redeems
//   150% / 0%          -> rejected by promo_codes_percent_range_chk
//   100%               -> accepted; a free first visit is a real promotion
//
// ── THE SECOND LIE IN THE SAME FUNCTION ────────────────────────────────────
//
// `applies_to = 'recurring'` had no reader either. A recurring code promises a
// discount on every invoice for N cycles; redemption posts ONE credit, and a
// lump credit draws down against the next invoice in full rather than X% off
// each of the next N. Fixed-amount recurring codes had been paying out that way
// silently. Refused now, for both discount types — no such row exists in any
// org and the form never offered it, so this closes a path the product cannot
// reach rather than removing a feature.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const migration = readFileSync(
  join(root, "supabase/migrations/20260807030000_fifteen-percent-of-nothing-in-particular.sql"),
  "utf8",
);
const server = readFileSync(join(root, "src/lib/promotions.functions.ts"), "utf8");
const ui = readFileSync(join(root, "src/routes/_authenticated/settings.promotions.tsx"), "utf8");
const churn = readFileSync(join(root, "src/lib/churn.functions.ts"), "utf8");

/** Comment lines stripped, so a `not.toMatch` cannot be satisfied or defeated
 *  by the prose that documents the fix. */
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(
        t.startsWith("--") ||
        t.startsWith("//") ||
        t.startsWith("*") ||
        t.startsWith("/*") ||
        t.startsWith("{/*")
      );
    })
    .join("\n");

describe("the percentage resolves against a base that exists", () => {
  it("reads the column that had no reader", () => {
    expect(migration).toMatch(/_p\.discount_percent/);
    expect(migration).toMatch(/ROUND\(_base \* _p\.discount_percent \/ 100\.0\)::integer/);
  });

  it("takes the base from the per-visit subscription price", () => {
    expect(migration).toMatch(/SELECT s\.price_cents INTO _base/);
    expect(migration).toMatch(/FROM public\.subscriptions s/);
  });

  it("only counts plans that are live and priced", () => {
    // A cancelled plan is not a price the customer is paying, and a zero-priced
    // one resolves every percentage to zero — "Code has no value" would be a
    // baffling thing to tell someone holding a valid code.
    expect(migration).toMatch(/s\.status IN \('active','paused'\)/);
    expect(migration).toMatch(/s\.price_cents > 0/);
  });

  it("picks deterministically when a client has several plans", () => {
    // Without the tie-break, two redemptions of the same code by the same
    // customer could resolve against different properties.
    expect(migration).toMatch(/ORDER BY s\.price_cents DESC, s\.id/);
    expect(migration).toMatch(/LIMIT 1/);
  });

  it("refuses rather than crediting zero when there is no plan", () => {
    expect(migration).toMatch(/IF _base IS NULL THEN/);
    expect(migration).toMatch(/no active plan on your account/);
  });

  it("records the arithmetic on the ledger line", () => {
    // A $6.10 credit labelled only "Promo: SPRING" cannot be explained six
    // months later, once the plan price has moved.
    expect(migration).toMatch(/trim\(trailing '\.' from to_char\(_p\.discount_percent/);
    expect(migration).toMatch(/'% of \$'/);
  });
});

describe("recurring codes are refused, not paid out once", () => {
  it("refuses before either discount type is resolved", () => {
    const body = migration.slice(migration.indexOf("CREATE OR REPLACE FUNCTION"));
    const refusal = body.indexOf("_p.applies_to = 'recurring'");
    const fixedBranch = body.indexOf("_p.discount_type = 'fixed'");
    expect(refusal).toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(fixedBranch);
  });

  it("says why, in words a customer can act on", () => {
    expect(migration).toMatch(/Contact us and we will put it on your plan/);
  });

  it("the writer no longer accepts the value either", () => {
    // Removing a <SelectItem> does not close a POST endpoint.
    expect(server).toMatch(/appliesTo: z\.enum\(\["first_visit", "one_time"\]\)/);
    expect(codeOnly(server)).not.toMatch(/"recurring"/);
  });

  it("drops recurringCycles with it", () => {
    // A cycle count on a one-off credit was decoration on a number nothing read.
    expect(codeOnly(server)).not.toMatch(/recurringCycles/);
    expect(server).toMatch(/recurring_cycles: null/);
  });
});

describe("the already-used check survived the note getting longer", () => {
  it("compares the part before the arithmetic", () => {
    expect(migration).toMatch(/split_part\(note, ' \(', 1\) = 'Promo: '\|\|upper\(_p\.code\)/);
  });

  it("does not reach for LIKE", () => {
    // A LIKE prefix would need escaping for codes containing % or _, and would
    // let SPRING match SPRING25. split_part is exact string equality.
    const body = migration.slice(migration.indexOf("CREATE OR REPLACE FUNCTION"));
    expect(codeOnly(body)).not.toMatch(/note LIKE/);
  });

  it("still runs before the amount is worked out", () => {
    // Otherwise someone redeeming twice with no active plan is told their
    // account has no plan, which is true and unhelpful.
    const body = migration.slice(migration.indexOf("CREATE OR REPLACE FUNCTION"));
    expect(body.indexOf("already used this code")).toBeLessThan(
      body.indexOf("SELECT s.price_cents INTO _base"),
    );
  });
});

describe("the constraints the app assumed and the table never had", () => {
  it("bounds the percentage", () => {
    // `discount_percent` had no range check at all. Nothing but a Zod schema in
    // one server function stood between a typo and a 1500%-off code, and now
    // that a reader exists, an out-of-range row is money.
    expect(migration).toMatch(/promo_codes_percent_range_chk/);
    expect(migration).toMatch(/discount_percent > 0 AND discount_percent <= 100/);
  });

  it("allows 100 and refuses 0", () => {
    // A free visit is a promotion people run. Zero percent off is not.
    expect(migration).toMatch(/<= 100/);
    expect(migration).toMatch(/discount_percent > 0/);
  });

  it("requires the field the discount type actually uses", () => {
    expect(migration).toMatch(/promo_codes_discount_shape_chk/);
    expect(migration).toMatch(/discount_type = 'percent' AND discount_percent IS NOT NULL/);
    expect(migration).toMatch(/discount_type = 'fixed' AND discount_value_cents IS NOT NULL/);
  });

  it("is mirrored in the server schema so the error is legible", () => {
    expect(server).toMatch(/A percentage code needs a percentage\./);
    expect(server).toMatch(/A fixed-amount code needs an amount\./);
    expect(server).toMatch(/z\.number\(\)\.gt\(0\)\.max\(100\)/);
  });

  it("writes exactly one of the two value columns", () => {
    // A row with both set would redeem off the type alone and read as a
    // contradiction to anyone auditing it.
    expect(server).toMatch(/discount_value_cents: isPercent \? null :/);
    expect(server).toMatch(/discount_percent: isPercent \?/);
  });
});

describe("the migration will not clobber something it did not read", () => {
  it("asserts the live definition before replacing it", () => {
    expect(migration).toMatch(/refusing to clobber it/);
    expect(migration).toMatch(/pg_get_functiondef/);
  });

  it("recognises its own output, so re-running is safe", () => {
    expect(migration).toMatch(/already resolves percentage codes/);
  });

  it("says why it restates the body instead of splicing", () => {
    // House style patches pg_get_functiondef output. That reasoning is about
    // long bodies losing branches to a retype; this body is thirty lines and
    // this change rewrites most of them.
    expect(migration).toMatch(/WHY A FULL BODY AND NOT A SPLICE/);
  });
});

describe("the product stops calling percent codes broken", () => {
  it("offers the choice again", () => {
    expect(ui).toMatch(/<SelectItem value="percent">Percentage<\/SelectItem>/);
    expect(ui).toMatch(/<SelectItem value="fixed">Fixed amount<\/SelectItem>/);
  });

  it("keeps fixed as the default", () => {
    // Percent used to be the default, which is how three unredeemable codes got
    // minted. It is the type whose value the office cannot state up front.
    expect(ui).toMatch(/discountType: "fixed" as "fixed" \| "percent"/);
  });

  it("tells the office what the percentage is of", () => {
    expect(ui).toMatch(/off one visit at the customer's own/);
  });

  it("no longer marks percent codes not redeemable", () => {
    const code = codeOnly(ui);
    expect(code).not.toMatch(/Percentage codes are not applied anywhere yet/);
    expect(code).not.toMatch(
      /discount_type === "percent" &&\s*\(?\s*<Badge variant="destructive">/,
    );
  });

  it("moves that warning onto the rows that are genuinely stuck", () => {
    expect(ui).toMatch(/p\.applies_to === "recurring" && \(\s*<Badge variant="destructive">/);
    expect(ui).toMatch(/Recurring codes are refused at redemption/);
  });

  it("sends only the field the chosen type uses", () => {
    expect(ui).toMatch(/\{ discountPercent: v\.discountPercent \}/);
    expect(ui).toMatch(/\{ discountValueCents: Math\.round\(v\.discountValueCents\) \}/);
  });
});

describe("the win-back note stops claiming percentages are unimplemented", () => {
  it("no longer says nothing applies a percentage, in the present tense", () => {
    expect(churn).not.toMatch(/nothing in this system\s*\n?\s*\*?\s*applies a percentage/);
    expect(churn).toMatch(/Percent codes redeem now/);
  });

  it("keeps win-back on dollars, and says why that is now a choice", () => {
    // "20% off" against a per-visit base is a few dollars, not the month of
    // service the phrase implies to a lapsed customer.
    expect(churn).toMatch(/that is now\s*\n?\s*\*?\s*a choice rather than a limitation/);
    expect(churn).toMatch(/discountCents: z\.number\(\)\.int\(\)\.min\(100\)\.max\(20000\)/);
  });
});
