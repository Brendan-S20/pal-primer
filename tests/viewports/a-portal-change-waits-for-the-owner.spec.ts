// A portal change waits for the owner, when the owner says so (#730, D6),
// at the four widths, with touch on below desktop.
//
// The sweeps already lay out /concerns, /settings/client-portal and the
// portal's visits page, but a sweep proves a page rendered, not that THIS
// change's pieces were on it. Each case here proves its piece first, with a
// string only the #730 fixtures contain, then measures:
//
//   * the owner's queue on the Requests page: the late reschedule with the fee
//     the client accepted, Approve and Deny;
//   * the owner's setting: both choices, one block per service line, the
//     auto-charge switch;
//   * the customer: a request waiting for approval (badge and Withdraw in
//     place of the buttons), and a late skip whose confirm button stays off
//     until the fee shown is accepted.
import { test, expect, type Page } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import { FIRST_PAINT_MS } from "./fixtures/first-paint";
import { PORTAL_SLUG, PORTAL_TOKEN, PORTAL_CLIENT_NAME } from "./fixtures/portal-dataset";
import {
  WIDTHS,
  measurePageOverflow,
  findControlsOffTheSide,
  findSilentlyClippedText,
  findControlsUnder44px,
} from "./rules";

async function measure(page: Page, label: string, touch: boolean) {
  await page.waitForTimeout(500);
  const { scrollW, innerW } = await measurePageOverflow(page);
  expect(scrollW, `${label}: scrolls sideways`).toBeLessThanOrEqual(innerW + 1);
  expect(await findControlsOffTheSide(page), label).toEqual([]);
  expect(await findSilentlyClippedText(page), label).toEqual([]);
  if (touch) expect(await findControlsUnder44px(page), label).toEqual([]);
}

for (const { w, h, label } of WIDTHS) {
  const touch = w < 1280;
  test.describe(`${label}`, () => {
    test.use({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: w < 768 });

    test("the owner's queue on the Requests page", async ({ page }) => {
      await installSignedInSession(page);
      await installStubBackend(page);
      await page.goto("/concerns", { waitUntil: "domcontentloaded" });
      const heading = page.getByRole("heading", { name: "Reschedules and skips waiting for approval" });
      await expect(heading).toBeVisible({ timeout: FIRST_PAINT_MS });
      await expect(page.getByText("Bartholomew Featherstonehaugh-Wolstenholme").first()).toBeVisible();
      await expect(
        page.getByText("The client was shown and accepted a $25.00 late-change fee.").first(),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(2);
      await expect(page.getByRole("button", { name: "Deny" })).toHaveCount(2);
      await heading.scrollIntoViewIfNeeded();
      await measure(page, `/concerns queue @${w}`, touch);
    });

    test("the owner's setting", async ({ page }) => {
      await installSignedInSession(page);
      await installStubBackend(page);
      await page.goto("/settings/client-portal", { waitUntil: "domcontentloaded" });
      await expect(page.getByText("Reschedules and skips from the portal").first()).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
      await expect(page.getByRole("radio", { name: /Wait for my approval/ })).toBeChecked();
      await expect(page.getByRole("radio", { name: /Apply instantly/ })).not.toBeChecked();
      // The grooming block carries the fixture's own override and fee.
      await expect(page.locator("#pc-cutoff-mobile_grooming")).toHaveValue("24");
      await expect(page.locator("#pc-cfee-mobile_grooming")).toHaveValue("45.00");
      await expect(page.getByRole("switch", { name: "Charge late fees automatically" })).not.toBeChecked();
      await measure(page, `/settings/client-portal @${w}`, touch);
    });
  });
}

/** The customer opens the portal from a text: the portal's own widths. */
for (const width of [360, 430, 768, 1280]) {
  test.describe(`the customer at ${width}px`, () => {
    test.use({
      viewport: { width, height: 900 },
      hasTouch: width < 1280,
      isMobile: width < 768,
    });

    test("sees a request waiting, and a late fee before they can confirm", async ({ page }) => {
      await installStubBackend(page, { portal: true });
      await page.goto(`/portal/${PORTAL_SLUG}/${PORTAL_TOKEN}/visits`, {
        waitUntil: "domcontentloaded",
      });
      await expect(page.getByText(PORTAL_CLIENT_NAME).first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(/is waiting for approval/).first()).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole("button", { name: "Withdraw request" })).toBeVisible();
      await measure(page, `portal visits @${width}`, width < 768);

      // The fourth visit is scheduled, its late window is open, and nothing is
      // waiting on it: its Skip opens the fee line.
      const skip = page.getByRole("button", { name: "Skip", exact: true }).last();
      await skip.scrollIntoViewIfNeeded();
      await skip.click();
      await expect(page.getByText("A late-change fee of $25.00 applies to this change.").first()).toBeVisible();
      await expect(page.getByText("The business reviews this change before it takes effect.").first()).toBeVisible();
      const confirm = page.getByRole("button", { name: /^Request skip/ });
      await expect(confirm).toBeDisabled();
      await page.getByRole("checkbox", { name: /I understand a \$25\.00 late-change fee applies/ }).check();
      await expect(confirm).toBeEnabled();
      await measure(page, `portal visits, skip open @${width}`, width < 768);
    });
  });
}
