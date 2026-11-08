/**
 * "Did you finish this visit?" can be put off, at a phone and a laptop, and
 * the tech can then sign out (#721, a regression of #638).
 *
 * ── WHAT IT WAS ──────────────────────────────────────────────────────────
 *
 * #665 wired the dialog's X and Escape to "Still working", and its static
 * test still passed. A week later the production smoke found X, Escape and a
 * tap outside all leaving the dialog up over My Day, and Sign out unreachable
 * at 1440. The component had not changed. Two things about how it kept its
 * "put off" list had:
 *
 *   - Closing deferred only the visit ON SCREEN. The prompt shows one stale
 *     visit at a time from a list, and the dialog stays open while the next
 *     one swaps in, so with several open visits each X or Escape showed the
 *     next one in the same frame. It looked exactly like nothing happened.
 *     On Nov 1 the demo tech had one open visit and the fix verified; open
 *     visits accumulate, so it stopped working without a line of it changing.
 *   - The list lived in component state, and My Day unmounts the prompt
 *     behind its loading skeleton whenever it opens a day it has not cached.
 *     Every date change brought the prompt back.
 *
 * So the fixture here has THREE stale visits, two of them the same client at
 * the same minute (the same text in the dialog), because one visit is the
 * shape that passed while production was broken. Closing must put off every
 * one of them, and stay put off across a date change, and Sign out must then
 * be reachable the way a tech reaches it at that width.
 *
 * Nothing here answers the prompt: "Yes" / "No" write to the visit, and the
 * stub backend records nothing anyway. Reminding again on the next LOAD is the
 * existing rule and is checked last.
 */
import { test, expect, type Page } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import * as fx from "./fixtures/dataset";
import { FIRST_PAINT_MS } from "./fixtures/first-paint";

const STALE = {
  id: "stale-close-out-1",
  scheduled_on: "2026-10-30",
  started_at: "2026-10-31T03:31:00Z",
  status: "in_progress",
  clients: { display_name: "Dana Vasquez" },
  properties: null,
};
const OPEN_VISITS = [
  STALE,
  { ...STALE, id: "stale-close-out-2", started_at: "2026-10-31T03:31:20Z" },
  {
    ...STALE,
    id: "stale-close-out-3",
    scheduled_on: "2026-11-02",
    started_at: "2026-11-02T15:00:00Z",
  },
];

const WIDTHS = [
  { w: 390, h: 844, label: "390x844 · a phone" },
  { w: 1440, h: 900, label: "1440x900 · a laptop" },
];

async function openMyDayWithStaleVisits(page: Page, w: number, h: number) {
  await installSignedInSession(page.context());
  await installStubBackend(page.context(), {
    role: "tech",
    overrides: {
      // As production showed it: nothing today, nobody on the clock.
      getMyDay: { visits: [] },
      getMyClock: { ...fx.MY_CLOCK, entries: [] },
      listVisitsAwaitingCloseOut: { visits: OPEN_VISITS },
    },
  });
  await page.setViewportSize({ width: w, height: h });
  await page.goto("/my-day", { waitUntil: "domcontentloaded" });
  // The prompt is drawn only by My Day, so it proves the page rendered as the
  // tech. Not the heading: while a modal is open Radix hides the page behind
  // it from the accessibility tree, so the heading is asserted once it closes.
  const prompt = page.getByRole("dialog", { name: "Did you finish this visit?" });
  await expect(prompt).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(prompt).toContainText("Dana Vasquez");
  // Let the open animation finish; a click mid-zoom can land beside the X.
  await page.waitForTimeout(400);
  return prompt;
}

/** Gone, and not merely swapped for the next visit. Held a moment, because
 *  the swap is what this file exists for and it happens after the close. */
async function expectPutOff(page: Page) {
  const prompt = page.getByRole("dialog", { name: "Did you finish this visit?" });
  await expect(prompt, "the close-out prompt is still over My Day").toHaveCount(0);
  await page.waitForTimeout(500);
  await expect(prompt, "the prompt came back with the next open visit").toHaveCount(0);
  // And My Day is usable again: its heading is back in the accessibility tree.
  await expect(page.getByRole("heading", { name: "My day" })).toBeVisible();
}

const DISMISSALS: { how: string; run: (page: Page) => Promise<void> }[] = [
  {
    how: "the Close X",
    run: (page) =>
      page
        .getByRole("dialog", { name: "Did you finish this visit?" })
        .getByRole("button", { name: "Close" })
        .click(),
  },
  { how: "Escape", run: (page) => page.keyboard.press("Escape") },
  // The overlay is the whole screen behind the panel; its top-left corner is
  // outside the panel at both widths.
  { how: "a tap outside", run: (page) => page.mouse.click(4, 4) },
];

for (const { w, h, label } of WIDTHS) {
  for (const { how, run } of DISMISSALS) {
    test(`${how} puts off every open visit (${label})`, async ({ page }) => {
      await openMyDayWithStaleVisits(page, w, h);
      await run(page);
      await expectPutOff(page);
    });
  }

  test(`after Close, the tech can sign out (${label})`, async ({ page }) => {
    const prompt = await openMyDayWithStaleVisits(page, w, h);
    await prompt.getByRole("button", { name: "Close" }).click();
    await expectPutOff(page);

    if (w < 768) {
      // A phone signs out from More, and is asked first.
      await page
        .getByRole("navigation", { name: "Primary" })
        .getByRole("button", { name: "More" })
        .click();
      await page.getByRole("button", { name: "Sign out" }).click();
      await page
        .getByRole("alertdialog", { name: "Sign out?" })
        .getByRole("button", { name: "Sign out" })
        .click();
    } else {
      // A laptop signs out from the account menu, which the prompt covered.
      await page.getByRole("button", { name: "Your account" }).click();
      await page.getByRole("menuitem", { name: "Sign out" }).click();
    }
    await expect(page).toHaveURL(/\/auth(\?|$)/, { timeout: FIRST_PAINT_MS });
  });
}

test("put off stays put off when the tech opens another day (1440x900)", async ({ page }) => {
  // The date input is the laptop's control; a new day is a new query, so My
  // Day shows its skeleton and the prompt is unmounted and mounted again.
  const prompt = await openMyDayWithStaleVisits(page, 1440, 900);
  await prompt.getByRole("button", { name: "Close" }).click();
  await expectPutOff(page);

  const dateInput = page.locator('input[type="date"]:visible');
  await dateInput.fill("2026-11-02");
  await expect(page).toHaveURL(/date=2026-11-02/);
  await expectPutOff(page);
});

test("a fresh load still reminds (390x844)", async ({ page }) => {
  // The existing rule: put off for this load, never recorded. Nothing about
  // the visit changed, so the next load asks again.
  const prompt = await openMyDayWithStaleVisits(page, 390, 844);
  await page.keyboard.press("Escape");
  await expectPutOff(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(prompt).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(prompt).toContainText("Dana Vasquez");
});
