import { test, expect, type Page } from "@playwright/test";

// The four widths named in CLAUDE.md, measured rather than reasoned about.
//
// 360 is the one that matters: "320–360px is a real phone, not an edge case."
// 768 and 1280 bracket the tablet band the working agreement calls out as the
// place layouts with only phone/desktop branches fail. 1920 catches the
// opposite fault — a max-width that was never set.
const WIDTHS = [
  { w: 360, h: 780, label: "360 · a real phone" },
  { w: 768, h: 1024, label: "768 · tablet portrait" },
  { w: 1280, h: 800, label: "1280 · small laptop" },
  { w: 1920, h: 1080, label: "1920 · wide monitor" },
] as const;

// Public routes only. Everything behind /_authenticated needs a session, which
// needs a seeded org in a local Supabase stack — that is the next stage of this
// sweep, not a reason to leave the reachable half unmeasured. Listed explicitly
// rather than crawled so that a route going missing is a failure here.
const ROUTES = [
  "/auth",
  "/get-started",
  "/no-workspace",
  "/legal/privacy",
  "/legal/terms",
  "/legal/sms",
] as const;

/** Let fonts and any entry animation settle before measuring geometry. */
async function settle(page: Page) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await page.waitForTimeout(150);
}

for (const { w, h, label } of WIDTHS) {
  test.describe(label, () => {
    for (const route of ROUTES) {
      test(`${route} does not scroll the page sideways`, async ({ page }) => {
        await page.setViewportSize({ width: w, height: h });
        await page.goto(route);
        await settle(page);

        // THE rule, stated first in the working agreement: "No horizontal page
        // scroll, ever." Wide content scrolls inside its own container; the
        // body does not.
        //
        // Measured on documentElement AND body because either can be the
        // scrolling box depending on overflow styles, and a 1px tolerance is
        // allowed for sub-pixel rounding at fractional device ratios — not for
        // anything a person could see.
        const overflow = await page.evaluate(() => {
          const de = document.documentElement;
          const scrollW = Math.max(de.scrollWidth, document.body.scrollWidth);
          return { scrollW, innerW: window.innerWidth };
        });
        expect(
          overflow.scrollW,
          `${route} at ${w}px scrolls sideways: content is ${overflow.scrollW}px in a ${overflow.innerW}px viewport`,
        ).toBeLessThanOrEqual(overflow.innerW + 1);
      });

      test(`${route} keeps every control on the page`, async ({ page }) => {
        await page.setViewportSize({ width: w, height: h });
        await page.goto(route);
        await settle(page);

        // A control whose right edge is past the viewport is unreachable even
        // when the page itself does not scroll — the overflow rule above can be
        // satisfied by clipping. This is the fault that rule cannot see.
        const escaped = await page.evaluate(() => {
          const out: string[] = [];
          for (const el of document.querySelectorAll("button, a, input, select, textarea")) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) continue;
            if (getComputedStyle(el).visibility === "hidden") continue;
            if (r.right > window.innerWidth + 1 || r.left < -1) {
              out.push(
                `<${el.tagName.toLowerCase()}> "${(el.textContent ?? "").trim().slice(0, 32)}" at x=${Math.round(r.left)}..${Math.round(r.right)}`,
              );
            }
          }
          return out;
        });
        expect(escaped, `${route} at ${w}px has controls off the side of the screen`).toEqual([]);
      });
    }
  });
}

// Touch sizing is a phone-and-tablet rule: hover does not exist there and a
// finger is not a cursor. Above the md breakpoint a 32px icon button is fine,
// so asserting 44px at 1280 would be inventing a rule the product does not have.
test.describe("touch targets below the md breakpoint", () => {
  for (const route of ROUTES) {
    test(`${route} has no control under 44px`, async ({ page }) => {
      await page.setViewportSize({ width: 360, height: 780 });
      await page.goto(route);
      await settle(page);

      // "Touch targets are at least 44px. Not the icon: the button."
      //
      // Scoped to actual controls. An inline link inside a paragraph of legal
      // prose is a word, not a button, and demanding 44px of it would only
      // teach people to add an exception — so anchors are included ONLY when
      // they are styled as buttons or stand alone as a block.
      const small = await page.evaluate(() => {
        const out: string[] = [];
        const controls = document.querySelectorAll(
          "button, select, input:not([type=hidden]), [role=button], a[class*=button], a[data-slot=button]",
        );
        for (const el of controls) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          const cs = getComputedStyle(el);
          if (cs.visibility === "hidden" || cs.display === "none") continue;
          // A checkbox or radio may be a small box with a larger hit area
          // provided by an ancestor label or an out-of-flow pseudo-element —
          // which is exactly the pattern ui/checkbox.tsx uses. Measure the
          // label when there is one.
          const type = (el as HTMLInputElement).type;
          let box = r;
          if (type === "checkbox" || type === "radio") {
            const label = el.closest("label") ?? document.querySelector(`label[for="${el.id}"]`);
            if (label) box = label.getBoundingClientRect();
          }
          if (box.height < 44 - 0.5) {
            out.push(
              `<${el.tagName.toLowerCase()}${type ? ` type=${type}` : ""}> "${(el.textContent ?? "").trim().slice(0, 32)}" is ${box.height.toFixed(1)}px tall`,
            );
          }
        }
        return out;
      });
      expect(small, `${route} at 360px has controls below the 44px floor`).toEqual([]);
    });
  }
});
