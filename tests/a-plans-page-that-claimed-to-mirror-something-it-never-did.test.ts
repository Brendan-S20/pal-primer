// The Plans page said, in the paragraph under its own heading:
//
//     "Stripe products/prices are mirrored from here once the platform Stripe
//      key is set."
//
// Nothing in this repo had ever created a Stripe product or a Stripe price for
// a plan. `platform-addons.functions.ts` does it for ADD-ONS — a product, a
// price, a write-back — and that is presumably where the sentence came from,
// but plans had no server function at all. `platform_plans` has carried INSERT
// and DELETE policies for platform admins since migration 20260810120000, and
// the only thing that ever used them was `updatePlatformPlan`, which updates.
//
// So the screen described a capability the product did not have, to the one
// person in a position to rely on it. That is the same fault class as a green
// check that measured nothing: not a wrong number, a wrong claim.
//
// ── WHICH HALF-STATE IS SURVIVABLE ────────────────────────────────────────
//
// Creating a plan touches two systems with no transaction across them, so the
// question is not how to avoid a half state, it is which half state to choose.
// They are not symmetric, and this test pins the choice:
//
//   * plan row, no Stripe price, ON SALE — the bad one. `listPlatformPlans`
//     does not filter on price ids, so the tenant sees it; `createPlanSubscription`
//     does, so the tenant is then told "That plan isn't available. Contact
//     support."
//   * plan row, no Stripe price, OFF SALE — inert. Not in any picker, and
//     `assign_billing_tier_for_org` asks `is_active = true` before anything
//     else, so no tenant can be moved onto it either.
//   * Stripe objects, no plan row — bills nobody, and is re-adopted by NAME on
//     the retry rather than duplicated, because every price is minted with its
//     `lookup_key`.
//
// Hence: insert off sale, then mirror, then write the ids back. And a mirroring
// failure must not be reported as a failure to create — the row exists, and
// saying "it failed" about something that succeeded is its own bug.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** Strip comments. This file's own subject is a sentence, and the modules
 *  under test quote the wrong version of it in their explanations. */
const codeOnly = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("{/*");
    })
    .join("\n");

const plansRoute = read("src/routes/platform.plans.tsx");
const plansRouteCode = codeOnly(plansRoute);
const platformFns = read("src/lib/platform.functions.ts");
const platformFnsCode = codeOnly(platformFns);

/** `createPlatformPlan` through to the next top-level export. */
const createHandler = platformFnsCode.slice(
  platformFnsCode.indexOf("export const createPlatformPlan ="),
  platformFnsCode.indexOf("export const mirrorPlatformPlan ="),
);
const mirrorRecorder = platformFnsCode.slice(
  platformFnsCode.indexOf("async function mirrorPlanAndRecord"),
  platformFnsCode.indexOf("export const getPlatformStripeConfig ="),
);

describe("the page no longer claims a thing it cannot do", () => {
  it("has dropped the sentence that was false for plans", () => {
    expect(plansRoute).not.toMatch(/Stripe products\/prices are mirrored from here/);
  });

  it("says which action mirrors and which does not", () => {
    // The distinction is the whole correction. "Mirroring happens here" would
    // be just as wrong in the other direction: editing a plan's price still
    // changes nothing in Stripe.
    expect(plansRouteCode).toMatch(/Creating a plan here also creates its Stripe product and prices/);
    expect(plansRouteCode).toMatch(/Editing an existing plan changes this catalog only/);
  });

  it("no longer promises a re-mirror the edit dialog cannot perform", () => {
    // "existing Stripe subscriptions keep their current price until re-mirrored"
    // implied a re-pricing path. There isn't one — mirroring fills EMPTY
    // columns and never touches a price a tenant may be subscribed to.
    expect(plansRoute).not.toMatch(/until re-mirrored/);
    expect(plansRouteCode).toMatch(/Nothing in Stripe changes/);
  });
});

describe("creating a plan exists, and is gated like its siblings", () => {
  it("is a POST server function with a validator", () => {
    expect(platformFnsCode).toMatch(/export const createPlatformPlan = createServerFn\(\{ method: "POST" \}\)/);
    expect(createHandler).toMatch(/\.inputValidator\(\(d\) => createPlatformPlanSchema\.parse\(d\)\)/);
    expect(createHandler).toMatch(/\.middleware\(\[requireSupabaseAuth\]\)/);
  });

  it("asserts platform admin before it reads or writes anything", () => {
    // Same gate as updatePlatformPlan, and FIRST — a check after the first
    // query is a check that has already leaked the catalog.
    const gate = createHandler.indexOf("await assertPlatformAdmin(context.supabase, context.userId)");
    const firstQuery = createHandler.indexOf('.from("platform_plans")');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(firstQuery);
  });

  it("gates the mirroring retry the same way", () => {
    const retry = platformFnsCode.slice(platformFnsCode.indexOf("export const mirrorPlatformPlan ="));
    expect(retry).toMatch(/await assertPlatformAdmin\(context\.supabase, context\.userId\)/);
    expect(retry).toMatch(/\.middleware\(\[requireSupabaseAuth\]\)/);
  });

  it("reads whether Stripe is configured behind the same gate", () => {
    // It reports which ACCOUNT a key points at, which is not a thing to hand
    // an unauthenticated caller just because it is only a boolean and a word.
    const cfg = platformFnsCode.slice(
      platformFnsCode.indexOf("export const getPlatformStripeConfig ="),
      platformFnsCode.indexOf("export const createPlatformPlan ="),
    );
    expect(cfg).toMatch(/await assertPlatformAdmin\(context\.supabase, context\.userId\)/);
  });
});

describe("the row is written first, and written off sale", () => {
  it("inserts with is_active false", () => {
    // Scoped to the INSERT payload. The audit row alongside it also records
    // `is_active: false`, so a search over the whole handler passes even when
    // the row itself goes in on sale — which is the mutation this caught.
    const insert = createHandler.slice(
      createHandler.indexOf(".insert({"),
      createHandler.indexOf(".select(\"id, slug, name\")"),
    );
    expect(insert.length).toBeGreaterThan(200);
    expect(insert).toMatch(/is_active: false/);
    // Not "whatever the form said".
    expect(insert).not.toMatch(/is_active: (true|data\.|input\.)/);
  });

  it("mirrors only after the row exists", () => {
    const insert = createHandler.indexOf(".insert({");
    const mirror = createHandler.indexOf("await mirrorPlanAndRecord(");
    expect(insert).toBeGreaterThan(-1);
    expect(mirror).toBeGreaterThan(insert);
  });

  it("does not offer an Active switch on the create form", () => {
    // Creating something and putting it on sale are one click apart on purpose:
    // "Offer again" already states the blast radius (signup, every tenant's
    // picker) and this form does not restate it, so it must not perform it.
    const dialog = plansRouteCode.slice(
      plansRouteCode.indexOf("<DialogTitle>New plan</DialogTitle>"),
      plansRouteCode.indexOf("<Dialog open={!!editing}"),
    );
    expect(dialog.length).toBeGreaterThan(500);
    expect(dialog).not.toMatch(/isActive/);
    expect(dialog).toMatch(/off sale/);
  });
});

describe("a failed mirror is reported as what it is", () => {
  it("does not throw out of the create handler", () => {
    // The row exists. Throwing here would tell the admin the plan was not
    // created, and they would create it again.
    expect(createHandler).toMatch(/const mirror = await mirrorPlanAndRecord\(/);
    expect(createHandler).toMatch(/return \{ planId: [^}]*mirror \}/);
  });

  it("returns a stated problem rather than a bare boolean", () => {
    expect(platformFnsCode).toMatch(/problem: string \| null/);
  });

  it("says so when there is no Stripe key at all, instead of failing oddly", () => {
    const block = mirrorRecorder.slice(0, mirrorRecorder.indexOf('.from("platform_plans")'));
    expect(block).toMatch(/STRIPE_SECRET_KEY/);
    expect(block).toMatch(/is not set on this deployment/);
    // Degrading, not throwing: the catalog row is still worth having.
    expect(block).not.toMatch(/throw new Error/);
  });

  it("tells the truth when Stripe succeeded and the database write did not", () => {
    // The objects exist. Claiming nothing happened would send someone looking
    // for a product that is sitting right there.
    expect(mirrorRecorder).toMatch(/were created, but saving their ids failed/);
    expect(mirrorRecorder).toMatch(/adopts the same ones rather than making more/);
  });

  it("only ever fills EMPTY id columns", () => {
    // The add-on path learned this out loud: a write-back that overwrites is
    // how a live price id is replaced with a test one.
    expect(mirrorRecorder).toMatch(/if \(outcome\.productId && !plan\.stripe_product_id\)/);
    expect(mirrorRecorder).toMatch(/if \(!\(plan as Record<string, unknown>\)\[column\]\) patch\[column\] = priceId/);
  });

  it("surfaces both outcomes in the console, in different words", () => {
    const success = plansRouteCode.slice(
      plansRouteCode.indexOf("const create = useMutation"),
      plansRouteCode.indexOf("const mirror = useMutation"),
    );
    expect(success).toMatch(/if \(r\.mirror\.problem\)/);
    expect(success).toMatch(/toast\.warning\(/);
    expect(success).toMatch(/toast\.success\(/);
    expect(success).toMatch(/onError: \(e: Error\) => toast\.error\(e\.message\)/);
  });
});

describe("the catalog says which plans are not in Stripe", () => {
  // The Stripe column's own cell, between the Customers cell and the actions
  // cell. Scoped, because `planMirrorState` and every label still appear
  // elsewhere in the file when the CELL has been reverted to a dash — which is
  // exactly the mutation that slipped through the first version of this test.
  const stripeCell = plansRouteCode.slice(
    plansRouteCode.indexOf("Unlimited</TableCell>"),
    plansRouteCode.indexOf("justify-end gap-1"),
  );

  it("no longer prints a dash for three different situations", () => {
    // `stripe_price_id ?? "-"` read the same for a contact-us tier, a free
    // plan and a mirroring that never ran. Only the third is a problem.
    expect(stripeCell.length).toBeGreaterThan(200);
    expect(stripeCell).not.toMatch(/stripe_price_id \?\?/);
    expect(stripeCell).toMatch(/mirrorLabel\(p\)/);
    for (const label of ["Billed by contract", "No chargeable price", "Not in Stripe"]) {
      expect(plansRouteCode).toContain(label);
    }
    expect(plansRouteCode).toMatch(/planMirrorState\(p\)/);
  });

  it("offers the retry only where there is something to mirror", () => {
    expect(stripeCell).toMatch(/canMirror \? \(/);
    expect(stripeCell).toMatch(/Mirror to Stripe/);
    expect(stripeCell).toMatch(/mirror\.mutate\(p\)/);
  });

  it("reads every Stripe column it judges the state from", () => {
    // Judging "mirrored" from the base price alone would call a plan complete
    // while its seat and annual prices were missing.
    const select = plansRouteCode.slice(plansRouteCode.indexOf('.from("platform_plans")'));
    for (const col of [
      "stripe_product_id",
      "stripe_price_id",
      "stripe_annual_price_id",
      "stripe_seat_price_id",
      "stripe_annual_seat_price_id",
    ]) {
      expect(select.slice(0, 800)).toContain(col);
    }
  });
});

describe("the form fits a phone", () => {
  it("scrolls inside the dialog instead of hanging off both ends of it", () => {
    // ui/dialog.tsx centres its content with no max height, so a form taller
    // than the viewport is clipped top AND bottom and the Save button cannot be
    // reached at all. Same fix platform.users.tsx and OneOffVisitDialog use.
    const dialog = plansRouteCode.slice(plansRouteCode.indexOf("open={creating}"));
    expect(dialog.slice(0, 400)).toMatch(/max-h-\[90dvh\] overflow-y-auto/);
  });

  it("stacks its paired fields below sm rather than halving a 360px screen", () => {
    const dialog = plansRouteCode.slice(
      plansRouteCode.indexOf("<DialogTitle>New plan</DialogTitle>"),
      plansRouteCode.indexOf("<Dialog open={!!editing}"),
    );
    expect(dialog).toMatch(/grid-cols-1 gap-3 sm:grid-cols-2/);
    expect(dialog).not.toMatch(/className="grid grid-cols-2/);
  });

  it("gives the raw select a thumb-sized target", () => {
    // Input and Button carry `touch:min-h-11` themselves; a bare <select>
    // does not, and px-3 py-2 lands around 38px.
    const dialog = plansRouteCode.slice(
      plansRouteCode.indexOf('id="new-plan-interval"'),
      plansRouteCode.indexOf('id="new-plan-sort"'),
    );
    expect(dialog).toMatch(/touch:min-h-11/);
  });
});
