// HoundStack's own subscription must not be purchasable inside a store binary.
// The tenant's customers paying for pet-waste removal must keep working.
//
// Both halves need pinning, and the second is the one worth writing a test for:
// a later "hide anything to do with payments on iOS" would pass a test that
// only checked the first half, and would break the operational point of the
// field app.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  saasPurchaseAllowed,
  customerPaymentAllowed,
  MANAGE_BILLING_ON_WEB,
} from "@/lib/app-store-billing";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** Comments describe the rule; only code enforces it. Same stripper the other
 *  static tests in this repo use, for the same false-match reason. */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const BILLING_PAGE = "src/routes/_authenticated/settings.billing.tsx";

/** The JSX expression container enclosing `index`, found by balancing braces
 *  backwards. Returns the source from that `{` onwards, which is the scope a
 *  gate written on the conditional actually governs. */
function enclosingContainer(src: string, index: number): string {
  const before = src.slice(0, index);
  let depth = 0;
  for (let i = before.length - 1; i >= 0; i--) {
    const c = before[i];
    if (c === "}") depth++;
    else if (c === "{") {
      if (depth === 0) return before.slice(i);
      depth--;
    }
  }
  return "";
}

describe("the decision function", () => {
  it("refuses a HoundStack purchase on both store platforms", () => {
    expect(saasPurchaseAllowed("ios")).toBe(false);
    expect(saasPurchaseAllowed("android")).toBe(false);
  });

  it("allows it on the web, which is where the plan is sold", () => {
    expect(saasPurchaseAllowed("web")).toBe(true);
  });

  it("never blocks a tenant's customer paying for a real-world service", () => {
    for (const p of ["ios", "android", "web"]) {
      expect(customerPaymentAllowed(p), `${p} must still take payment`).toBe(true);
    }
  });
});

describe("the billing page", () => {
  const src = codeOnly(read(BILLING_PAGE));

  it("computes the gate from the real platform, not a constant", () => {
    expect(src).toMatch(/const canBuySaas = saasPurchaseAllowed\(platform\(\)\)/);
  });

  // Each of these is a way to START or CHANGE a HoundStack purchase.
  for (const surface of ["PlanPicker", "PaymentMethodsCard", "PlatformAddonsSection"]) {
    it(`renders ${surface} only when a purchase is allowed`, () => {
      const re = new RegExp(`<${surface}[\\s/>]`);
      const m = re.exec(src);
      expect(m, `${surface} is no longer rendered here — retarget this test`).toBeTruthy();
      // Scope the search to the enclosing JSX expression container, found by
      // balancing braces backwards from the element.
      //
      // "Nearest opening brace" was the first version of this and it was
      // WRONG: <PlanPicker> sits in the third branch of a nested ternary
      // (`!canBuySaas ? notice : checkout ? checkout : picker`), so the
      // nearest `(` is the branch's own, which of course contains no gate.
      // It failed against correctly gated code. Balancing finds the `{` that
      // opens the whole conditional, which is the scope the gate actually
      // governs — and still excludes an unrelated canBuySaas elsewhere in the
      // file, which is what this scoping is for.
      const before = src.slice(0, m!.index);
      let depth = 0;
      let open = -1;
      for (let i = before.length - 1; i >= 0; i--) {
        const c = before[i];
        if (c === "}") depth++;
        else if (c === "{") {
          if (depth === 0) {
            open = i;
            break;
          }
          depth--;
        }
      }
      expect(open, `could not find the JSX container around ${surface}`).toBeGreaterThan(-1);
      expect(before.slice(open), `${surface} is rendered without a canBuySaas gate`).toMatch(
        /canBuySaas/,
      );
    });
  }

  // iOS QA 2026-08-20 found this one on a device: the plan picker, the card
  // form and the add-ons were all correctly gated, and "Manage subscription"
  // — Cancel, and Resume — was rendered on `data.isPaidTier` alone, so a store
  // build still offered a way to CHANGE a HoundStack subscription. Resume is
  // the sharper edge: it restarts a paid plan from inside the binary.
  //
  // Anchored on the heading rather than on `cancelSub.mutate()`, because the
  // buttons sit inside `onClick={...}` and the nearest enclosing container of a
  // call site is that attribute, which no gate would ever govern. The heading
  // sits directly in the <section>, whose container is the conditional.
  it("renders Manage subscription (cancel/resume) only when a purchase is allowed", () => {
    const at = src.indexOf("Manage subscription");
    expect(at, "Manage subscription heading is gone — retarget this test").toBeGreaterThan(-1);
    expect(
      enclosingContainer(src, at),
      "cancel/resume is rendered without a canBuySaas gate",
    ).toMatch(/canBuySaas/);
  });

  it("still tells a store user their subscription is set to cancel", () => {
    // Gating the controls must not hide the STATUS: read-only account state is
    // exactly what app-store-billing.ts says to keep. The Current plan card
    // carries it, outside the gate.
    expect(src).toMatch(/Cancels at period end/);
  });

  it("says where billing lives instead of just hiding it", () => {
    expect(src).toMatch(/MANAGE_BILLING_ON_WEB/);
    expect(MANAGE_BILLING_ON_WEB).toMatch(/app\.houndstack\.com/);
  });

  it("does not tell a store user to pick a plan below that is not rendered", () => {
    // The trial and past-due nudges both pointed at controls the gate removes.
    const nudges = src.match(/You're on a free trial[^"]*/g) ?? [];
    expect(nudges.length, "trial nudge missing — retarget").toBeGreaterThan(0);
    expect(src).toMatch(/canBuySaas\s*\?[\s\S]{0,400}?app\.houndstack\.com/);
  });
});

describe("the tenant's own money is deliberately not gated", () => {
  // These take a homeowner's payment for pet-waste removal: a physical service,
  // outside IAP by Apple's own rules, and the operational point of the app.
  const CUSTOMER_PAYMENT_SURFACES = [
    "src/components/StaffInvoicePayForm.tsx",
    "src/components/client-detail/BillingTab.tsx",
  ];

  for (const f of CUSTOMER_PAYMENT_SURFACES) {
    it(`${f.split("/").pop()} still mounts a Payment Element on every platform`, () => {
      const src = codeOnly(read(f));
      expect(src, `${f} no longer takes payment — retarget this test`).toMatch(/<PaymentElement/);
      expect(
        src,
        `${f} was gated by store policy; it takes payment for a real-world service and must not be`,
      ).not.toMatch(/saasPurchaseAllowed|canBuySaas/);
    });
  }

  it("keeps the org selling to its own client, which reads like the thing that is blocked", () => {
    // createAddonSubscription sells a SERVICE to the org's customer.
    // subscribePlatformAddon buys SOFTWARE from HoundStack. Opposite sides.
    const panels = codeOnly(read("src/components/client-detail/billing-panels.tsx"));
    expect(panels).toMatch(/createAddonSubscription/);
    expect(panels).not.toMatch(/saasPurchaseAllowed|canBuySaas/);
  });
});
