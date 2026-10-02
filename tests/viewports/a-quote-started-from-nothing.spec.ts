/**
 * A quote opens with its service line already priced, and that line fits a
 * phone.
 *
 * Owner, 2026-10-01: "I'm not sure why zone pricing or base pricing isn't
 * already pre-inputted or have them available as an option." Now a quote
 * started for somebody the app knows opens with a per-visit line priced from
 * their zone, a sentence under it saying where the number came from, and an
 * "Add service from pricing" picker listing every price the owner has set.
 *
 * Both are new things on the narrowest card in the app -- the line card was
 * designed to stack at 320px -- so this measures them at 320, 360, 768 and
 * 1280, with the long zone name from the fixture in both the note and the
 * picker. Started from a lead (the "Send a quote" action on /leads), which is
 * the path that has an address to price from.
 *
 * It asserts the prefill reached the screen first, for the reason
 * every-signed-in-page-at-every-width.spec.ts gives: every layout rule below
 * passes on a page that drew nothing.
 */
import { test, expect } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import { LEAD_ID } from "./fixtures/dataset";
import { findControlsOffTheSide, findControlsUnder44px, measurePageOverflow } from "./rules";

const ZONE = "Ravenswood Manor / Lincoln Square North";

for (const w of [320, 360, 768, 1280]) {
  test(`a new quote opens priced from the zone, and fits at ${w}px`, async ({ page, context }) => {
    await installSignedInSession(context);
    await installStubBackend(context);
    await page.setViewportSize({ width: w, height: 900 });
    await page.goto(`/quotes/new?fromLead=${LEAD_ID}`);
    await page.waitForLoadState("networkidle").catch(() => {});

    // 3 dogs every two weeks in a $28 + $6/dog zone: (28 + 2 x 6) x 1.7.
    const price = page.locator('input[id$="-price"]').first();
    await expect(price).toHaveValue("68.00", { timeout: 20000 });
    await expect(page.locator('input[id$="-desc"]').first()).toHaveValue(
      "Every-2-weeks visit, 3 dogs",
    );
    const note = page.getByTestId("line-priced-from").first();
    await expect(note).toContainText(`Priced from ${ZONE}.`);

    const check = async (when: string) => {
      const { scrollW, innerW } = await measurePageOverflow(page);
      expect(scrollW, `${when}: the page scrolls sideways at ${w}px`).toBeLessThanOrEqual(innerW);
      expect(await findControlsOffTheSide(page), `${when} at ${w}px`).toEqual([]);
      if (w < 768) {
        expect(await findControlsUnder44px(page), `${when} at ${w}px`).toEqual([]);
      }
      const nb = await note.boundingBox();
      expect(nb!.x + nb!.width, `${when}: the price note runs off the side`).toBeLessThanOrEqual(
        w + 1,
      );
    };
    await check("prefilled");

    // The picker: the matched zone first, then the standard price, then the
    // other zone, each with its price on a button.
    await page.getByRole("button", { name: "Add service from pricing" }).click();
    const picker = page.getByTestId("quote-service-picker");
    await expect(picker).toBeVisible();
    await expect(picker.getByRole("listitem")).toHaveCount(3);
    await expect(picker.getByRole("listitem").first()).toContainText(ZONE);
    await expect(picker).toContainText("Standard pricing");
    await check("picker open");

    // Picking the standard price re-prices the untouched line in place.
    await picker.getByRole("button", { name: /^Add Standard pricing/ }).click();
    await expect(price).toHaveValue("59.50"); // (25 + 2 x 5) x 1.7
    await expect(note).toContainText("Priced from your standard pricing.");

    // And typing over it makes it the owner's, said plainly.
    await price.fill("60.00");
    await expect(note).toContainText("then changed here");
  });
}
