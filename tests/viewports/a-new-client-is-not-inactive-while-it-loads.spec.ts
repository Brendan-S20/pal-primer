import { test, expect, type Page } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import { CLIENT_ID } from "./fixtures/dataset";
import { measurePageOverflow, findControlsOffTheSide, findSilentlyClippedText } from "./rules";
import { FIRST_PAINT_MS } from "./fixtures/first-paint";

/**
 * #984: right after Create, the client page said Inactive, 0 properties and
 * 0 active services, then corrected itself a moment later. The page waited for
 * the client row only; the properties and subscriptions arrived after, and the
 * header drew its status and counts from the empty lists in between, which
 * reads as a save that lost everything.
 *
 * This holds the properties and subscriptions back, reads the header while
 * they are in flight, and requires no "Inactive" and no "0" to be drawn, only
 * a loading placeholder; then releases them and requires the settled values.
 * Runs with `npm run test:viewports:cases` (matched by
 * "a-new-client-is-not-inactive-while-it-loads").
 */

const SIZES = [
  { w: 390, h: 844 },
  { w: 1440, h: 900 },
] as const;

async function open(page: Page, w: number, h: number) {
  await page.setViewportSize({ width: w, height: h });
  await installSignedInSession(page);
  await installStubBackend(page);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
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
    if (/^(listPropertiesForClient|listSubscriptionsForClient)/.test(name)) await gate;
    return route.fallback();
  });
  await page.goto(`/clients/${CLIENT_ID}`, { waitUntil: "domcontentloaded" });
  return release;
}

for (const { w, h } of SIZES) {
  test(`#984 the header draws no Inactive and no zero counts while the client's properties and services load @${w}px`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const release = await open(page, w, h);
    const dl = page.locator("dl", { hasText: "Active services" }).first();
    await expect(dl).toBeVisible({ timeout: FIRST_PAINT_MS });
    // In flight: placeholders, not an answer.
    await expect(page.locator("[data-client-status-loading]")).toBeVisible();
    await expect(page.getByText("Inactive", { exact: true })).toHaveCount(0);
    await expect(dl.getByLabel("Loading")).toHaveCount(2);
    await expect(dl.locator("dd").nth(0)).not.toHaveText("0");
    await expect(dl.locator("dd").nth(1)).not.toHaveText("0");
    const { scrollW, innerW } = await measurePageOverflow(page);
    expect(scrollW, "loading header scrolls sideways").toBeLessThanOrEqual(innerW + 1);
    expect(await findControlsOffTheSide(page)).toEqual([]);
    expect(await findSilentlyClippedText(page)).toEqual([]);

    release();
    // Settled: the real status and counts.
    await expect(page.getByText("Active", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("[data-client-status-loading]")).toHaveCount(0);
    await expect(dl.getByLabel("Loading")).toHaveCount(0);
    await expect(dl.locator("div", { hasText: "Properties" }).first()).toContainText("2");
    await expect(dl.locator("div", { hasText: "Active services" }).first()).toContainText("1");
    await expect(page.getByText("Inactive", { exact: true })).toHaveCount(0);
  });
}
