// Two things the static tests cannot see, both found by iOS QA on a device.
//
// 1. THE STORE GATE. `saasPurchaseAllowed(platform())` is a runtime decision:
//    the source is identical on every platform, so a file-scanning test can
//    only check that a gate is WRITTEN, never that the gated thing actually
//    disappears. tests/the-app-store-would-have-seen-a-subscription.test.ts
//    does the first job well and caught the Cancel/Resume hole; this does the
//    second. Capacitor decides the platform from
//    `window.webkit.messageHandlers.bridge` (getPlatformId in @capacitor/core),
//    so providing that — and nothing else — makes getPlatform() answer "ios"
//    exactly as it does inside the binary. Replacing the whole Capacitor object
//    instead breaks its plugin proxies and renders an empty page, which every
//    negative assertion below would happily pass.
//
// 2. THE INVOICE CARDS. The client Billing tab rendered a six-column table
//    inside `w-full`, so it could never exceed its container and
//    `overflow-x-auto` never engaged: the columns compressed instead of
//    scrolling and the Total column clipped to a bare "$" on a 402pt iPhone.
//    Whether a column is READABLE is a question about rendered geometry, which
//    is why it survived a class-list test.
//
// Both assert only after real content is on screen. Every "X is not present"
// check passes on a spinner, so a test that does not first prove the page
// rendered is a test that proves nothing — the same trap the sweep specs
// document at length.
import { test, expect } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";

/** iPhone 17 Pro in points, the device the QA pass measured. */
const PHONE = { width: 402, height: 874 };
const CLIENT_DETAIL = "/clients/11111111-1111-4111-8111-000000000001";

test.use({ viewport: PHONE });

test("a store build offers no way to buy or change a HoundStack plan", async ({
  page,
  context,
}) => {
  await context.addInitScript(() => {
    const w = window as unknown as Record<string, any>;
    w.webkit = w.webkit ?? {};
    w.webkit.messageHandlers = w.webkit.messageHandlers ?? {};
    w.webkit.messageHandlers.bridge = { postMessage: () => {} };
  });
  await installStubBackend(context);
  await installSignedInSession(context);

  await page.goto("/settings/billing");
  // Proof of render before any absence is claimed.
  await expect(page.getByText("Current plan")).toBeVisible({ timeout: 20_000 });

  const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");

  // Kept: read-only account status. NOT "where to go instead" — naming the
  // destination is the steer 3.1.1 cares about, which is why the copy changed
  // on 2026-08-23 from "managed on the web at app.houndstack.com" to "managed
  // outside the mobile app".
  //
  // This assertion required the OLD phrase, so it was asserting the exact thing
  // the rule now forbids. It is the third copy of that mistake to be found —
  // the vitest file and the XCUITest carried it too — and the reason all three
  // survived is that each was written to pin the note's PRESENCE and happened
  // to pin its wording as a side effect.
  expect(body, "the note saying billing happens elsewhere is missing").toContain(
    "outside the mobile app",
  );
  expect(body, "the note names a destination").not.toContain("on the web");

  // Removed: every way to start or change a HoundStack purchase.
  for (const forbidden of [
    "Cancel subscription",
    "Resume subscription",
    "Payment methods",
    "Choose plan",
    "Switch to this plan",
    "Add to my plan",
  ]) {
    expect(body, `"${forbidden}" is reachable inside a store build`).not.toContain(forbidden);
  }

  // And no copy describing a switch that cannot happen here.
  expect(body, "plan-switching copy survives the gate").not.toContain("Switching is instant");
});

test("the hosted app still renders the invoice table at 402px", async ({ page, context }) => {
  // NOT an endorsement — a recorded decision.
  //
  // The client Billing tab renders a six-column table inside `w-full`, so it
  // can never exceed its container: `overflow-x-auto` never engages, the
  // columns compress, and iOS QA 2026-08-20 measured the Total column clipped
  // to a bare "$" and "$1," on a 402pt screen. The same fault is present on
  // mobile web.
  //
  // The fix — the same InvoiceCard the Invoices page already uses below `md` —
  // is gated to the native bundle, because `main` deploys straight to
  // app.houndstack.com and this pass was only ever about the phone (owner
  // decision, 2026-08-21, see src/lib/native-build.ts). This test exists so
  // that the WEB half stays put until someone decides otherwise, rather than
  // drifting on the next edit. When the PWA is developed, this is the test to
  // delete and the gate to remove.
  //
  // This sweep runs against the hosted build, where IS_NATIVE_BUNDLE folds to
  // false, so the card layout cannot be exercised here at all — the device
  // screenshot in docs/ios-qa-results.md is its evidence.
  await installStubBackend(context);
  await installSignedInSession(context);

  await page.goto(CLIENT_DETAIL);
  await page
    .getByRole("tab", { name: /billing/i })
    .first()
    .click();
  await expect(page.getByText("Payment methods")).toBeVisible({ timeout: 20_000 });

  expect(
    await page.locator("table:visible").count(),
    "the hosted app lost its invoice table — if that was deliberate, delete this test",
  ).toBeGreaterThan(0);
});

// PRE-EXISTING, AND NOT MINE TO FIX HERE.
//
// `CLAUDE.md` is unambiguous: "No horizontal page scroll, ever." The client
// Billing tab breaks it at phone widths on the HOSTED app — 603px of content in
// a 402px viewport, with `table.w-full` measured 582px wide inside a scroll
// container that grows to fit it instead of clipping it.
//
// Verified pre-existing, not a side effect of the iOS work: stashing the only
// change this pass made to billing-panels.tsx and re-measuring gives the same
// 603px and the same offender. The repo's own signed-in sweep misses it because
// it loads /clients/:id on the default Summary tab and never opens Billing.
//
// The native fix — InvoiceCard below `md` — removes the table and with it this
// overflow, but it is gated to the native bundle by owner decision (2026-08-21)
// because `main` deploys straight to app.houndstack.com. Fixing the web needs
// its own call: either ungate the cards, or give the scroll container a
// `min-w-0` chain so it actually clips.
//
// `fixme` rather than deletion: this is a standing failure the project has
// chosen not to fix yet, and it should keep saying so in every run.
test.fixme("the client billing tab does not scroll sideways at 402px", async ({
  page,
  context,
}) => {
  await installStubBackend(context);
  await installSignedInSession(context);
  await page.goto(CLIENT_DETAIL);
  await page
    .getByRole("tab", { name: /billing/i })
    .first()
    .click();
  await expect(page.getByText("Payment methods")).toBeVisible({ timeout: 20_000 });

  const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollW, "the client billing tab scrolls sideways at 402px").toBeLessThanOrEqual(
    PHONE.width + 1,
  );
});
