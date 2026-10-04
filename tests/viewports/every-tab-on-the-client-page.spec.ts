/**
 * The client page is eight pages, and only one of them had ever been measured.
 *
 * `every-signed-in-page-at-every-width.spec.ts` opens /clients/:id, proves it
 * rendered, and measures. It lands on Summary and stops there. Properties,
 * Services, Visits, Billing, Communication, Reviews & referrals and Activity
 * are seven more full surfaces behind a tab strip, never rendered under
 * measurement, and two faults were sitting in them:
 *
 *   - Billing scrolled the page sideways 76px at 768px, from an `sr-only`
 *     span escaping a `position: static` scroll container. See
 *     tests/an-sr-only-span-scrolled-the-page-sideways.test.ts.
 *   - Properties offered a 20px text link as the only way out of the
 *     "No boundary drawn yet" empty state.
 *
 * So this clicks each tab and applies the same four rules. It is a sweep over
 * one page rather than over routes, because that is the shape this page is.
 *
 * The tab must be proved to have actually switched before measuring —
 * `settle()`'s reason applies at tab granularity too: every rule here is of
 * the form "nothing is wrong", and all of them pass on a panel that never
 * rendered. Radix sets aria-selected, and the panel it points at is the one
 * that has to be visible.
 */
import { test, expect, type Page } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import { CLIENT_ID } from "./fixtures/dataset";
import {
  measurePageOverflow,
  findControlsOffTheSide,
  findSilentlyClippedText,
  findControlsUnder44px,
  findControlsNarrowerThanTheirLabel,
} from "./rules";

const TABS = [
  "Summary",
  "Properties",
  "Services",
  "Visits",
  "Billing",
  "Communication",
  "Reviews & referrals",
  "Activity",
];

/** 768 is on the list on purpose: it is the width the Billing fault appeared
 *  at and nowhere else, because it is where the sidebar takes its share and
 *  the table's min-width stops fitting. 360 is a real phone. */
const WIDTHS = [360, 430, 768, 1280];

async function openClient(page: Page) {
  await installSignedInSession(page);
  await installStubBackend(page);
  await page.goto(`/clients/${CLIENT_ID}`, { waitUntil: "domcontentloaded" });
  // Proof this is the client page and not /auth: a tab only this page draws.
  await expect(page.getByRole("tab", { name: "Reviews & referrals" })).toBeVisible({
    timeout: 30_000,
  });
  // Proof the fixture arrived, not just the shell.
  await expect(page.getByText("Anastasia Vandermolen-Whitaker").first()).toBeVisible();
}

async function showTab(page: Page, name: string) {
  const tab = page.getByRole("tab", { name, exact: true }).first();
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  const id = await tab.getAttribute("aria-controls");
  // An attribute selector rather than `#id`: Radix ids contain `:`, and
  // CSS.escape does not exist in the Node side of a Playwright test.
  if (id) await expect(page.locator(`[id="${id}"]`)).toBeVisible();
  // Charts and tables settle a frame or two after the panel mounts.
  await page.waitForTimeout(700);
}

for (const width of WIDTHS) {
  test.describe(`the client page at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 }, isMobile: width < 768, deviceScaleFactor: 2 });

    for (const name of TABS) {
      test(`${name} holds together`, async ({ page }) => {
        await openClient(page);
        await showTab(page, name);

        const { scrollW, innerW } = await measurePageOverflow(page);
        expect(
          scrollW,
          `${name} @${width}: the page scrolls sideways ${scrollW - innerW}px. ` +
            `Look for an sr-only or other absolutely positioned child of an ` +
            `unpositioned overflow-x-auto container — body.scrollWidth will ` +
            `look fine and <html> will not.`,
        ).toBeLessThanOrEqual(innerW + 1);

        expect(await findControlsOffTheSide(page), `${name} @${width}: off the side`).toEqual([]);
        expect(await findSilentlyClippedText(page), `${name} @${width}: clipped`).toEqual([]);
        // Added 2026-10-04: this sweep opened Billing at 360px and passed while
        // "Add card" drew its label out through its own border. On screen and
        // not clipped, so none of the rules above could fail on it.
        expect(
          await findControlsNarrowerThanTheirLabel(page),
          `${name} @${width}: a button narrower than its label`,
        ).toEqual([]);
        if (width < 768) {
          expect(await findControlsUnder44px(page), `${name} @${width}: under 44px`).toEqual([]);
        }
      });
    }
  });
}
