import { toPosix } from "./support/repo-paths";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  STRIPE_ACH_BPS,
  STRIPE_ACH_CAP_CENTS,
  STRIPE_CARD_BPS,
  STRIPE_CARD_FIXED_CENTS,
  describeStripeAchRate,
  describeStripeCardRate,
  describeStripeRates,
} from "@/lib/processing-fee";
import { PLATFORM_FEE_BPS, PLATFORM_FEE_THRESHOLD_CENTS, describePlatformFee } from "@/lib/platform-fee";

// What a payment costs a tenant was written out in three places: the constants
// in processing-fee.ts, prose on the Payments page, and the marketing site.
//
// That is the shape this repo has already paid for and given a name -- one
// revenue figure with three implementations (BUG-21). Two of the three live
// here, so two of the three can be made to move together. The site is a
// separate repository and cannot be reached from a test; a rate change is still
// a two-repo edit, but it is now one edit per repo instead of one per surface,
// and this side fails loudly rather than drifting quietly.
//
// The scan at the bottom is the part that keeps it true. Deriving the sentence
// once does nothing if the next screen writes "2.9%" into its JSX by hand.

const SRC = join(process.cwd(), "src");

/** Every .ts/.tsx under src/, with comments removed. */
function sourceFiles(): Array<{ path: string; code: string }> {
  const out: Array<{ path: string; code: string }> = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name)) {
        const raw = readFileSync(p, "utf8");
        // Comments are exempt on purpose. processing-fee.ts's header carries a
        // worked table of what Stripe costs at five ticket sizes, and that
        // table is the reasoning behind the constants -- it is documentation,
        // not a second implementation, and deleting it to satisfy a regex
        // would cost more than it saves.
        const code = raw
          .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^[ \t]*\/\/.*$/gm, "");
        // Normalised HERE rather than at each comparison, because `path` is
        // consumed several times below against forward-slash literals.
        out.push({ path: toPosix(p.slice(process.cwd().length + 1)), code });
      }
    }
  };
  walk(SRC);
  return out;
}

describe("the rate is computed from the constants", () => {
  it("reads the way a person writes it", () => {
    // Written out rather than derived. A test that computes the answer the same
    // way the code does agrees with the code even when both are wrong.
    expect(describeStripeCardRate()).toBe("2.9% + 30¢");
    expect(describeStripeAchRate()).toBe("0.8% (capped at $5)");
    expect(describeStripeRates()).toBe("2.9% + 30¢ per card payment");
  });

  it("quotes cards only, because clients pay by card at launch (#461)", () => {
    // The ACH rate still exists for the fee math on an ACH payment that does
    // arrive. What a tenant reads must not offer bank payments as a way to pay.
    expect(describeStripeRates()).not.toMatch(/bank|ACH/i);
    expect(describeStripeRates()).not.toContain(describeStripeAchRate());
  });

  it("and those literals are what the constants actually say", () => {
    // The other direction: the pinned strings above are only right while the
    // constants hold. If somebody edits a constant and not this file, one of
    // these two blocks fails, which is the entire point of having both.
    expect(STRIPE_CARD_BPS).toBe(290);
    expect(STRIPE_CARD_FIXED_CENTS).toBe(30);
    expect(STRIPE_ACH_BPS).toBe(80);
    expect(STRIPE_ACH_CAP_CENTS).toBe(500);
    expect(describeStripeCardRate()).toContain(String(STRIPE_CARD_BPS / 100));
    expect(describeStripeCardRate()).toContain(String(STRIPE_CARD_FIXED_CENTS));
    expect(describeStripeAchRate()).toContain(String(STRIPE_ACH_CAP_CENTS / 100));
  });

  it("does not fold our own cut into Stripe's number", () => {
    // The two fees are not the same fee, and blending them would make the
    // surcharge quote unlawful as well as wrong -- see the header of
    // processing-fee.ts. Whatever HoundStack charges belongs to
    // describePlatformFee(), separately.
    expect(describeStripeRates()).not.toMatch(/HoundStack/i);
    expect(describeStripeRates()).not.toMatch(/platform/i);
  });
});

describe("our own fee names itself exactly when it exists", () => {
  it("says nothing at a rate of zero", () => {
    // Naming a fee of zero tells a tenant money is leaving that is not. This
    // is the same rule the franchise copy is held to, for the same reason.
    if (PLATFORM_FEE_BPS === 0) {
      expect(describePlatformFee()).toBeNull();
    } else {
      const said = describePlatformFee();
      expect(said, "PLATFORM_FEE_BPS is nonzero, so this must describe it").not.toBeNull();
      expect(said).toContain(`${PLATFORM_FEE_BPS / 100}%`);
      // The threshold is part of the term. "0.5%" alone is not what we charge,
      // and a tenant who checks it against a small ticket would find it false.
      expect(said).toContain(`$${PLATFORM_FEE_THRESHOLD_CENTS / 100}`);
    }
  });
});

describe("and it is said once", () => {
  const files = sourceFiles();

  it("looks at the whole of src, so a pass is not vacuous", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.path.endsWith("processing-fee.ts"))).toBe(true);
  });

  it("no file writes a rate out by hand", () => {
    // The failure this prevents: a new screen that needs to mention the price
    // and types the number, so the next rate change updates three surfaces and
    // misses the fourth. Comments are stripped before this runs.
    const RATE = /2\.9\s*%|0\.8\s*%|30¢|capped at \$5/;
    const offenders = files
      .filter((f) => !f.path.endsWith("src/lib/processing-fee.ts"))
      .flatMap((f) =>
        f.code
          .split("\n")
          .map((line, i) => ({ path: f.path, line: i + 1, text: line.trim() }))
          .filter((l) => RATE.test(l.text)),
      );
    expect(
      offenders.map((o) => `${o.path}:${o.line}  ${o.text.slice(0, 100)}`).join("\n"),
      "a payment rate is written out by hand here. Use describeStripeRates() " +
        "(or describeStripeCardRate/describeStripeAchRate) from @/lib/processing-fee, " +
        "so the next rate change moves every surface at once.",
    ).toBe("");
  });
});

describe("the screen where somebody decides", () => {
  const PAGE = readFileSync(
    join(SRC, "routes/_authenticated/payments.tsx"),
    "utf8",
  ).replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

  it("states the cost before an account is connected, not only after", () => {
    // The fault this fixes: the rate rendered only inside ProcessingFeeCard,
    // which is passed as `settings` under `cfg.chargesEnabled`. So a tenant
    // could read the price only once onboarding was finished -- after the
    // decision the marketing site quoted the number to get them to make.
    const preConnect = PAGE.slice(
      PAGE.indexOf("No Stripe account connected yet"),
      PAGE.indexOf("Set up payments"),
    );
    expect(preConnect.length, "the pre-connect branch moved").toBeGreaterThan(0);
    expect(preConnect).toMatch(/describeStripeRates\(\)/);
  });

  it("still states it on the settings card afterwards", () => {
    expect(PAGE).toMatch(/Stripe charges you \{describeStripeRates\(\)\}/);
  });

  it("mentions our fee on the pre-connect screen only when there is one", () => {
    // Rendered from describePlatformFee(), so the clause appears and disappears
    // with the constant instead of with somebody's memory.
    expect(PAGE).toMatch(/platformFee \? ` HoundStack adds \$\{platformFee\}\.` : ""/);
  });
});
