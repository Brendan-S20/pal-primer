/**
 * What the browser tab says, read from a real browser, and the Schedule page's
 * heading at every width it has to survive.
 *
 * ── THE TAB ───────────────────────────────────────────────────────────────
 *
 * About forty pages were titled "HoundStack - Field Service App" (launch pass,
 * 2026-10, recommendation 2). tests/every-tab-was-called-houndstack.test.ts
 * holds every route file to a `head` title; this proves the browser agrees,
 * including the two cases a source scan cannot see: a title that waits for
 * data (a client's name) and one that waits for the device's language (a
 * technician who reads Spanish).
 *
 * ── THE HEADING ───────────────────────────────────────────────────────────
 *
 * Everything else calls /routes "Schedule"; its own h1 said "Today ▾"
 * because the heading doubled as the date picker (recommendation 3). The
 * date is now a button beside an h1 that says Schedule. A heading row that
 * gained a control is a row that can now push something off a 320px phone,
 * so it is measured at the widths CLAUDE.md names and at the iPad sizes with
 * touch on, where the button has to be a 44px target.
 */
import { test, expect, type Page } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend, type SweepRole } from "./fixtures/stub-backend";
import { FIRST_PAINT_MS } from "./fixtures/first-paint";
import { CLIENT_ID, REFUND_INVOICE_ID } from "./fixtures/dataset";
import { measurePageOverflow } from "./rules";

async function signIn(page: Page, role: SweepRole = "owner", lang?: "es") {
  await installSignedInSession(page);
  await installStubBackend(page, { role });
  if (lang) {
    await page.addInitScript((l) => {
      try {
        window.localStorage.setItem("scoop.lang", l);
      } catch {
        /* the page reads its default */
      }
    }, lang);
  }
}

test.describe("the tab says which page it is", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  for (const { path, title, proof } of [
    { path: "/routes", title: "Schedule · HoundStack", proof: "Schedule" },
    { path: "/clients", title: "Clients · HoundStack", proof: "Clients" },
    { path: "/invoices", title: "Invoices · HoundStack", proof: "Invoices" },
    { path: "/settings/users", title: "Users & roles · Settings · HoundStack", proof: "Settings" },
  ]) {
    test(path, async ({ page }) => {
      await signIn(page);
      await page.goto(path, { waitUntil: "domcontentloaded" });
      // Proved rendering first: the root default is a title too, and a page
      // that never painted would still have one.
      await expect(page.getByRole("heading", { name: proof }).first()).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
      await expect(page).toHaveTitle(title);
    });
  }

  test("a client's page is named after the client once it loads", async ({ page }) => {
    await signIn(page);
    await page.goto(`/clients/${CLIENT_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page).toHaveTitle("Anastasia Vandermolen-Whitaker · Clients · HoundStack", {
      timeout: FIRST_PAINT_MS,
    });
  });

  test("an invoice's page is named after its number", async ({ page }) => {
    await signIn(page);
    await page.goto(`/invoices/${REFUND_INVOICE_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page).toHaveTitle(/^INV-\S+ · Invoices · HoundStack$/, { timeout: FIRST_PAINT_MS });
  });

  test("a technician who reads Spanish reads Spanish in the tab too", async ({ page }) => {
    await signIn(page, "tech", "es");
    await page.goto("/my-day", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Mi día" }).first()).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    await expect(page).toHaveTitle("Mi día · HoundStack");
  });

  test("leaving a named page does not leave its name behind", async ({ page }) => {
    // useDocumentTitle restores nothing on unmount, on the premise that the
    // next route's head replaces it. This is that premise, checked.
    await signIn(page);
    await page.goto(`/clients/${CLIENT_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page).toHaveTitle(/Anastasia/, { timeout: FIRST_PAINT_MS });
    await page.getByRole("link", { name: /Clients/ }).first().click();
    await expect(page).toHaveTitle("Clients · HoundStack");
  });
});

/** Where the heading row is, and whether anything in it left the screen. */
async function headingRow(page: Page) {
  return page.evaluate(() => {
    const h1 = [...document.querySelectorAll("h1")].find((h) => h.textContent?.trim() === "Schedule");
    const btn = document.querySelector<HTMLElement>('[data-testid="schedule-date"]');
    if (!h1 || !btn) return null;
    const vw = document.documentElement.clientWidth;
    const b = btn.getBoundingClientRect();
    const h = h1.getBoundingClientRect();
    return {
      h1Text: h1.textContent?.trim(),
      buttonText: btn.textContent?.trim() ?? "",
      buttonHeight: Math.round(b.height),
      offSide: b.right > vw + 1 || h.right > vw + 1 || b.left < -1,
    };
  });
}

const PHONE_AND_DESKTOP = [
  { w: 320, h: 568, label: "320 · the narrowest iPhone" },
  { w: 360, h: 780, label: "360 · a real phone" },
  { w: 768, h: 1024, label: "768 · tablet portrait" },
  { w: 1280, h: 800, label: "1280 · small laptop" },
  { w: 1920, h: 1080, label: "1920 · wide monitor" },
];

const IPADS_WITH_TOUCH = [
  { w: 744, h: 1133, label: "744×1133 · iPad mini portrait" },
  { w: 820, h: 1180, label: "820×1180 · iPad Air portrait" },
  { w: 1024, h: 1366, label: "1024×1366 · iPad Pro portrait" },
  { w: 1366, h: 1024, label: "1366×1024 · iPad Pro landscape" },
];

async function checkHeading(page: Page, touch: boolean, label: string) {
  await signIn(page);
  await page.addInitScript(() => {
    window.localStorage.setItem("routes.viewMode", "board");
    window.localStorage.setItem("routes.range", "today");
  });
  await page.goto("/routes", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Schedule", exact: true })).toBeVisible({
    timeout: FIRST_PAINT_MS,
  });
  await expect(page.getByRole("button", { name: "Auto-routing" })).toBeVisible();
  const row = await headingRow(page);
  expect(row, `${label}: no Schedule heading with a date button beside it`).not.toBeNull();
  expect(row!.h1Text).toBe("Schedule");
  // The date is still on screen, and still a date: "Today" on today.
  expect(row!.buttonText, label).toMatch(/Today|\d/);
  expect(row!.offSide, `${label}: the heading row runs off the side`).toBe(false);
  if (touch) {
    expect(row!.buttonHeight, `${label}: the date button is under 44px on a touchscreen`).toBeGreaterThanOrEqual(44);
  }
  const { scrollW, innerW } = await measurePageOverflow(page);
  expect(scrollW, `${label}: the page scrolls sideways`).toBeLessThanOrEqual(innerW + 1);

  // The button still opens the calendar, which is the whole of what it did
  // when it was the heading.
  await page.getByTestId("schedule-date").click();
  await expect(page.getByRole("grid").first()).toBeVisible();
}

test.describe("the Schedule heading, by width", () => {
  for (const s of PHONE_AND_DESKTOP) {
    test(s.label, async ({ page }) => {
      await page.setViewportSize({ width: s.w, height: s.h });
      await checkHeading(page, false, s.label);
    });
  }
});

test.describe("the Schedule heading on an iPad, with touch", () => {
  test.use({ hasTouch: true });
  for (const s of IPADS_WITH_TOUCH) {
    test(s.label, async ({ page }) => {
      await page.setViewportSize({ width: s.w, height: s.h });
      await checkHeading(page, true, s.label);
    });
  }
});
