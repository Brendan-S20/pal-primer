import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { installSignedInSession } from "../tests/viewports/fixtures/session";
import { installStubBackend, type SweepRole } from "../tests/viewports/fixtures/stub-backend";
import { CLIENT_ID } from "../tests/viewports/fixtures/dataset";
import { findControlsOffTheSide, measurePageOverflow } from "../tests/viewports/rules";

const LINES = ["pet_waste", "dog_walking", "pet_sitting"];
const WIDTHS = [390, 820, 1024, 1440];
const OUT = "/opt/cursor/artifacts/sit-411";

function heightFor(width: number) {
  return width <= 390 ? 844 : 1100;
}

async function open(page: Page, role: SweepRole, path: string, width: number) {
  await page.setViewportSize({ width, height: heightFor(width) });
  await installSignedInSession(page);
  await installStubBackend(page, { role, serviceLines: LINES });
  const report = await page.goto(path, { waitUntil: "domcontentloaded" }).then(() => null);
  void report;
  await page.waitForLoadState("networkidle").catch(() => {});
}

async function shot(page: Page, name: string) {
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
}

async function assertFits(page: Page, where: string) {
  const health = await page.evaluate(() => ({
    overlay: Boolean(document.querySelector("vite-error-overlay")),
    boundary: document.body.innerText.includes("Something went wrong"),
    text: document.body.innerText.slice(0, 400),
  }));
  expect(health.overlay, `${where}: Vite error overlay. ${health.text}`).toBe(false);
  expect(health.boundary, `${where}: error boundary. ${health.text}`).toBe(false);
  const { scrollW, innerW } = await measurePageOverflow(page);
  expect(scrollW, `${where}: page scrolls sideways (${scrollW} > ${innerW})`).toBeLessThanOrEqual(
    innerW + 1,
  );
  expect(await findControlsOffTheSide(page), where).toEqual([]);
}

/** Monday 19 Oct 2026 through Friday 23 Oct 2026: five drop-in days. */
async function pickDate(page: Page, label: string, monthDay: string) {
  await page.getByLabel(label).click();
  const day = page.locator(`[data-day="${monthDay}"]`).last();
  await expect(day).toBeVisible({ timeout: 10_000 });
  await day.click();
}

test.describe("pet sitting screenshots", () => {
  test.beforeAll(() => mkdirSync(OUT, { recursive: true }));

  for (const width of WIDTHS) {
    test(`owner services, business, and a booked stay at ${width}`, async ({ page }) => {
      await open(page, "owner", "/settings/services", width);
      await expect(page.getByText("Overnight stay").first()).toBeVisible({ timeout: 30_000 });
      const houseSit = page.getByText("House sit").first();
      await expect(houseSit).toBeVisible();
      await expect(page.getByText("Drop-in (30 min)").first()).toBeVisible();
      await assertFits(page, `services ${width}`);
      await houseSit.scrollIntoViewIfNeeded();
      await shot(page, `services-${width}`);

      if (width === 390 || width === 1440) {
        const row = page.locator("li").filter({ hasText: "Overnight stay" });
        await row.getByRole("button", { name: "Edit" }).click();
        await expect(page.getByLabel("Holiday surcharge (%)")).toBeVisible();
        await expect(page.getByPlaceholder("Optional")).toBeVisible();
        await shot(page, `service-edit-overnight-${width}`);
        await page.keyboard.press("Escape");
        await expect(page.getByLabel("Holiday surcharge (%)")).toBeHidden();
      }

      await open(page, "owner", "/settings/business", width);
      const sitting = page.getByRole("checkbox", { name: /^Pet sitting/ });
      await expect(sitting).toBeChecked({ timeout: 30_000 });
      await expect(
        page.locator("li").filter({ has: sitting }).getByText("Coming soon"),
      ).toHaveCount(0);
      await assertFits(page, `business ${width}`);
      await shot(page, `business-${width}`);

      await open(page, "owner", `/clients/${CLIENT_ID}?tab=services`, width);
      const stays = page.locator("#stays-heading");
      await expect(stays).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText("10 visits")).toBeVisible();
      await expect(page.getByText("Miso (Cat)")).toBeVisible();
      await expect(page.getByRole("button", { name: "Book a stay" })).toBeVisible();
      await assertFits(page, `stays ${width}`);
      await stays.scrollIntoViewIfNeeded();
      await shot(page, `stays-${width}`);

      if (width === 390 || width === 1440) {
        await page.getByRole("button", { name: "Book a stay" }).click();
        await expect(page.getByRole("heading", { name: "Book a stay" })).toBeVisible();
        await page.locator("#stay-service").selectOption({ label: "Drop-in (30 min)" });
        await pickDate(page, "First day", "10/19/2026");
        await pickDate(page, "Last day", "10/23/2026");
        const count = page.getByText("This creates 5 visits.");
        await expect(count).toBeVisible();
        await expect(page.getByText("Miso (Cat)", { exact: true })).toBeVisible();
        await page.locator("#stay-sitter").selectOption({ label: "Alejandro Villanueva-Castro" });
        await count.scrollIntoViewIfNeeded();
        await shot(page, `book-stay-${width}`);
      }
    });

    test(`sitter day at ${width}`, async ({ page }) => {
      await open(page, "tech", "/my-day", width);
      await expect(page.getByText("Visit 3 of 10")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText("Miso").first()).toBeVisible();
      await expect(page.getByText("Apoquel").first()).toBeVisible();
      await expect(page.getByText("Fed").first()).toBeVisible();
      await assertFits(page, `my-day ${width}`);
      await page.getByText("Visit 3 of 10").scrollIntoViewIfNeeded();
      await shot(page, `my-day-${width}`);
    });
  }
});
