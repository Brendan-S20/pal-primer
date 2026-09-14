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
import { installStubBackend, type SweepRole } from "./fixtures/stub-backend";
import { FIRST_PAINT_MS } from "./fixtures/first-paint";

async function signInAs(page: Page, role: SweepRole) {
  await installSignedInSession(page);
  await installStubBackend(page, { role });
}

const readRows = (page: Page) =>
  page.evaluate(() => {
    // Scoped to the named list. `li a` unscoped also matches the mobile tab
    // bar — Today / Waste log / Alerts are all <li><a> in the same document —
    // which made the first draft of this spec count seven rows and fail for a
    // reason that had nothing to do with the schedule.
    const list = document.querySelector('ul[aria-label="Your upcoming days"]');
    const items = list ? [...list.querySelectorAll("li")].filter((li) => li.querySelector("a")) : [];
    return items.map((li) => {
      const a = li.querySelector("a") as HTMLElement;
      const r = a.getBoundingClientRect();
      return {
        text: (a.innerText || "").replace(/\s+/g, " ").trim(),
        right: Math.round(r.right),
        height: Math.round(r.height),
        clipped: a.scrollWidth > a.clientWidth + 1,
      };
    });
  });

for (const { w, h, label } of [
  { w: 360, h: 800, label: "360x800 · a small phone" },
  { w: 430, h: 932, label: "430x932 · iPhone Pro Max" },
]) {
  test(`a technician can read their next two weeks (${label})`, async ({ page }) => {
    await signInAs(page, "tech");
    await page.setViewportSize({ width: w, height: h });
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

    const rows = await readRows(page);
    expect(rows.length, "no day rows rendered — the fixture put nothing on the page").toBe(3);

    for (const row of rows) {
      expect(row.right, `a day row runs ${row.right - w}px off the right edge`).toBeLessThanOrEqual(w);
      expect(row.height, `a day row is ${row.height}px tall, under the 44px floor`).toBeGreaterThanOrEqual(44);
      expect(row.clipped, `a day row is clipped with no way to read it: ${row.text}`).toBe(false);
    }

    // The counts are the point of the page; assert they actually reached it
    // rather than trusting that something rendered.
    expect(rows[0].text, "the first day should carry its stop count").toContain("12");
    expect(rows[0].text, "a partly-worked day should say how many are left").toContain("7 left");
  });
}

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

  const rows = await readRows(page);
  expect(rows.length).toBe(3);
  for (const r of rows) {
    expect(r.text, `a day off is being listed as empty: ${r.text}`).not.toMatch(/\b0 stops?\b/);
  }
});
