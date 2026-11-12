/**
 * A dispatcher manages an existing client's plans at the set price (#728),
 * in a real browser, at 360 / 768 / 1280 / 1920.
 *
 * The handler tests (tests/a-dispatcher-manages-plans-at-the-set-price.test.ts)
 * prove what the server allows. This proves the client's Services tab says the
 * same thing:
 *
 *   * A dispatcher sees Add Service, Pause and End service… on a client who
 *     already exists. Add Service opens "Add plan": the set price as text, no
 *     box to type a price into, and Add plan sends exactly that price, billed
 *     after each visit. Pause sends pauseSubscription. Edit, which can change
 *     a price, is not on the card.
 *   * The owner, for contrast, gets Edit, and Add Service opens the full
 *     "Add service" form with its price box. Same locators, opposite answers,
 *     so a role that stopped reaching the page turns one run red.
 *
 * Runs with `npm run test:viewports:cases`. Locally:
 *     npx playwright test a-dispatcher-manages-plans-at-the-set-price --workers=2
 */
import { test, expect, type Page } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend, type SweepRole, type Stub } from "./fixtures/stub-backend";
import * as fx from "./fixtures/dataset";
import { FIRST_PAINT_MS } from "./fixtures/first-paint";
import {
  WIDTHS,
  measurePageOverflow,
  findControlsOffTheSide,
  findSilentlyClippedText,
  findControlsUnder44px,
} from "./rules";

const ZONE_ID = "eeeeeeee-0000-4000-8000-00000000e728";
/** The set price the server answers: the same $24.00 the client's existing
 *  weekly, 2-dog plan is at (stub-backend's listSubscriptionsForClient), so the
 *  card shows one number for one plan, as a real business at its set price
 *  would. That it came from getPlanSetPrice, not from the card, is proved by
 *  the recorded call below. */
const SET_PRICE = { cents: 2400, zoneId: ZONE_ID, reason: null, accountType: "residential" };
const SET_PRICE_TEXT = "$24.00";

type Calls = Array<{ name: string; args: Record<string, any> }>;

async function signIn(page: Page, role: SweepRole): Promise<Calls> {
  const calls: Calls = [];
  const record =
    (name: string, reply: unknown): Stub =>
    (args) => {
      calls.push({ name, args });
      return reply;
    };
  await installSignedInSession(page.context());
  await installStubBackend(page.context(), {
    role,
    overrides: {
      getPlanSetPrice: record("getPlanSetPrice", SET_PRICE),
      createSubscription: record("createSubscription", {
        id: "ffffffff-0000-4000-8000-000000000728",
      }),
      pauseSubscription: record("pauseSubscription", { ok: true }),
      updateSubscription: record("updateSubscription", { ok: true }),
    },
  });
  return calls;
}

async function measure(page: Page, width: number, where: string) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(300);
  const health = await page.evaluate(() => ({
    overlay: Boolean(document.querySelector("vite-error-overlay")),
    boundary: document.body.innerText.includes("Something went wrong"),
    auth: location.pathname === "/auth",
  }));
  expect(health.overlay, `${where}: Vite error overlay`).toBe(false);
  expect(health.boundary, `${where}: the router's error boundary, not the page`).toBe(false);
  expect(health.auth, `${where}: signed out`).toBe(false);
  const { scrollW, innerW } = await measurePageOverflow(page);
  expect(scrollW, `${where}: the page scrolls sideways`).toBeLessThanOrEqual(innerW + 1);
  expect(await findControlsOffTheSide(page), where).toEqual([]);
  expect(await findSilentlyClippedText(page), where).toEqual([]);
  if (width < 768) expect(await findControlsUnder44px(page), where).toEqual([]);
}

/** The Services tab, proved to be the Services tab: the plan card's own
 *  price, which only that tab draws. */
async function openServices(page: Page) {
  await page.goto(`/clients/${fx.CLIENT_ID}?tab=services`, { waitUntil: "domcontentloaded" });
  const tab = page.getByRole("tab", { name: "Services", exact: true }).first();
  await expect(tab).toBeVisible({ timeout: FIRST_PAINT_MS });
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
  await expect(page.getByRole("button", { name: "Add Service" })).toBeVisible({
    timeout: 30_000,
  });
}

for (const { w, h, label } of WIDTHS) {
  test.describe(`a dispatcher at ${label}`, () => {
    test.use({ viewport: { width: w, height: h }, isMobile: w < 768, hasTouch: w < 768 });

    test(`Services tab: add at the set price, pause, no Edit @${w}px`, async ({ page }) => {
      test.setTimeout(180_000);
      const calls = await signIn(page, "dispatcher");
      await openServices(page);
      await expect(page.getByRole("button", { name: "Pause" }).first()).toBeVisible();
      await expect(page.getByRole("button", { name: "End service…" }).first()).toBeVisible();
      await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
      await measure(page, w, `Services tab (dispatcher) @${w}px`);

      await page.getByRole("button", { name: "Add Service" }).click();
      const dialog = page.getByRole("dialog").first();
      await expect(dialog.getByText("Add plan").first()).toBeVisible();
      await dialog.locator("#psp-property").selectOption(fx.PROPERTY_ID);
      const price = dialog.getByTestId("plan-set-price");
      await expect(price).toContainText(SET_PRICE_TEXT, { timeout: 30_000 });
      // Worked out by the server for this property, weekly, at the dogs the
      // property has on file (2 in the fixture), not read off the card.
      expect(calls.filter((c) => c.name === "getPlanSetPrice").at(-1)!.args).toMatchObject({
        clientId: fx.CLIENT_ID,
        propertyId: fx.PROPERTY_ID,
        frequency: "weekly",
        dogCount: 2,
      });
      // The price is shown, never typed: no price box, no prepaid.
      await expect(dialog.getByLabel(/price/i)).toHaveCount(0);
      await expect(dialog.getByText(/prepaid/i)).toHaveCount(0);
      await measure(page, w, `Add plan (dispatcher) @${w}px`);

      await dialog.getByRole("button", { name: "Add plan" }).click();
      await expect.poll(() => calls.filter((c) => c.name === "createSubscription").length).toBe(1);
      expect(calls.find((c) => c.name === "createSubscription")!.args).toMatchObject({
        clientId: fx.CLIENT_ID,
        propertyId: fx.PROPERTY_ID,
        priceCents: SET_PRICE.cents,
        zoneId: ZONE_ID,
        billingCadence: "postpaid",
      });

      await page.getByRole("button", { name: "Pause" }).first().click();
      await expect.poll(() => calls.filter((c) => c.name === "pauseSubscription").length).toBe(1);
      expect(calls.map((c) => c.name)).not.toContain("updateSubscription");
    });
  });
}

// ── The owner, for contrast ───────────────────────────────────────────────
for (const { w, h, label } of WIDTHS) {
  test.describe(`an owner at ${label}`, () => {
    test.use({ viewport: { width: w, height: h }, isMobile: w < 768, hasTouch: w < 768 });

    test(`Services tab keeps Edit and the full Add service form @${w}px`, async ({ page }) => {
      test.setTimeout(180_000);
      const calls = await signIn(page, "owner");
      await openServices(page);
      await expect(page.getByRole("button", { name: "Edit", exact: true }).first()).toBeVisible();
      await measure(page, w, `Services tab (owner) @${w}px`);
      // The owner's full form is not measured here: its preferred-day chips
      // are under 44px at phone widths on main already, a fault of that form
      // and not of this change (listed as a follow-up on the PR).
      await page.getByRole("button", { name: "Add Service" }).click();
      const dialog = page.getByRole("dialog").first();
      await expect(dialog.getByText("Add service").first()).toBeVisible();
      await expect(dialog.getByTestId("plan-set-price")).toHaveCount(0);
      expect(calls.map((c) => c.name)).not.toContain("getPlanSetPrice");
    });
  });
}
