import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const PICKER = "src/components/billing/PlanPicker.tsx";
const BILLING = "src/lib/billing.functions.ts";

// A customer could be charged for something the product never mentioned.
//
// BUILD-2 meters AI: every plan carries `ai_actions_included` (200 / 750 /
// 2,500 by tier) and `ai_overage_cents_per_action` ($0.10), and the nightly job
// posts the overage as an invoice item. Settings → AI Tools describes all of
// this correctly — allowance, live usage, rate, ceiling, and a definition of
// what one action is. But that is a screen you see AFTER buying.
//
// Every screen where the money was actually decided said nothing: the plan
// cards, the two "you're billed per employee" blurbs, the terms of service, and
// the paragraph directly above the card field.
//
// That last one is the one these tests are mostly about. This flow has no
// Stripe-hosted checkout page — the card is taken inline through a Payment
// Element — so there is no Stripe line-item summary to reveal the charge for
// us. Every word a buyer reads at the moment of purchase is ours, and both
// metered charges land on a LATER invoice, so nothing else in the flow would
// surface them in time to matter.
describe("the metered charges are named at the point of purchase", () => {
  it("the server sends the allowance to the payment form", () => {
    const src = read(BILLING);
    // Selected...
    const selects = [...src.matchAll(/\.select\(\s*"([^"]*)"/g)].map((m) => m[1]);
    expect(
      selects.some((s) => /ai_actions_included/.test(s) && /ai_overage_cents_per_action/.test(s)),
      "no .select() asks for the AI allowance, so the payment form cannot state it",
    ).toBe(true);
    // ...and actually returned, not merely fetched.
    expect(src, "createPlanSubscription does not return the allowance").toMatch(
      /aiActionsIncluded:\s*targetPlan\.ai_actions_included/,
    );
    expect(src).toMatch(/aiOverageCentsPerAction:\s*targetPlan\.ai_overage_cents_per_action/);
  });

  it("the paragraph above the card names the AI allowance and its rate", () => {
    const src = read(PICKER);
    const buy = src.slice(src.indexOf("Subscribe to {session.planName}"));
    expect(buy.length, "the checkout heading moved; this test is measuring nothing").toBeGreaterThan(
      200,
    );
    expect(buy, "the buy screen does not mention the AI allowance").toMatch(
      /session\.aiActionsIncluded/,
    );
    expect(buy, "the buy screen does not mention the per-action rate").toMatch(
      /session\.aiOverageCentsPerAction/,
    );
    expect(buy, "the buy screen should say when the metered charges land").toMatch(
      /billed on your next invoice/i,
    );
  });

  it("says nothing rather than 'null' when a plan negotiates its allowance", () => {
    // Enterprise carries null for both columns in the catalog. A card that
    // rendered "null AI actions" would be worse than silence, and a plan whose
    // allowance is by contract must not be given a number this code invented.
    const src = read(PICKER);
    expect(src).toMatch(/aiActionsIncluded != null/);
    expect(src).toMatch(/ai_actions_included != null/);
  });

  it("the plan cards carry it too, since that is the comparison screen", () => {
    const src = read(PICKER);
    expect(src, "plan cards do not show the AI allowance").toMatch(/AI actions`/);
    // Not expressible as a feature bullet: `features` is {} on every active plan.
    expect(src).toMatch(/ai_overage_cents_per_action != null/);
  });

  it("the terms name the metered charge, not only per-seat billing", () => {
    const terms = read("src/routes/legal.terms.tsx");
    expect(terms, "terms describe seats only").toMatch(/allowance of AI actions/i);
    expect(terms).toMatch(/published per-action rate/i);
    // The old bullet said "priced per active staff seat", which was never the
    // model — it is a flat tier plus a per-employee rate beyond an allowance.
    expect(terms).not.toMatch(/priced per\s*\n?\s*active staff seat/);
  });

  it("the two blurbs no longer say employees are the whole of it", () => {
    for (const f of [
      "src/routes/_authenticated/settings.billing.tsx",
      "src/routes/_authenticated/onboarding.tsx",
    ]) {
      expect(read(f), `${f} still describes billing as employees only`).toMatch(
        /AI actions past your plan's monthly allowance/,
      );
    }
  });
});
