import { test, expect, type Page } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import { FIRST_PAINT_MS } from "./fixtures/first-paint";

/**
 * #981: Settings → Scheduling had no Save button and saved its time and number
 * fields on blur. Change Workday end to 17:30 and reload without leaving the
 * field and the page came back at 17:00; nothing said it had not saved.
 *
 * The page now saves as the value is typed (a short pause), as the field is
 * left, and as the page unmounts, and says so in a status line. This records
 * every updateDispatchSettings write the page makes and checks the change
 * reaches it WITHOUT a blur, which is the whole of the bug.
 *
 * Runs with `npm run test:viewports:cases` (matched by
 * "a-workday-change-is-saved-without-leaving-the-field").
 */

const SIZES = [
  { w: 390, h: 844 },
  { w: 1440, h: 900 },
] as const;

async function open(page: Page, w: number, h: number, failWrites = false) {
  await page.setViewportSize({ width: w, height: h });
  await installSignedInSession(page);
  await installStubBackend(page);
  const writes: string[] = [];
  // Registered after the stub, so it sees the request first.
  await page.route("**/_serverFn/**", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/_serverFn/")[1] ?? "";
    let name = "";
    try {
      name = String(
        JSON.parse(Buffer.from(decodeURIComponent(id), "base64url").toString()).export ?? "",
      );
    } catch {
      /* not ours */
    }
    if (!name.startsWith("updateDispatchSettings")) return route.fallback();
    writes.push(route.request().postData() ?? "");
    if (failWrites) {
      return route.fulfill({ status: 500, contentType: "text/plain", body: "boom" });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ result: { ok: true } }),
    });
  });
  await page.goto("/settings/scheduling", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#sched-workday-end")).toBeVisible({ timeout: FIRST_PAINT_MS });
  return writes;
}

for (const { w, h } of SIZES) {
  test.describe(`#981 a scheduling change is saved without leaving the field, ${w}px`, () => {
    test(`workday end is written while the field still has focus @${w}px`, async ({ page }) => {
      const writes = await open(page, w, h);
      const end = page.locator("#sched-workday-end");
      await end.fill("17:30");
      await expect(end).toBeFocused();
      await expect.poll(() => writes.length, { timeout: 5_000 }).toBe(1);
      expect(writes[0]).toContain("workday_end");
      expect(writes[0]).toContain("17:30");
      await expect(page.getByTestId("scheduling-save-status")).toHaveText("All changes saved.");
      await expect(end).toBeFocused();
    });

    test(`a change followed straight by leaving the page is still written @${w}px`, async ({
      page,
    }) => {
      const writes = await open(page, w, h);
      await page.locator("#sched-workday-end").fill("17:30");
      // No pause, no blur: go to another Settings page the way a person does.
      await page.evaluate(() => {
        history.pushState({}, "", "/settings/business");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      await expect(page.locator("#sched-workday-end")).toHaveCount(0);
      await expect.poll(() => writes.length, { timeout: 5_000 }).toBe(1);
      expect(writes[0]).toContain("17:30");
    });

    test(`an unchanged or out-of-range value writes nothing @${w}px`, async ({ page }) => {
      const writes = await open(page, w, h);
      const days = page.locator("#sched-days-ahead");
      await days.fill("400");
      await days.blur();
      await expect(page.getByText("Choose between 1 and 365 days").first()).toBeVisible();
      await expect(days).toHaveValue("21"); // back to what is stored
      await page.locator("#sched-workday-start").focus();
      await page.locator("#sched-workday-start").blur();
      await page.waitForTimeout(1_000);
      expect(writes).toEqual([]);
    });

    test(`a refused save is said, not silent @${w}px`, async ({ page }) => {
      const writes = await open(page, w, h, true);
      await page.locator("#sched-workday-end").fill("17:30");
      await expect(page.getByTestId("scheduling-save-status")).toContainText("Not saved", {
        timeout: 5_000,
      });
      expect(writes.length).toBeGreaterThanOrEqual(1);
    });
  });
}
