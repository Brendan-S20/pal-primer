/**
 * My Day gets its room back.
 *
 * The owner, from an iPhone 17 Pro on TestFlight build 261, 2026-10-07:
 * "there's a gap between the next up and the navigation bar, also the clock
 * in and clock out, plus the route on lock screen need a better
 * home/location. It's too cluttered."
 *
 * ── THE GAP ───────────────────────────────────────────────────────────────
 *
 * NEXT UP was parked at `bottom: calc(3.5rem + inset)` while the tab bar it
 * was meant to sit on was as tall as its contents, 51px. So it floated 5px
 * above the bar and the stop list scrolled through the slot between them,
 * which is what the owner drew red lines around. The bar is now exactly
 * `--tab-bar-h` tall (styles.css) and NEXT UP offsets by the same variable,
 * and this file measures the two edges against each other, ±1px, at the
 * widths a tech's phone and iPad come in, with touch on, both with the
 * iPhone's real safe-area insets (`Emulation.setSafeAreaInsetsOverride`, as
 * what-the-iphone-showed.spec.ts does) and without them, which is the web.
 * Without the insets is not redundant: an inset counted twice cancels out at
 * zero and only shows with the insets on, and a bar sized off the inset alone
 * shows only with them off.
 *
 * ── THE CLUTTER ───────────────────────────────────────────────────────────
 *
 * Two full-width cards, "On the clock" and "Route on the lock screen", put
 * the first stop halfway down the phone. On 2026-10-07 they became a chip
 * and an icon in the status row; on 2026-10-08, after a day of that on
 * TestFlight, the owner took both off My Day. The status row is the date,
 * progress and List/Map again; the clock is a "Time clock" row in the More
 * sheet, which opens the clock sheet; and the only thing My Day says about
 * the clock is a slim "You're off the clock" with Clock in, drawn only when
 * there is work today and nobody is on it. Measured: the first stop starts
 * right under the status row, nothing about the clock is on My Day while on
 * it, the More row opens a sheet with Clock out in it, and off the clock the
 * banner's Clock in is a full-size target inside the screen.
 *
 * Proof the page rendered and is the tech's, before any "nothing is wrong"
 * assertion: the heading, and a client name only the fixture holds.
 */
import { test, expect, type Page } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import { FIRST_PAINT_MS } from "./fixtures/first-paint";
import * as fx from "./fixtures/dataset";
import { measurePageOverflow } from "./rules";

type Insets = { top: number; bottom: number; left: number; right: number };
const NONE: Insets = { top: 0, bottom: 0, left: 0, right: 0 };

/** Each width with the insets of the device it stands for. */
const SIZES: { name: string; width: number; height: number; insets: Insets }[] = [
  { name: "iPhone SE", width: 320, height: 568, insets: { top: 20, bottom: 0, left: 0, right: 0 } },
  {
    name: "iPhone 14",
    width: 390,
    height: 844,
    insets: { top: 47, bottom: 34, left: 0, right: 0 },
  },
  {
    name: "iPhone 17 Pro",
    width: 402,
    height: 874,
    insets: { top: 62, bottom: 34, left: 0, right: 0 },
  },
  {
    name: "iPad mini",
    width: 768,
    height: 1024,
    insets: { top: 24, bottom: 20, left: 0, right: 0 },
  },
  // Landscape is its own size: a short screen, and the island on the side.
  {
    name: "iPhone 17 Pro landscape",
    width: 874,
    height: 402,
    insets: { top: 0, bottom: 21, left: 62, right: 62 },
  },
];

async function emulateInsets(page: Page, insets: Insets) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride" as never, { insets } as never);
}

/** The override is in force on THIS document, or every number below is the
 *  web's and not the app's. */
async function expectInsetsResolve(page: Page, insets: Insets) {
  const got = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.cssText =
      "position:fixed;left:0;top:0;width:1px;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);visibility:hidden";
    document.body.appendChild(probe);
    const cs = getComputedStyle(probe);
    const out = { top: parseFloat(cs.paddingTop), bottom: parseFloat(cs.paddingBottom) };
    probe.remove();
    return out;
  });
  expect(got, "the safe-area emulation did not take").toEqual({
    top: insets.top,
    bottom: insets.bottom,
  });
}

async function openMyDay(page: Page, opts: { offTheClock?: boolean } = {}) {
  await installSignedInSession(page.context());
  // The same tech, nothing on the clock today. An override rather than a
  // route on getMyClock: the shell's first load carries the clock inside
  // getShellParts, and My Day reads that answer without asking again.
  await installStubBackend(page.context(), {
    role: "tech",
    overrides: opts.offTheClock ? { getMyClock: { ...fx.MY_CLOCK, entries: [] } } : undefined,
  });
  await page.goto("/my-day", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "My day" })).toBeVisible({
    timeout: FIRST_PAINT_MS,
  });
  await expect(page.getByText("Anastasia Vandermolen-Whitaker").first()).toBeVisible();
  // NEXT UP fades in; a box measured mid-animation is not the box.
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await page.waitForTimeout(600);
}

/** NEXT UP's bottom edge and the tab bar's top edge, and where NEXT UP is
 *  when there is no tab bar (above `lg` for a tech). */
async function readBottomChrome(page: Page) {
  return page.evaluate(() => {
    const nav = document.querySelector<HTMLElement>("nav[data-bottom-chrome]");
    const next = [...document.querySelectorAll<HTMLElement>("div[data-bottom-chrome]")].find((d) =>
      /next up|in progress/i.test(d.textContent ?? ""),
    );
    const box = (el: HTMLElement | null | undefined) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return r.height > 0 && getComputedStyle(el).display !== "none"
        ? { top: r.top, bottom: r.bottom, height: r.height }
        : null;
    };
    return { nav: box(nav), next: box(next), innerHeight: window.innerHeight };
  });
}

for (const size of SIZES) {
  for (const withInsets of [true, false]) {
    const insets = withInsets ? size.insets : NONE;
    test.describe(`My Day on ${size.name} (${size.width}x${size.height}), ${
      withInsets ? "with" : "without"
    } the safe-area insets`, () => {
      test.use({
        viewport: { width: size.width, height: size.height },
        isMobile: size.width < 768,
        hasTouch: true,
        deviceScaleFactor: 2,
      });

      test("NEXT UP sits flush on the tab bar, with nothing between them", async ({ page }) => {
        await emulateInsets(page, insets);
        await openMyDay(page);
        await expectInsetsResolve(page, insets);

        const g = await readBottomChrome(page);
        expect(g.next, "NEXT UP did not render; the fixture has a visit to be next").not.toBeNull();
        if (g.nav) {
          // The owner's complaint, as a number.
          expect(
            Math.abs(g.next!.bottom - g.nav.top),
            `NEXT UP ends at ${g.next!.bottom}px and the tab bar starts at ${g.nav.top}px`,
          ).toBeLessThanOrEqual(1);
          // And the tab bar is the height everything else assumes it is:
          // --tab-bar-h (56px) above the home indicator.
          expect(Math.round(g.nav.height)).toBe(56 + insets.bottom);
          expect(Math.round(g.nav.bottom)).toBe(size.height);
        } else {
          // No tab bar at this width: NEXT UP is the bottom edge, and pads
          // by the home indicator itself.
          expect(Math.round(g.next!.bottom)).toBe(size.height);
        }
      });
    });
  }

  test.describe(`My Day's status row on ${size.name} (${size.width}px)`, () => {
    test.use({
      viewport: { width: size.width, height: size.height },
      isMobile: size.width < 768,
      hasTouch: true,
      deviceScaleFactor: 2,
    });

    test("the first stop starts right under the status row, and the clock is not on My Day", async ({
      page,
    }) => {
      await emulateInsets(page, size.insets);
      await openMyDay(page);

      // The two cards are gone, the chip and the icon that replaced them are
      // gone, and nothing has taken their place.
      await expect(page.locator('section[aria-label="Time clock"]')).toHaveCount(0);
      await expect(page.locator('section[aria-label="Route on the lock screen"]')).toHaveCount(0);
      await expect(page.locator("[data-time-clock]")).toHaveCount(0);
      await expect(page.locator("[data-route-lock-screen]")).toHaveCount(0);
      await expect(page.locator("[data-off-the-clock]")).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^On the clock · / })).toHaveCount(0);

      // My Day scrolls an open job into view on arrival; the question here is
      // about the top of the page.
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(400);

      const geo = await page.evaluate(() => {
        const r = (el: Element | null) => (el ? el.getBoundingClientRect() : null);
        const header = document.querySelector("[data-page-bleed].sticky");
        const first = document.querySelector("ol > li");
        const view = document.querySelector('[role="group"][aria-label="View"]');
        return { view: r(view), header: r(header), first: r(first) };
      });
      expect(geo.first, "no stop card rendered").not.toBeNull();
      // Directly under the status row: the header's own bottom edge, then
      // the list's 16px of top padding, and nothing else.
      expect(
        geo.first!.top - geo.header!.bottom,
        "something sits between the status row and the first stop",
      ).toBeLessThanOrEqual(20);
      expect(geo.view!.right).toBeLessThanOrEqual(size.width);

      const { scrollW } = await measurePageOverflow(page);
      expect(scrollW, "the page scrolls sideways").toBeLessThanOrEqual(size.width);
    });

    test("the time clock is a row in More, which opens the clock sheet", async ({ page }) => {
      await emulateInsets(page, size.insets);
      await openMyDay(page);
      const more = page.locator('[data-tour="more"]');
      const viaMore = await more.isVisible();
      if (viaMore) {
        await more.click();
      } else {
        // No tab bar at this width: the sidebar is the menu, and the row is
        // at its foot.
        const trigger = page.locator('[data-sidebar="trigger"]').first();
        if (await trigger.isVisible()) await trigger.click();
      }
      const row = page.locator("[data-time-clock-row]").filter({ visible: true }).first();
      await expect(row).toBeVisible();
      await expect(row).toContainText("Time clock");
      await expect(row).toContainText(/On the clock · /);
      // The More sheet (or the sidebar) slides in on the motion tokens, and a
      // row measured mid-slide reads a fraction short of its real height:
      // 43.99997px against the 44px floor, once, on the Windows runner. Wait
      // for the menu it sits in to finish moving, the same way the clock
      // sheet is waited for below. Finite animations only, so a spinner
      // cannot hold this forever.
      await row.evaluate((el) => {
        const menu = el.closest('[role="dialog"], [data-sidebar="sidebar"]') ?? document.body;
        return Promise.all(
          menu
            .getAnimations({ subtree: true })
            .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
            .map((a) => a.finished.catch(() => undefined)),
        );
      });
      const rb = (await row.boundingBox())!;
      expect(rb.height, "the Time clock row is under the 44px floor").toBeGreaterThanOrEqual(44);
      await row.click();

      const sheet = page.getByRole("dialog", { name: "Time clock" });
      await expect(sheet).toBeVisible();
      // It slides up on the motion tokens; a box measured mid-slide is not
      // where the button ends up.
      await sheet.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
      await expect(sheet.getByText(/^On the clock since /)).toBeVisible();
      const clockOut = sheet.getByRole("button", { name: "Clock out", exact: true });
      await expect(clockOut).toBeVisible();
      const b = (await clockOut.boundingBox())!;
      expect(b.height, "Clock out is under the 44px floor").toBeGreaterThanOrEqual(44);
      expect(b.y + b.height, "Clock out is under the home indicator").toBeLessThanOrEqual(
        size.height - size.insets.bottom,
      );
      expect(b.x + b.width).toBeLessThanOrEqual(size.width);
    });

    test("off the clock with work today, My Day says so, with Clock in", async ({ page }) => {
      await emulateInsets(page, size.insets);
      await openMyDay(page, { offTheClock: true });
      await page.evaluate(() => window.scrollTo(0, 0));
      const banner = page.locator("[data-off-the-clock]");
      await expect(banner).toBeVisible();
      await expect(banner).toContainText("You're off the clock");
      const clockIn = banner.getByRole("button", { name: "Clock in", exact: true });
      await expect(clockIn).toBeVisible();
      const b = (await clockIn.boundingBox())!;
      expect(b.height).toBeGreaterThanOrEqual(44);
      expect(b.x + b.width).toBeLessThanOrEqual(size.width);
      const bb = (await banner.boundingBox())!;
      expect(bb.x + bb.width).toBeLessThanOrEqual(size.width);
      await expect(page.getByRole("button", { name: /^On the clock · / })).toHaveCount(0);
      const { scrollW } = await measurePageOverflow(page);
      expect(scrollW, "the page scrolls sideways").toBeLessThanOrEqual(size.width);
    });
  });
}

test("the lock-screen switch is not drawn on the web", async ({ page }) => {
  // iPhone app only, like the activity itself. The web has nothing to show
  // on a lock screen, and a switch that does nothing is worse than none.
  await page.setViewportSize({ width: 390, height: 844 });
  await installSignedInSession(page.context());
  await installStubBackend(page.context(), { role: "tech" });
  await page.goto("/settings/preferences", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Preferences" })).toBeVisible({
    timeout: FIRST_PAINT_MS,
  });
  await expect(page.getByText("Haptic feedback")).toBeVisible();
  await expect(page.getByText("Route on the lock screen")).toHaveCount(0);
});
