/**
 * My Day in Arabic and in Simplified Chinese, measured on phones and iPads,
 * with touch on.
 *
 * ── WHY IT NEEDS ITS OWN SPEC ─────────────────────────────────────────────
 *
 * a-tech-who-reads-spanish measures the page in a language that is LONGER
 * than English. These two break it in different ways:
 *
 *   * Arabic is RIGHT TO LEFT. Everything a sweep in English proves about
 *     "nothing past the right edge" is a statement about the wrong edge: in
 *     Arabic the leading side is the right, overflow goes out of the LEFT, a
 *     gap written `ml-2` lands on the wrong side of its word, and the docked
 *     sidebar belongs on the right of the screen. lib/i18n puts dir="rtl" on
 *     <html>; this proves it is there, and that the page laid out under it
 *     still fits.
 *   * Chinese is SHORT and has no spaces. A label that wraps at a space in
 *     English has nowhere to wrap in Chinese, so a row can overflow with
 *     fewer characters than it held in English.
 *
 * ── HOW THE LANGUAGE GETS IN ──────────────────────────────────────────────
 *
 * The same way it does on a real phone: Settings → Preferences writes
 * `scoop.lang` to localStorage, and lib/i18n reads it before the first render.
 * An init script writes it before the app's first script runs.
 *
 * ── THE SIZES, AND WHY TOUCH IS ON FOR ALL OF THEM ────────────────────────
 *
 * 320 (the narrowest phone still on current iOS), 360 (the working
 * agreement's phone), 768, and the five iPad sizes — mini and Air portrait,
 * Pro portrait, Air and Pro landscape. Touch is on at every one, because a
 * technician's device is a phone or a crew tablet and both are driven by a
 * finger: with `hasTouch` Chromium reports `pointer: coarse`, the `touch:`
 * variant applies, and the 44px floor is asserted at every width rather than
 * only below `md`. The sizes are written out here rather than taken from the
 * shared device list so this file does not branch on the sweep's environment
 * variable — it is one configuration, always.
 *
 * On touch a tech keeps the tab bar at every width and has no docked
 * sidebar, iPad landscape included (useTabletTier, QA row 35). The sidebar
 * docks for a tech only from 1024px with a mouse, so one Arabic case at
 * 1280×800 turns touch off to prove it sits on the right there.
 *
 * ── WHAT PROVES IT RENDERED, AND IN THE RIGHT LANGUAGE ────────────────────
 *
 * As with every signed-in surface: something only the page draws, in the
 * language under test (the heading — "يومي" / "我的一天", where English would
 * say "My day"), and something only the fixture holds (a client's name). A
 * green run against /auth, or against My Day in English, would be worthless
 * and look the same.
 */
import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import { FIRST_PAINT_MS } from "./fixtures/first-paint";
import {
  measurePageOverflow,
  findControlsOffTheSide,
  findSilentlyClippedText,
  findControlsUnder44px,
} from "./rules";

test.use({ hasTouch: true });

const SIZES = [
  { w: 320, h: 568, label: "320×568 · smallest iPhone" },
  { w: 360, h: 780, label: "360×780 · a real phone" },
  { w: 768, h: 1024, label: "768×1024 · tablet portrait" },
  { w: 744, h: 1133, label: "744×1133 · iPad mini portrait" },
  { w: 820, h: 1180, label: "820×1180 · iPad Air portrait" },
  { w: 1024, h: 1366, label: "1024×1366 · iPad Pro portrait" },
  { w: 1180, h: 820, label: "1180×820 · iPad Air landscape" },
  { w: 1366, h: 1024, label: "1366×1024 · iPad Pro landscape" },
] as const;

const LANGS = {
  ar: {
    dir: "rtl",
    htmlLang: "ar",
    heading: "يومي",
    navigate: "ملاحة",
    moreOptions: "خيارات أكثر",
    skip: "تخطي",
    confirmSkip: "تأكيد التخطي",
    sendOnMyWay: "إرسال «أنا في الطريق»",
  },
  zh: {
    dir: "ltr",
    htmlLang: "zh-Hans",
    heading: "我的一天",
    navigate: "导航",
    moreOptions: "更多选项",
    skip: "跳过",
    confirmSkip: "确认跳过",
    sendOnMyWay: "发送“我在路上”",
  },
} as const;

/** English a tech used to read on this page. Seeing any of these means a
 *  string escaped t() at run time, through a variable the static rule cannot
 *  follow, or that the language's file has no answer for a key and i18next
 *  fell back to English. */
const ENGLISH_THAT_WAS_THERE = [
  "My day",
  "More options",
  "Take photo",
  // The card's one button at its photo step (src/lib/visit-step.ts).
  "Take completion photo",
  "Navigate",
  "Off the clock",
  "On the clock",
  "Safety warnings",
  "Clock in",
  "Next up",
  "Waste log",
  "Directions",
  "Complete",
  // The sidebar (docked for a tech from 1024px with a mouse, and the sheet
  // behind More otherwise): an entry added with no key showed its English
  // title in every language.
  "Expenses",
];

async function openMyDay(
  page: Page,
  context: BrowserContext,
  lng: keyof typeof LANGS,
  size: { w: number; h: number },
) {
  await page.setViewportSize({ width: size.w, height: size.h });
  await context.addInitScript((lang: string) => {
    try {
      window.localStorage.setItem("scoop.lang", lang);
    } catch {
      // A blocked storage would leave the page in English, which the heading
      // assertion below reports by name.
    }
  }, lng);
  await installSignedInSession(context);
  await installStubBackend(context, { role: "tech" });
  await page.goto("/my-day");
  await page.waitForLoadState("networkidle").catch(() => {});
  await expect(page.getByRole("heading", { name: LANGS[lng].heading, exact: true })).toBeVisible({
    timeout: FIRST_PAINT_MS,
  });
  await expect(page.getByText("Anastasia Vandermolen-Whitaker").first()).toBeVisible();
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await page.waitForTimeout(250);
}

/** The docked sidebar, the tab bar, and the left edge of each tab in DOM
 *  order. The tab bar is the `<nav>` MobileTabBar marks `data-vt="tabbar"`;
 *  NEXT UP also carries `data-bottom-chrome`, so that attribute alone cannot
 *  tell the two apart. */
async function readNavigation(page: Page) {
  return page.evaluate(() => {
    const sidebar = [...document.querySelectorAll<HTMLElement>("[data-sidebar=sidebar]")]
      .map((el) => el.getBoundingClientRect())
      .find((r) => r.width > 40 && r.height > 200);
    const tabBarEl = document.querySelector<HTMLElement>('nav[data-vt="tabbar"]');
    const tabBarRect = tabBarEl?.getBoundingClientRect();
    const tabBar = tabBarRect && tabBarRect.width > 0 ? tabBarRect.toJSON() : null;
    const tabs = tabBar
      ? [...tabBarEl!.querySelectorAll(":scope > ul > li")].map(
          (li) => li.getBoundingClientRect().left,
        )
      : [];
    const nextUp = [...document.querySelectorAll<HTMLElement>("[data-bottom-chrome]")]
      .filter((el) => el !== tabBarEl)
      .map((el) => el.getBoundingClientRect())
      .find((r) => r.width > 0);
    return {
      vw: document.documentElement.clientWidth,
      sidebar: sidebar ? { left: sidebar.left, right: sidebar.right } : null,
      tabBar: tabBar as { left: number; right: number } | null,
      tabs,
      nextUp: nextUp ? { left: nextUp.left, right: nextUp.right } : null,
    };
  });
}

async function measure(page: Page, where: string) {
  const { scrollW, innerW } = await measurePageOverflow(page);
  expect(scrollW, `${where}: the page scrolls sideways`).toBeLessThanOrEqual(innerW + 1);
  expect(await findControlsOffTheSide(page), `${where}: controls off the screen`).toEqual([]);
  expect(await findSilentlyClippedText(page), `${where}: text clipped`).toEqual([]);
  // Touch is on at every size, so the floor applies at every size.
  expect(await findControlsUnder44px(page), `${where}: under 44px`).toEqual([]);
}

for (const lng of ["ar", "zh"] as const) {
  const L = LANGS[lng];
  for (const size of SIZES) {
    test(`My Day in ${lng} fits at ${size.label}`, async ({ page, context }) => {
      await openMyDay(page, context, lng, size);

      // The document says which language it is in, and which way it reads.
      const doc = await page.evaluate(() => ({
        dir: document.documentElement.getAttribute("dir"),
        lang: document.documentElement.getAttribute("lang"),
        computed: getComputedStyle(document.body).direction,
      }));
      expect(doc).toEqual({ dir: L.dir, lang: L.htmlLang, computed: L.dir });

      await measure(page, `/my-day (${lng}) @${size.label}`);

      const text = await page.evaluate(() => document.body.innerText);
      expect(text).toContain(L.navigate);
      expect(text).toContain(L.moreOptions);
      const leftover = ENGLISH_THAT_WAS_THERE.filter((w) => text.includes(w));
      expect(leftover, `English still on My Day (${lng}) @${size.label}`).toEqual([]);

      // A touch screen at any width: the tech keeps the phone's tab bar and
      // gets no docked sidebar, iPad landscape included (useTabletTier, QA
      // row 35). Two navigations, or none, is the fault this guards.
      const nav = await readNavigation(page);
      expect(nav.sidebar, "a technician on a touch screen has no docked sidebar").toBeNull();
      expect(nav.tabBar, "a technician on a touch screen keeps the tab bar").not.toBeNull();
      expect(nav.tabBar!.left, "the tab bar starts at the screen's edge").toBeLessThanOrEqual(1);
      expect(nav.tabBar!.right, "the tab bar reaches the screen's edge").toBeGreaterThanOrEqual(
        nav.vw - 1,
      );

      if (lng === "ar") {
        // Mirrored, not merely translated: the first tab (Today) leads, so in
        // Arabic it is the right-most of the four.
        expect(nav.tabs.length, "found the tab bar's four tabs").toBe(4);
        expect(nav.tabs[0], "Today is the right-most tab in Arabic").toBeGreaterThan(
          Math.max(...nav.tabs.slice(1)),
        );
        // And within a card: the stop number leads the address, so in
        // Arabic it is to the RIGHT of it.
        const order = await page.evaluate(() => {
          const card = document.querySelector('[id^="visit-"]');
          const badge = card?.querySelector("div.h-10.w-10");
          const address = badge?.nextElementSibling;
          if (!badge || !address) return null;
          return {
            badge: badge.getBoundingClientRect().left,
            address: address.getBoundingClientRect().left,
          };
        });
        expect(order, "found a card's stop number and address").not.toBeNull();
        expect(order!.badge, "the stop number sits at the right of its card").toBeGreaterThan(
          order!.address,
        );
      }
    });
  }

  if (lng === "ar") {
    // The one place a tech has a docked sidebar: from 1024px with a mouse,
    // the laptop in the office. It is on the right in Arabic, and NEXT UP
    // stops at it instead of running under it. Touch is off, so the 44px
    // floor (a touch rule) is not asserted here.
    test.describe("with a mouse", () => {
      test.use({ hasTouch: false });
      test(`My Day in ar docks the sidebar on the right at 1280×800 with a mouse`, async ({
        page,
        context,
      }) => {
        await openMyDay(page, context, lng, { w: 1280, h: 800 });
        const where = `/my-day (ar, mouse) @1280×800`;
        const { scrollW, innerW } = await measurePageOverflow(page);
        expect(scrollW, `${where}: the page scrolls sideways`).toBeLessThanOrEqual(innerW + 1);
        expect(await findControlsOffTheSide(page), `${where}: controls off the screen`).toEqual([]);
        expect(await findSilentlyClippedText(page), `${where}: text clipped`).toEqual([]);

        const nav = await readNavigation(page);
        expect(nav.tabBar, "with a mouse from 1024px the tab bar is hidden").toBeNull();
        expect(nav.sidebar, "with a mouse from 1024px a technician's sidebar docks").not.toBeNull();
        expect(
          Math.round(nav.sidebar!.right),
          "the docked sidebar is on the right in Arabic",
        ).toBeGreaterThanOrEqual(nav.vw - 1);
        if (nav.nextUp) {
          expect(
            nav.nextUp.right,
            "NEXT UP stops at the sidebar instead of running under it",
          ).toBeLessThanOrEqual(nav.sidebar!.left + 1);
        }
      });
    });
  }

  // The longest strings live behind "More options" and the skip panel. Two
  // sizes — the narrowest phone and the narrowest iPad — open them all and
  // measure again.
  for (const size of [SIZES[0], SIZES[3]]) {
    test(`the folded-away actions fit in ${lng} at ${size.label}`, async ({ page, context }) => {
      await openMyDay(page, context, lng, size);
      const more = page.getByRole("button", { name: L.moreOptions });
      const n = await more.count();
      expect(n, `no card offered ${L.moreOptions} — nothing to open`).toBeGreaterThan(0);
      for (let i = 0; i < n; i += 1) await more.nth(0).click();
      const skip = page.getByRole("button", { name: L.skip, exact: true });
      if ((await skip.count()) > 0) await skip.first().click();
      await page.waitForTimeout(250);

      await expect(page.getByText(L.sendOnMyWay).first()).toBeVisible();
      await expect(page.getByRole("button", { name: L.confirmSkip })).toBeVisible();
      await measure(page, `/my-day (${lng}, options open) @${size.label}`);

      const text = await page.evaluate(() => document.body.innerText);
      const leftover = ENGLISH_THAT_WAS_THERE.filter((w) => text.includes(w));
      expect(leftover, `English behind More options (${lng}) @${size.label}`).toEqual([]);
    });
  }
}
