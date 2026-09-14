// Preferences had become the page for everything that had nowhere else.
//
// Eight cards, 3,961px tall on a 430pt phone: Language, Field tech app, Time
// zone, Portal sign-in address, Menus and top bar, Client portal branding &
// policy, Demo data, Commercial accounts. Under a heading that describes about
// half of them.
//
// The owner's own rule, given about Profile, applies in both directions: a
// control that is a preference belongs under Preferences, and one that is not
// does not. A sign-in address a CUSTOMER types and a brand colour a CUSTOMER
// sees are not preferences.
//
// So they moved to a Client portal page in the Customer-facing group, which is
// the group that exists for exactly this. This asserts the outcome — the page
// got materially shorter and the settings are reachable where they now live —
// rather than the file layout, which is an implementation detail.
import { test, expect } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import { FIRST_PAINT_MS } from "./fixtures/first-paint";

const PHONE = { width: 430, height: 932 };

test.describe("preferences is preferences again", () => {
  test.use({ viewport: PHONE, isMobile: true, deviceScaleFactor: 2 });

  test("the page is no longer four screens of unrelated settings", async ({ page }) => {
    await installSignedInSession(page);
    await installStubBackend(page);
    await page.goto("/settings/preferences", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    await page.waitForTimeout(800);

    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    // It was 3,961. This is not a target so much as a ceiling: if it creeps
    // back past three screens, something has been dropped here again because
    // there was nowhere obvious to put it.
    expect(height, `preferences is ${height}px tall, back to a dumping ground`).toBeLessThan(2800);
  });

  test("and the portal settings are reachable where they now live", async ({ page }) => {
    // Moving something out of a page is only an improvement if it landed
    // somewhere a person can get to.
    await installSignedInSession(page);
    await installStubBackend(page);
    await page.goto("/settings/client-portal", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Portal sign-in address").first()).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(page.getByText("Client portal branding & policy").first()).toBeVisible();
    // The business name lives on that card and is the one field with a
    // validator behind it; if the card moved without its state it would render
    // and do nothing.
    await expect(page.getByText("Business name").first()).toBeVisible();
  });

  test("the settings nav offers it", async ({ page }) => {
    await installSignedInSession(page);
    await installStubBackend(page);
    await page.goto("/settings/preferences", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    // Below md the nav is a sheet behind a switcher, so open it first.
    const switcher = page.getByRole("button", { name: /Preferences|Choose a section/ }).first();
    if (await switcher.isVisible().catch(() => false)) await switcher.click();
    await expect(page.getByRole("link", { name: "Client portal" }).first()).toBeVisible({
      timeout: 10_000,
    });
  });
});
