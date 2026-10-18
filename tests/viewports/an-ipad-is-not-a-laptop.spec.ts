/**
 * Batch 10 of the 2026-10-15 launch review: the tablet rows, measured.
 *
 *   Row 34  Office pages on an iPad in portrait kept the 256px sidebar and
 *           left 564px of page at 820. Below 1024 the sidebar is an icon
 *           rail and its labelled panel opens over the page. From 1024 it
 *           is the column, collapsed to the icons or expanded, and the
 *           choice is kept on the device (#499).
 *   Row 35  A technician on an iPad got the office sidebar; My Day on a
 *           desktop was the phone layout 1100px wide under a see-through
 *           header. A tech keeps the tab bar on every touch screen, and My
 *           Day's list is a reading column from `lg`.
 *   Row 36  Settings drew about thirty links above the first setting. From
 *           1024 it is a side menu; from 768 to 1023 one sideways row.
 *   Row 31  Reports' Tech productivity showed only names at 390.
 *
 * The arithmetic behind each is in the unit tests named in each block; this
 * is the browser agreeing with it. Touch is real here (`hasTouch`), so
 * Chromium reports `pointer: coarse` and `hover: none`, which is what the
 * `touch:` and `lg:mouse:` variants read.
 */
import { test, expect, type Page } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend, type SweepRole } from "./fixtures/stub-backend";
import { measurePageOverflow } from "./rules";

const DOCKED = '[data-sidebar="sidebar"]:not([data-mobile])';

async function open(page: Page, path: string, role: SweepRole = "owner") {
  await installSignedInSession(page.context());
  await installStubBackend(page.context(), { role });
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await expect(page.locator("main").first()).toBeVisible({ timeout: 30_000 });
  await page
    .locator("main h1")
    .first()
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => {});
  await page.waitForTimeout(500);
  expect(new URL(page.url()).pathname, `${path} redirected`).toBe(path);
}

/** The docked sidebar's drawn width, or 0 when it is not on screen. */
async function dockedWidth(page: Page): Promise<number> {
  const el = page.locator(DOCKED).first();
  if (!(await el.isVisible())) return 0;
  return (await el.boundingBox())?.width ?? 0;
}

async function mainLeft(page: Page): Promise<number> {
  return (await page.locator("main").first().boundingBox())?.x ?? -1;
}

// ── ROW 34: the rail ─────────────────────────────────────────────────────
// Unit half: tests/a-sidebar-that-took-a-third-of-an-ipad.test.ts.
test.describe("an office user on an iPad gets the icon rail", () => {
  test.use({ hasTouch: true });

  for (const { w, h } of [
    { w: 820, h: 1180 },
    { w: 1000, h: 1180 },
  ]) {
    test(`@${w}px: the page gets the width back, and the panel opens over it`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: w, height: h });
      await open(page, "/clients");

      const rail = await dockedWidth(page);
      expect(rail, "the docked sidebar is the rail").toBeGreaterThan(40);
      expect(rail, "the docked sidebar is the rail").toBeLessThanOrEqual(61);
      const left = await mainLeft(page);
      expect(left, "the page starts at the rail's edge").toBeLessThanOrEqual(rail + 1);

      // Every icon on the rail is a 44px target, and it has a name.
      const links = page.locator(`${DOCKED} [data-sidebar="menu-button"]`);
      const n = await links.count();
      expect(n).toBeGreaterThan(5);
      for (let i = 0; i < n; i++) {
        const b = await links.nth(i).boundingBox();
        if (!b) continue;
        expect(Math.round(b.height), `rail icon ${i} height`).toBeGreaterThanOrEqual(44);
        expect(Math.round(b.width), `rail icon ${i} width`).toBeGreaterThanOrEqual(44);
      }
      await expect(page.locator(DOCKED).getByRole("link", { name: "Invoices" })).toHaveCount(1);

      // Open: the labelled panel, over the page, which does not move.
      const toggle = page.locator('[data-sidebar="rail-toggle"]');
      await expect(toggle).toBeVisible();
      const tb = await toggle.boundingBox();
      expect(Math.round(tb!.height)).toBeGreaterThanOrEqual(44);
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect.poll(() => dockedWidth(page)).toBeGreaterThanOrEqual(250);
      expect(await mainLeft(page), "the overlay pushed the page").toBe(left);

      // Escape closes it.
      await page.keyboard.press("Escape");
      await expect.poll(() => dockedWidth(page)).toBeLessThanOrEqual(61);

      // A tap outside it closes it.
      await toggle.click();
      await expect.poll(() => dockedWidth(page)).toBeGreaterThanOrEqual(250);
      await page.mouse.click(w - 20, Math.round(h / 2));
      await expect.poll(() => dockedWidth(page)).toBeLessThanOrEqual(61);

      // A route change closes it.
      await toggle.click();
      await page.locator(DOCKED).getByRole("link", { name: "Invoices" }).click();
      await expect(page).toHaveURL(/\/invoices$/);
      await expect.poll(() => dockedWidth(page)).toBeLessThanOrEqual(61);

      expect((await measurePageOverflow(page)).scrollW).toBeLessThanOrEqual(w);
    });
  }
});

// ── #499: from 1024 the column, and it remembers ─────────────────────────
// Unit half: the same test file as row 34. Width decides, not the pointer,
// so each size runs with a finger and with a mouse.
for (const hasTouch of [true, false]) {
  test.describe(`from 1024px the column keeps its choice (${hasTouch ? "touch" : "mouse"})`, () => {
    test.use({ hasTouch });

    for (const { w, h, expanded } of [
      { w: 1024, h: 1366, expanded: false },
      { w: 1032, h: 1376, expanded: false },
      { w: 1180, h: 820, expanded: true },
      { w: 1366, h: 1024, expanded: true },
    ]) {
      test(`@${w}px: ${expanded ? "expanded" : "the icons"} at first, and a toggle survives a reload`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: w, height: h });
        await open(page, "/clients");
        const toggle = page.locator('[data-sidebar="rail-toggle"]');
        await expect(toggle).toBeVisible();
        await expect(toggle).toHaveAttribute("aria-expanded", String(expanded));
        const first = await dockedWidth(page);
        if (expanded) expect(first).toBeGreaterThanOrEqual(250);
        else expect(first).toBeLessThanOrEqual(61);
        // Docked beside the page, not over it.
        expect(await mainLeft(page)).toBeGreaterThanOrEqual(first - 1);

        await toggle.click();
        await expect(toggle).toHaveAttribute("aria-expanded", String(!expanded));
        if (expanded) await expect.poll(() => dockedWidth(page)).toBeLessThanOrEqual(61);
        else await expect.poll(() => dockedWidth(page)).toBeGreaterThanOrEqual(250);
        const after = await dockedWidth(page);
        expect(await mainLeft(page), "the column pushed the page").toBeGreaterThanOrEqual(
          after - 1,
        );
        expect((await measurePageOverflow(page)).scrollW).toBeLessThanOrEqual(w);

        // A route change keeps it.
        await page.locator(DOCKED).getByRole("link", { name: "Invoices" }).click();
        await expect(page).toHaveURL(/\/invoices$/);
        await expect(toggle).toHaveAttribute("aria-expanded", String(!expanded));
        expect((await measurePageOverflow(page)).scrollW).toBeLessThanOrEqual(w);

        // And so does a reload.
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(page.locator("main").first()).toBeVisible({ timeout: 30_000 });
        await expect(toggle).toHaveAttribute("aria-expanded", String(!expanded));
        expect(await page.evaluate(() => localStorage.getItem("hs.sidebar.expanded"))).toBe(
          expanded ? "0" : "1",
        );
      });
    }
  });
}

// ── ROW 35: the tech's tab bar on a touch screen ─────────────────────────
// Unit half: tests/a-technician-on-an-ipad-got-the-office-sidebar.test.ts
// and tests/two-navigations-at-768.test.ts.
test.describe("a technician on an iPad", () => {
  test.use({ hasTouch: true });

  for (const { w, h } of [
    { w: 820, h: 1180 },
    { w: 1180, h: 820 },
    { w: 1366, h: 1024 },
  ]) {
    test(`@${w}px: gets the phone's tab bar and no office sidebar`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await open(page, "/my-day", "tech");
      await expect(page.getByRole("navigation", { name: "Primary" }).first()).toBeVisible();
      expect(await dockedWidth(page), "the office sidebar is docked").toBe(0);
      // The bar does not cover the page: the last thing in it clears the bar.
      expect((await measurePageOverflow(page)).scrollW).toBeLessThanOrEqual(w);
    });
  }
});

test("a technician at a desk (1440, mouse) gets the sidebar, and My Day is a reading column", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, "/my-day", "tech");
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeHidden();
  expect(await dockedWidth(page)).toBeGreaterThan(0);
  const list = page.locator("ol.motion-list").first();
  await expect(list).toBeVisible();
  const lb = await list.boundingBox();
  // max-w-3xl, 768px, centred in the page.
  expect(Math.round(lb!.width)).toBeLessThanOrEqual(768);
  const mb = await page.locator("main").first().boundingBox();
  const leftGap = lb!.x - mb!.x;
  const rightGap = mb!.x + mb!.width - (lb!.x + lb!.width);
  expect(Math.abs(leftGap - rightGap), "the column is centred").toBeLessThanOrEqual(2);
});

// ── ROWS 20 and 35: an opaque My Day header ─────────────────────────────
// Unit half: tests/a-header-you-could-read-the-list-through.test.ts.
for (const w of [390, 1440]) {
  test(`My Day's sticky header is opaque @${w}px`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: w < 768 ? 844 : 900 });
    await open(page, "/my-day", "tech");
    const bg = await page
      .locator("[data-page-bleed].sticky")
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    // rgb(...) is opaque; rgba(..., a) or color(... / a) with a < 1 is not.
    const alpha = /\/\s*([\d.]+)\s*\)$|rgba\([^)]*,\s*([\d.]+)\)$/.exec(bg);
    const a = alpha ? Number(alpha[1] ?? alpha[2]) : 1;
    expect(a, `background ${bg}`).toBe(1);
  });
}

// ── ROW 36: the Settings menu ────────────────────────────────────────────
// Unit half: tests/thirty-settings-links-above-the-first-setting.test.ts.
for (const w of [1024, 1366, 1440]) {
  test(`Settings @${w}px: a side menu beside the content`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: 900 });
    await open(page, "/settings/business");
    const nav = page.getByRole("navigation", { name: "Settings sections" });
    await expect(nav).toBeVisible();
    const nb = (await nav.boundingBox())!;
    expect(nb.width, "a side column").toBeLessThanOrEqual(240);
    const content = nav.locator("xpath=following-sibling::div");
    await expect(content).toBeVisible();
    const cb = (await content.boundingBox())!;
    expect(cb.x, "content starts beside the menu").toBeGreaterThan(nb.x + nb.width);
    expect(cb.y, "content starts at the top of the menu").toBeLessThanOrEqual(nb.y + 2);
    await expect(nav.getByRole("link", { name: "Users & roles" })).toBeVisible();
    expect((await measurePageOverflow(page)).scrollW).toBeLessThanOrEqual(w);
  });
}

test.describe("Settings from 768 to 1023: one row", () => {
  test.use({ hasTouch: true });
  for (const w of [820, 1000]) {
    test(`@${w}px: the menu is one row that scrolls inside itself`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: 1180 });
      await open(page, "/settings/business");
      const nav = page.getByRole("navigation", { name: "Settings sections" });
      await expect(nav).toBeVisible();
      const nb = (await nav.boundingBox())!;
      // 44px links, the rule under them and room for a classic scrollbar:
      // the cloud this replaced was 480 to 560px.
      expect(nb.height, "one row of links").toBeLessThanOrEqual(80);
      expect((await measurePageOverflow(page)).scrollW).toBeLessThanOrEqual(w);
      // The open section is in view inside the row.
      const active = nav.locator('[aria-current="page"]').first();
      const ab = (await active.boundingBox())!;
      expect(ab.x).toBeGreaterThanOrEqual(nb.x - 1);
      expect(ab.x + ab.width).toBeLessThanOrEqual(nb.x + nb.width + 1);
    });
  }
});

// ── ROW 31: Tech productivity at 390 ────────────────────────────────────
// Unit half: tests/a-table-that-showed-only-names.test.ts.
test("Reports @390px: each tech is a stacked row with the counts, not a name in a scroller", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, "/reports");
  const stacked = page.locator('[data-tech-productivity="stacked"]');
  await expect(stacked).toBeVisible();
  await expect(page.locator('[data-tech-productivity="table"]')).toBeHidden();
  await expect(stacked.locator("li").first().getByText("Completed")).toBeVisible();
  expect((await measurePageOverflow(page)).scrollW).toBeLessThanOrEqual(390);
});

test("Reports @1440px: all four Tech productivity columns are on screen", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, "/reports");
  const table = page.locator('[data-tech-productivity="table"]');
  await expect(table).toBeVisible();
  const tb = (await table.boundingBox())!;
  const card = (await table.locator("xpath=..").boundingBox())!;
  expect(tb.x + tb.width, "the table runs past its card").toBeLessThanOrEqual(card.x + card.width + 1);
  const totalHeader = table.getByRole("columnheader", { name: "Total" });
  const hb = (await totalHeader.boundingBox())!;
  expect(hb.x + hb.width).toBeLessThanOrEqual(card.x + card.width + 1);
});
