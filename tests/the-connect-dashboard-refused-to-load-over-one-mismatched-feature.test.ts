// "Couldn't load the payment dashboard: The `features[capture_payments]`
//  property specified by `payments` and `payment_details` must be the same."
//
// Stripe requires every embedded component that shares a feature to declare the
// SAME value for it, and refuses the whole AccountSession when two disagree.
// `payments` set `capture_payments: false`; `payment_details` was
// `{ enabled: true }` with no features, so Stripe applied its own default of
// true. One mismatched boolean took down the entire dashboard — payouts,
// balances, disputes and tax documents included, because the session is
// rejected as a whole rather than per component.
//
// The fix is a single shared object spread into both. These assert it stays
// that way, because "add a feature to one component and forget the other" is
// the only way to reproduce this and it is an easy thing to do.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(import.meta.dirname, "..", "src/lib/stripe-connect.functions.ts"),
  "utf8",
);
/** Comments quote the very mismatch being removed, so they have to go before
 *  anything is matched — otherwise the prose satisfies the assertion. */
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("payments and payment_details cannot disagree", () => {
  it("declares the shared features exactly once", () => {
    const declarations = code.match(/const paymentFeatures = \{/g) ?? [];
    expect(declarations).toHaveLength(1);
  });

  it("spreads that one object into both components", () => {
    // Two spreads: payments.features and payment_details.features.
    const spreads = code.match(/\.\.\.paymentFeatures/g) ?? [];
    expect(spreads.length).toBeGreaterThanOrEqual(2);
  });

  it("gives payment_details a features block at all", () => {
    // The whole defect: `payment_details: { enabled: true }` with no features
    // silently inherits Stripe's defaults, which are not ours.
    expect(code).toMatch(/payment_details:\s*\{\s*enabled:\s*true,\s*features:/);
  });

  it("never sets capture_payments outside the shared object", () => {
    // A second literal is how the two drift apart again.
    const occurrences = code.match(/capture_payments/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  it("keeps the shared object to features both components accept", () => {
    // `smart_disputes_management` belongs to the dispute surface. Sending a
    // feature to a component that does not accept it is its own error, so it
    // stays on `payments` and out of the shared object.
    const shared = code.slice(
      code.indexOf("const paymentFeatures = {"),
      code.indexOf("} as const;"),
    );
    expect(shared).not.toMatch(/smart_disputes_management/);
    expect(shared).toMatch(/capture_payments/);
    expect(shared).toMatch(/refund_management/);
    expect(shared).toMatch(/dispute_management/);
    expect(shared).toMatch(/destination_on_behalf_of_charge_management/);
  });
});
