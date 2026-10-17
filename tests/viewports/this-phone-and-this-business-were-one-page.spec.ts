/**
 * Four changes from the launch pass, measured in a browser at the widths
 * CLAUDE.md names and at the iPad sizes with touch on.
 *
 *  - Settings → Preferences held two kinds of switch: this device (language,
 *    haptics, keep-awake, the phone menu) and the whole business (time zone,
 *    standard pricing, commercial accounts, completion rules, re-clean
 *    guarantee). Preferences is now the device, with a light/dark/system
 *    choice added; Business defaults is the business, and a technician is
 *    never offered it.
 *  - The weekly digest's settings moved from an Analytics tab to
 *    Settings → Emails.
 *  - The trial and billing banners are not drawn for a technician.
 *  - The customer portal's header is the business's name and logo on every
 *    tab, and the long hero only on Home.
 */
import { test, expect, type Page } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend, type SweepRole } from "./fixtures/stub-backend";
import { FIRST_PAINT_MS } from "./fixtures/first-paint";
import {
  PORTAL_SLUG,
  PORTAL_TOKEN,
  PORTAL_ORG_NAME,
  PORTAL_CLIENT_NAME,
} from "./fixtures/portal-dataset";
import { measurePageOverflow, findControlsOffTheSide, findControlsUnder44px } from "./rules";

const WIDTHS = [
  { w: 320, h: 568, label: "320 · the narrowest iPhone" },
  { w: 360, h: 780, label: "360 · a real phone" },
  { w: 768, h: 1024, label: "768 · tablet portrait" },
  { w: 1280, h: 800, label: "1280 · small laptop" },
  { w: 1920, h: 1080, label: "1920 · wide monitor" },
];
const IPADS = [
  { w: 744, h: 1133, label: "744×1133 · iPad mini portrait" },
  { w: 820, h: 1180, label: "820×1180 · iPad Air portrait" },
  { w: 1024, h: 1366, label: "1024×1366 · iPad Pro portrait" },
  { w: 1366, h: 1024, label: "1366×1024 · iPad Pro landscape" },
];

async function signIn(page: Page, role: SweepRole = "owner") {
  await installSignedInSession(page);
  await installStubBackend(page, { role });
}

async function holdsTogether(page: Page, label: string, touch: boolean) {
  await page.waitForTimeout(500);
  const { scrollW, innerW } = await measurePageOverflow(page);
  expect(scrollW, `${label}: the page scrolls sideways`).toBeLessThanOrEqual(innerW + 1);
  expect(await findControlsOffTheSide(page), `${label}: controls off the side`).toEqual([]);
  if (touch) {
    expect(await findControlsUnder44px(page), `${label}: controls under 44px on touch`).toEqual([]);
  }
}

const BUSINESS_CARDS = [
  "Time zone",
  "Commercial accounts",
  "Re-clean guarantee",
  "Finishing a visit",
];

async function checkPreferences(page: Page, label: string, touch: boolean) {
  await signIn(page);
  await page.goto("/settings/preferences", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Appearance", { exact: true }).first()).toBeVisible({
    timeout: FIRST_PAINT_MS,
  });
  await expect(page.getByText("Interface language").first()).toBeVisible();
  for (const card of BUSINESS_CARDS) {
    await expect(
      page.getByText(card, { exact: true }),
      `${label}: "${card}" is still on Preferences`,
    ).toHaveCount(0);
  }
  await holdsTogether(page, `preferences ${label}`, touch);
}

async function checkBusiness(page: Page, label: string, touch: boolean) {
  await signIn(page);
  await page.goto("/settings/business", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Business defaults" })).toBeVisible({
    timeout: FIRST_PAINT_MS,
  });
  for (const card of BUSINESS_CARDS) {
    await expect(
      page.getByText(card, { exact: true }).first(),
      `${label}: no "${card}"`,
    ).toBeVisible();
  }
  // And nothing that belongs to the device came with them.
  await expect(page.getByText("Interface language")).toHaveCount(0);
  await holdsTogether(page, `business defaults ${label}`, touch);
}

test.describe("preferences and business defaults, by width", () => {
  for (const s of WIDTHS) {
    test(`preferences @ ${s.label}`, async ({ page }) => {
      await page.setViewportSize({ width: s.w, height: s.h });
      await checkPreferences(page, s.label, s.w < 768);
    });
    test(`business defaults @ ${s.label}`, async ({ page }) => {
      await page.setViewportSize({ width: s.w, height: s.h });
      await checkBusiness(page, s.label, false);
    });
  }
});

test.describe("preferences and business defaults on an iPad, with touch", () => {
  test.use({ hasTouch: true });
  for (const s of IPADS) {
    test(`preferences @ ${s.label}`, async ({ page }) => {
      await page.setViewportSize({ width: s.w, height: s.h });
      await checkPreferences(page, s.label, true);
    });
    test(`business defaults @ ${s.label}`, async ({ page }) => {
      await page.setViewportSize({ width: s.w, height: s.h });
      await checkBusiness(page, s.label, false);
    });
  }
});

test.describe("a technician", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("reaches their device's preferences and no business settings at all", async ({ page }) => {
    await signIn(page, "tech");
    await page.goto("/settings/preferences", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Interface language").first()).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    for (const card of BUSINESS_CARDS)
      await expect(page.getByText(card, { exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Business defaults" })).toHaveCount(0);

    // Asked for directly, it is refused to a page the tech can use.
    await page.goto("/settings/business", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/my-day/, { timeout: FIRST_PAINT_MS });
  });

  test("is not shown the trial banner, which an owner still is", async ({ page }) => {
    // The stub's trial is expired, so the banner draws for anyone it is
    // meant for. Owner first, so a pass for the tech is not a blank page.
    await signIn(page, "owner");
    await page.goto("/my-day", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Your free trial has ended").first()).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });

    const tech = await page
      .context()
      .browser()!
      .newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
    const techPage = await tech.newPage();
    await signIn(techPage, "tech");
    await techPage.goto("/my-day", { waitUntil: "domcontentloaded" });
    await expect(techPage.getByRole("heading", { name: "My day" }).first()).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    await techPage.waitForTimeout(1500);
    await expect(techPage.getByText("Your free trial has ended")).toHaveCount(0);
    await expect(techPage.getByText(/Ask an owner/)).toHaveCount(0);
    await tech.close();
  });
});

test.describe("light, dark, or the device's own setting", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("dark is applied at once and survives a reload", async ({ page }) => {
    await signIn(page);
    await page.goto("/settings/preferences", { waitUntil: "domcontentloaded" });
    const isDark = () => page.evaluate(() => document.documentElement.classList.contains("dark"));
    await expect(page.getByText("Appearance", { exact: true }).first()).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    // The default is light: nobody's app changes until they choose.
    expect(await isDark()).toBe(false);
    await page.locator('[data-theme-choice="dark"]').click();
    expect(await isDark()).toBe(true);
    await expect(page.locator('[data-theme-choice="dark"]')).toHaveAttribute(
      "aria-checked",
      "true",
    );
    // The body really changed colour, not just a class: the palette exists.
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.reload({ waitUntil: "domcontentloaded" });
    // Applied before React, by the boot script, so it is already dark here.
    expect(await isDark()).toBe(true);
    await page.locator('[data-theme-choice="light"]').click();
    expect(await isDark()).toBe(false);
    const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(lightBg, "dark and light drew the same background").not.toBe(bg);
  });

  test("system follows the device", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await signIn(page);
    await page.addInitScript(() => window.localStorage.setItem("scoop:theme", "system"));
    await page.goto("/settings/preferences", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Appearance", { exact: true }).first()).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    expect(await page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(
      true,
    );
    await page.emulateMedia({ colorScheme: "light" });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.classList.contains("dark")))
      .toBe(false);
  });
});

test.describe("the weekly digest is an email setting", () => {
  for (const s of [WIDTHS[1], WIDTHS[3]]) {
    test(`on Settings → Emails @ ${s.label}`, async ({ page }) => {
      await page.setViewportSize({ width: s.w, height: s.h });
      await signIn(page);
      await page.goto("/settings/emails", { waitUntil: "domcontentloaded" });
      await expect(page.getByText("Weekly digest to you").first()).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
      await expect(page.getByLabel("Send to")).toHaveValue(
        /whitfield-ramirez-yard-and-waste-services/,
      );
      await holdsTogether(page, `emails ${s.label}`, s.w < 768);
    });
  }

  test("and is no longer a tab on Analytics", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await signIn(page);
    await page.goto("/analytics", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("tab", { name: "Advisor" })).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    await expect(page.getByRole("tab", { name: "Weekly digest" })).toHaveCount(0);
  });
});

const PORTAL = `/portal/${PORTAL_SLUG}/${PORTAL_TOKEN}`;

async function portalHeader(page: Page) {
  return page.evaluate(() => {
    const h = document.querySelector<HTMLElement>('[data-testid="portal-header"]');
    if (!h) return null;
    return {
      height: Math.round(h.getBoundingClientRect().height),
      h1: h.querySelector("h1")?.textContent?.trim() ?? "",
    };
  });
}

test.describe("the portal header says who it is from", () => {
  for (const s of [...WIDTHS.slice(0, 4), ...IPADS]) {
    const touch = IPADS.includes(s);
    test(`@ ${s.label}`, async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: s.w, height: s.h },
        isMobile: s.w < 768,
        hasTouch: touch || s.w < 768,
      });
      const page = await context.newPage();
      await installStubBackend(page, { portal: true });

      // Home: the business's name as the heading, the greeting, and one
      // sentence of what this page is for.
      await page.goto(PORTAL, { waitUntil: "domcontentloaded" });
      await expect(page.getByText(PORTAL_CLIENT_NAME).first()).toBeVisible({ timeout: 30_000 });
      const home = await portalHeader(page);
      expect(home?.h1).toBe(PORTAL_ORG_NAME);
      await expect(page.getByText(/check your next visit, pay invoices/)).toBeVisible();
      await expect(page).toHaveTitle(`Home · ${PORTAL_ORG_NAME}`);
      await holdsTogether(page, `portal home ${s.label}`, touch || s.w < 768);

      // Another tab: the same name, and no hero. On a phone the header used
      // to be ~280px on every tab. The cap is 160px, not tighter: the name
      // wraps instead of truncating, and on narrow phones the bell drops
      // below it (about 144px at 320, 121px at 360).
      await page.goto(`${PORTAL}/visits`, { waitUntil: "domcontentloaded" });
      await expect(page.getByText(PORTAL_CLIENT_NAME).first()).toBeVisible({ timeout: 30_000 });
      const visits = await portalHeader(page);
      expect(visits?.h1).toBe(PORTAL_ORG_NAME);
      expect(
        visits!.height,
        `${s.label}: the header is ${visits!.height}px on Visits`,
      ).toBeLessThanOrEqual(160);
      await expect(page.getByText(/check your next visit, pay invoices/)).toHaveCount(0);
      await expect(page).toHaveTitle(`Visits · ${PORTAL_ORG_NAME}`);
      await expect(page).not.toHaveTitle(/HoundStack/);
      await holdsTogether(page, `portal visits ${s.label}`, touch || s.w < 768);
      await context.close();
    });
  }
});
