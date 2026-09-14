// Eleven tabs, five visible, and nothing saying so.
//
// The client tab bar scrolls sideways below `md` with `no-scrollbar`, which
// removes the one affordance a scroller normally has. Measured on a real phone
// against a real client: Summary / Properties / Services / Visits / Billing
// visible, and Communication, Reviews & referrals, Activity, Office,
// Technician and Client all off the side with nothing to suggest it. Billing
// looks like the last tab. It is the fifth of eleven.
//
// The fix is a mask on whichever edge has content past it. It cannot be
// unconditional: over a bar that fits it would dim the last tab and make a
// complete row look truncated. So this asserts BOTH halves — it appears where
// the bar overflows, and it stays away where the bar fits.
import { test, expect } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import { FIRST_PAINT_MS } from "./fixtures/first-paint";
import { CLIENT_ID } from "./fixtures/dataset";

const CLIENT_DETAIL = `/clients/${CLIENT_ID}`;

const PHONE = { width: 430, height: 932 };

test.describe("the tab bar admits it continues", () => {
  test.use({ viewport: PHONE, isMobile: true, deviceScaleFactor: 2 });

  test("marks the end edge when tabs run off the side", async ({ page }) => {
    await installSignedInSession(page);
    await installStubBackend(page);
    await page.goto(CLIENT_DETAIL, { waitUntil: "domcontentloaded" });

    const list = page.getByRole("tablist").first();
    await expect(list).toBeVisible({ timeout: FIRST_PAINT_MS });

    // The premise. If the bar ever stops overflowing on a phone the fade is
    // pointless and this test should be the thing that says so.
    const { scrollWidth, clientWidth } = await list.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(scrollWidth, "the tab bar no longer overflows a 430px phone").toBeGreaterThan(
      clientWidth + 1,
    );

    await expect(list).toHaveAttribute("data-overflow-end", "");
    // Nothing has scrolled yet, so there is nothing off the LEFT.
    expect(await list.getAttribute("data-overflow-start")).toBeNull();
  });

  test("and marks the start edge once you have scrolled past it", async ({ page }) => {
    await installSignedInSession(page);
    await installStubBackend(page);
    await page.goto(CLIENT_DETAIL, { waitUntil: "domcontentloaded" });

    const list = page.getByRole("tablist").first();
    await expect(list).toBeVisible({ timeout: FIRST_PAINT_MS });
    await list.evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
    await page.waitForTimeout(300);

    await expect(list).toHaveAttribute("data-overflow-start", "");
    // Scrolled fully right: nothing further to the right.
    expect(await list.getAttribute("data-overflow-end")).toBeNull();
  });

  test("leaves a bar that fits alone", async ({ page }) => {
    // A fade over a complete row is worse than no fade: it dims a real tab and
    // implies content that is not there.
    await installSignedInSession(page);
    await installStubBackend(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(CLIENT_DETAIL, { waitUntil: "domcontentloaded" });

    const list = page.getByRole("tablist").first();
    await expect(list).toBeVisible({ timeout: FIRST_PAINT_MS });
    expect(await list.getAttribute("data-overflow-end")).toBeNull();
    expect(await list.getAttribute("data-overflow-start")).toBeNull();
  });
});
