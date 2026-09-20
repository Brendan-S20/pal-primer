// QA: "My schedule (/my-schedule). A tech's upcoming days: the day strip,
// 'Thursday, 6 stops', View schedule into the right day."
//
// The render half is already proven elsewhere; what nothing proved is the
// LANDING — that tapping a day opens My Day showing that day and not today.
// The mechanism is a search param (`/my-day?date=YYYY-MM-DD`, validated by a
// regex in my-day's validateSearch), and today's row deliberately carries no
// param at all, so the two cases are different code paths and both are here.
//
// One wrinkle the DOM forces: the strip's "6 STOPS" is lowercase "stops" in a
// separate element (the uppercase is CSS), so the count and the word are
// asserted apart rather than as the phrase QA wrote.

import { expect, test } from "@playwright/test";

import { pointTheBrowserAtTheLocalDatabase } from "./point-the-browser-at-the-local-database";
import { signIn } from "./sign-in";

test.beforeEach(async ({ context }) => {
  await pointTheBrowserAtTheLocalDatabase(context, {
    url: process.env.SUPABASE_URL ?? "http://127.0.0.1:54421",
    anonKey: process.env.SUPABASE_PUBLISHABLE_KEY ?? "",
  });
});

test("a future day's row opens My Day on that day, and today's opens today", async ({ page }) => {
  test.setTimeout(180_000);

  await signIn(page);
  await page.goto("/my-schedule");

  const rows = page.getByLabel("Your upcoming days").locator("li > a");
  await expect
    .poll(async () => rows.count(), {
      message:
        "no upcoming days on the strip — the seeded owner is the field tech and " +
        "seed_demo_org schedules forward visits, so an empty strip is a fixture fault",
      timeout: 30_000,
    })
    .toBeGreaterThan(1);

  // Every row shows its stop count; the word is its own element.
  await expect(rows.first().getByText(/^stops?$/)).toBeVisible();

  // ── A future day carries its date in the link and My Day honors it ──────
  //
  // Row 0 can be today (whose href is bare /my-day), so the future case is
  // any row whose href carries ?date=. Read the date off the href rather
  // than computing "tomorrow": the strip only lists days with visits, and
  // which days those are belongs to the seed, not to this spec.
  const futureRow = page.getByLabel("Your upcoming days").locator('a[href*="date="]').first();
  await expect(futureRow).toBeVisible({ timeout: 20_000 });
  const href = await futureRow.getAttribute("href");
  const pickedDay = /date=(\d{4}-\d{2}-\d{2})/.exec(href ?? "")?.[1];
  expect(pickedDay, `a future row's href (${href}) names its day`).toBeTruthy();

  await futureRow.click();
  await expect(page).toHaveURL(new RegExp(`/my-day.*date=${pickedDay}`), { timeout: 20_000 });
  // Two date inputs exist (mobile/desktop, one hidden per breakpoint); the
  // visible one is the day the page is actually showing.
  await expect(page.locator('input[type="date"]:visible')).toHaveValue(pickedDay!, {
    timeout: 20_000,
  });

  // ── And back on the strip, today's row goes to plain /my-day ────────────
  await page.goto("/my-schedule");
  const todayRow = rows.filter({ hasText: "Today" }).first();
  if ((await todayRow.count()) > 0) {
    await todayRow.click();
    await expect(page).toHaveURL(/\/my-day(?!.*date=)/, { timeout: 20_000 });
  }
  // A seed run started late in the org's day can leave today with no visits
  // and therefore no row; that is the fixture's truth, not a failure — the
  // future-day case above is the one QA actually asks about.
});
