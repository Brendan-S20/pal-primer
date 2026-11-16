/**
 * A technician's own schedule, at the widths they hold it at.
 *
 * ── WHAT THIS REPLACED ───────────────────────────────────────────────────
 *
 * A tech with nothing scheduled saw one action on My Day — "View schedule" —
 * pointing at /routes, which ROUTE_ROLES has never granted them. RoleGuard
 * bounced them straight back with a red "You don't have access to that page."
 * The only button on the screen was a dead end for the only role the screen
 * exists for, and nothing failed, because nothing checks that a link's
 * destination admits the person being shown it. A unit test now checks that;
 * this one checks the page it now points at is actually usable.
 *
 * ── WHAT THE FIXTURE IS SHAPED LIKE, AND WHY ─────────────────────────────
 *
 * Not a tidy week. Twelve stops across two zones with long real names next to
 * a two-digit count is the widest row this page can produce, and it is the
 * first one. One day is partly worked so the "N left" branch renders. And
 * there is a GAP — no row for day+2 — because "which days they work" is only
 * a real answer if a day off is absent rather than shown as a zero.
 */
import { test, expect, type Page } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend, myUpcomingDays, type SweepRole } from "./fixtures/stub-backend";
import { FIRST_PAINT_MS } from "./fixtures/first-paint";
import { day } from "./fixtures/dataset";
import { orgInstant, pinTheBrowserToTheFixtureDay } from "./fixtures/fixture-clock";

/**
 * Signed in, with the browser's clock held on the fixture's day.
 *
 * ── WHY THE CLOCK IS PINNED (#941, 2026-11-16) ───────────────────────────
 *
 * The "today" assertion below compares two clocks: the fixture's, read when
 * the worker imported dataset.ts, and the browser's, read when the page
 * renders. Unpinned, a worker that started at 23:58 Chicago and rendered at
 * 00:00 served Sunday's row to a page that already said Monday — a required
 * job failed on a PR that never touched this page. The app was right; the
 * test was timing itself. Now the page reads the same instant the fixture was
 * built from (noon on its day by default), and `at` lets a case stand on
 * either side of midnight with a fixture built at that same instant.
 */
async function signInAs(page: Page, role: SweepRole, at?: Date) {
  await installSignedInSession(page);
  const today = await pinTheBrowserToTheFixtureDay(page, at);
  await installStubBackend(page, {
    role,
    ...(at ? { overrides: { getMyUpcomingDays: myUpcomingDays(at) } } : {}),
  });
  return today;
}

const readRows = (page: Page) =>
  page.evaluate(() => {
    // Scoped to the named list. `li a` unscoped also matches the mobile tab
    // bar — Today / Waste log / Alerts are all <li><a> in the same document —
    // which made the first draft of this spec count seven rows and fail for a
    // reason that had nothing to do with the schedule.
    const list = document.querySelector('ul[aria-label="Your upcoming days"]');
    const items = list
      ? [...list.querySelectorAll("li")].filter((li) => li.querySelector("a"))
      : [];
    return items.map((li) => {
      const a = li.querySelector("a") as HTMLElement;
      const r = a.getBoundingClientRect();
      return {
        text: (a.innerText || "").replace(/\s+/g, " ").trim(),
        href: a.getAttribute("href") ?? "",
        right: Math.round(r.right),
        height: Math.round(r.height),
        clipped: a.scrollWidth > a.clientWidth + 1,
      };
    });
  });

/**
 * The rows, once the page has DRAWN them.
 *
 * ── WHY THIS WAITS, AND WHAT IT WAITS FOR (2026-10-09) ───────────────────
 *
 * The heading is on screen before the data is. /my-schedule renders its title
 * and an empty `<ul aria-label="Your upcoming days">` at once, shows a skeleton
 * while `getMyUpcomingDays` is in flight, and only then fills the list. This
 * file used to read the list the moment the heading was visible, which is a
 * race against one server-function round trip — usually won, because the stub
 * answers in a few milliseconds, and lost on the Windows runner at 01:13 UTC
 * on 2026-10-09 with eight workers sharing one dev server: "no day rows
 * rendered", Received 0, while the 360px case and the day-off case in the same
 * file, against the same fixture at the same minute, both passed. The clock
 * was a coincidence; a 1.5s delay on that one stub reply reproduces it at any
 * hour.
 *
 * So it waits for the count it expects. A fixture that really put nothing on
 * the page still fails here, with the same message, after the timeout rather
 * than before the reply.
 */
async function rowsOnceDrawn(page: Page, expected: number) {
  await expect
    .poll(async () => (await readRows(page)).length, {
      message: "no day rows rendered — the fixture put nothing on the page",
      timeout: FIRST_PAINT_MS,
    })
    .toBe(expected);
  return readRows(page);
}

/** Everything the first test asserts, so the midnight cases assert exactly
 *  the same things rather than a lighter copy of them. */
async function readTheNextTwoWeeks(page: Page, w: number, today: string) {
  await page.goto("/my-schedule", { waitUntil: "domcontentloaded" });

  // Proves the page RENDERED, and proves the role took. A tech bounced by
  // RoleGuard lands on /my-day, which would pass every "nothing overflows"
  // assertion below — that is exactly the failure this file exists for.
  await expect(page.getByRole("heading", { name: "My schedule" })).toBeVisible({
    timeout: FIRST_PAINT_MS,
  });
  expect(new URL(page.url()).pathname, "RoleGuard bounced the tech off their own schedule").toBe(
    "/my-schedule",
  );

  const rows = await rowsOnceDrawn(page, 3);

  for (const row of rows) {
    expect(row.right, `a day row runs ${row.right - w}px off the right edge`).toBeLessThanOrEqual(
      w,
    );
    expect(
      row.height,
      `a day row is ${row.height}px tall, under the 44px floor`,
    ).toBeGreaterThanOrEqual(44);
    expect(row.clipped, `a day row is clipped with no way to read it: ${row.text}`).toBe(false);
  }

  // The counts are the point of the page; assert they actually reached it
  // rather than trusting that something rendered.
  expect(rows[0].text, "the first day should carry its stop count").toContain("12");
  expect(rows[0].text, "a partly-worked day should say how many are left").toContain("7 left");
  // The fixture's TODAY has to be the page's today — the org's date in
  // America/Chicago — or the first row is just a date. Until 2026-10-09 the
  // fixture took its date from the runner's clock, and for the hour after
  // midnight Eastern this row lost its badge. The fixture's half of that is
  // pinned at every hour by tests/the-fixture-today-is-the-orgs-today.test.ts;
  // this is the page agreeing with it, on the same instant (#941).
  // (A regex because the badge is `uppercase`, and innerText says TODAY.)
  expect(rows[0].text, "the fixture's first day is not the page's today").toMatch(/\btoday\b/i);
  // And only the first. A page a day behind badges nothing; a page a day
  // ahead (the device's zone east of the org's) badges the second row.
  for (const r of rows.slice(1)) {
    expect(r.text, `a day after today is badged Today: ${r.text}`).not.toMatch(/\btoday\b/i);
  }
  // Today's row opens My Day on its default (no ?date=); tomorrow's names
  // its date. The same comparison, made where a tap lands.
  expect(rows[0].href, "today's row should open My Day on today").not.toContain("date=");
  expect(rows[1].href, "tomorrow's row should name its date").toContain(
    `date=${day(1, new Date(`${today}T12:00:00Z`))}`,
  );
  return rows;
}

for (const { w, h, label } of [
  { w: 360, h: 800, label: "360x800 · a small phone" },
  { w: 430, h: 932, label: "430x932 · iPhone Pro Max" },
]) {
  test(`a technician can read their next two weeks (${label})`, async ({ page }) => {
    const today = await signInAs(page, "tech");
    await page.setViewportSize({ width: w, height: h });
    await readTheNextTwoWeeks(page, w, today);
  });
}

/**
 * Either side of midnight, in the org's zone, with the device in three.
 *
 * The acceptance for #941: stand the clock at 11:59 PM and 12:01 AM Chicago,
 * build the fixture at that same instant, and the page agrees with it. The
 * device zones are the org's own, one far ahead (Tokyo: already the next
 * afternoon at both pins) and one behind (Honolulu: still the previous
 * evening) — so a page that read "today" from the DEVICE rather than the org
 * badges the wrong row here, at a pin, every run, instead of for an hour a
 * night on whichever runner happens to be awake.
 */
const PINS = [
  { name: "11:59 PM", at: () => orgInstant(day(0), "23:59") },
  { name: "12:01 AM", at: () => orgInstant(day(1), "00:01") },
];
for (const deviceZone of ["America/Chicago", "Asia/Tokyo", "Pacific/Honolulu"]) {
  test.describe(`with the device in ${deviceZone}`, () => {
    test.use({ timezoneId: deviceZone });
    for (const pin of PINS) {
      test(`the first day is today at ${pin.name} in Chicago`, async ({ page }) => {
        const at = pin.at();
        const today = await signInAs(page, "tech", at);
        expect(today, "the pin is not on the side of midnight it names").toBe(
          pin.name === "11:59 PM" ? day(0) : day(1),
        );
        await page.setViewportSize({ width: 360, height: 800 });
        await readTheNextTwoWeeks(page, 360, today);
      });
    }
  });
}

/**
 * The control: the fault itself, on purpose. A fixture built at 11:59 PM,
 * a page opened at 12:01 AM — what an unpinned run that crossed midnight
 * did. The first row must LOSE its badge here; if it does not, the badge
 * assertion above is not looking at the clock at all, and the midnight
 * cases are green for a reason that has nothing to do with them.
 */
test("a fixture from before midnight is not today after it (the #941 fault, on purpose)", async ({
  page,
}) => {
  const built = orgInstant(day(0), "23:59");
  const opened = orgInstant(day(1), "00:01");
  await installSignedInSession(page);
  await pinTheBrowserToTheFixtureDay(page, opened);
  await installStubBackend(page, {
    role: "tech",
    overrides: { getMyUpcomingDays: myUpcomingDays(built) },
  });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/my-schedule", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "My schedule" })).toBeVisible({
    timeout: FIRST_PAINT_MS,
  });
  const rows = await rowsOnceDrawn(page, 3);
  expect(
    rows[0].text,
    "yesterday's row is badged Today — the badge is not reading the clock",
  ).not.toMatch(/\btoday\b/i);
});

test("a day with nothing assigned is absent, not a zero", async ({ page }) => {
  // The fixture deliberately skips day+2. A schedule that lists days off with
  // "0 stops" answers a different question from the one asked, and would pass
  // every size assertion above.
  await signInAs(page, "tech");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/my-schedule", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "My schedule" })).toBeVisible({
    timeout: FIRST_PAINT_MS,
  });

  const rows = await rowsOnceDrawn(page, 3);
  for (const r of rows) {
    expect(r.text, `a day off is being listed as empty: ${r.text}`).not.toMatch(/\b0 stops?\b/);
  }
});
