import { test, expect, type Page } from "@playwright/test";
import {
  WIDTHS,
  APPLE_SIZES,
  measurePageOverflow,
  findControlsOffTheSide,
  findSilentlyClippedText,
  findControlsUnder44px,
} from "./rules";
import { installStubBackend } from "./fixtures/stub-backend";
import { PORTAL_SLUG, QUOTE_ONLY_HEADLINE, QUOTE_ONLY_SLUG } from "./fixtures/portal-dataset";

// The four widths named in CLAUDE.md, and the four measurements themselves,
// now live in `./rules.ts` — because there is a second sweep,
// `every-signed-in-page-at-every-width.spec.ts`, and two definitions of "no
// horizontal page scroll" would drift the first time one of them was fixed.
//
// Nothing about what this file checks changed in that move: the thresholds,
// the exclusions and the wording of every failure below are the ones it
// shipped with, and the reasoning that produced them travelled with the code
// into `rules.ts` rather than being left behind here.

// Public routes only. Everything behind /_authenticated needs a session, which
// the sibling spec mints without one — see `fixtures/session.ts` there. Listed
// explicitly rather than crawled so that a route going missing is a failure here.
const UNSTUBBED = [
  "/auth",
  "/get-started",
  "/no-workspace",
  "/legal/privacy",
  "/legal/terms",
  "/legal/sms",
] as const;

// A business's one public form, /signup/{slug}: the lead form and the online
// signup merged into it on 2026-10-08, and /lead/{slug} now forwards here.
// Its lookup is a server function that would otherwise reach a real
// database, so these two answer from the stub backend (which also fences the
// network and answers the quote request's POST), and each proves it rendered
// with text only its fixture puts on the page: a blank page, or the
// "This page isn't available" card, would otherwise clear the size guard.
// Two states: a business that sells online (price and card on offer) and one
// that only takes quote requests.
const STUBBED: Record<string, string> = {
  [`/signup/${PORTAL_SLUG}`]: "Get instant price",
  [`/signup/${QUOTE_ONLY_SLUG}`]: QUOTE_ONLY_HEADLINE,
};

const ROUTES = [...UNSTUBBED, ...Object.keys(STUBBED)];

const stubbed = new WeakSet<Page>();
async function open(page: Page, route: string) {
  if (route in STUBBED && !stubbed.has(page)) {
    await installStubBackend(page as any, { portal: true });
    stubbed.add(page);
  }
  await page.goto(route);
}

/**
 * Wait for fonts and entry animation, then REFUSE TO MEASURE A PAGE THAT DID
 * NOT RENDER.
 *
 * ── WHY THIS GUARD EARNS ITS PLACE ────────────────────────────────────────
 *
 * Every assertion in this file is of the form "nothing is wrong". On a blank
 * page they are all true. So a route that fails to render does not fail the
 * sweep — it passes it, in full, silently, which is the single worst thing a
 * check like this can do.
 *
 * That is not hypothetical. While developing the clipping rule below, a
 * mutation was injected as a second JSX root, which is a syntax error; the dev
 * server served an error page, and the sweep went green against it for several
 * runs. It also made an EARLIER mutation look successful for the wrong reason:
 * the overflow it "caught" was the error page's layout, not the injected block.
 * The check was measuring the absence of the app.
 *
 * Healthy renders of these six routes, measured at 360px: 71–116 elements and
 * 316–3923 characters. The error page had 116 characters and almost no
 * structure. The thresholds below sit well clear of both, and the explicit
 * overlay check catches the dev-server case by name rather than by size.
 *
 * A size threshold is enough HERE and is not enough for the signed-in half,
 * where the failure mode is a redirect to a page that renders perfectly. See
 * the note in `fixtures/surfaces.ts`.
 */
async function settle(page: Page, route: string) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await page.waitForTimeout(150);

  const health = await page.evaluate(() => ({
    els: document.querySelectorAll("*").length,
    text: document.body.innerText.trim().length,
    overlay: Boolean(document.querySelector("vite-error-overlay")),
  }));
  expect(health.overlay, `${route} rendered a Vite error overlay`).toBe(false);
  if (route in STUBBED) {
    await expect(page.getByText(STUBBED[route]).first(), `${route} did not draw its fixture`).toBeVisible({
      timeout: 30_000,
    });
  }
  expect(
    health.els,
    `${route} rendered only ${health.els} elements — the page did not render, so every assertion about it would pass vacuously`,
  ).toBeGreaterThan(40);
  expect(
    health.text,
    `${route} rendered only ${health.text} characters of text — the page did not render`,
  ).toBeGreaterThan(200);
}

const APPLE = process.env.APPLE_SIZES === "1";
const SIZES = APPLE ? APPLE_SIZES : WIDTHS;

// `hasTouch` makes Chromium report `pointer: coarse` and `hover: none`, which
// is what the `touch:` variant in src/styles.css keys on. Without it the Apple
// pass measures real device sizes with a cursor, which is the exact blind spot
// that let 105 iPad failures read as 382 passed on 2026-08-21.
test.use({ hasTouch: APPLE });

for (const { w, h, label } of SIZES) {
  test.describe(label, () => {
    for (const route of ROUTES) {
      test(`${route} does not scroll the page sideways`, async ({ page }) => {
        await page.setViewportSize({ width: w, height: h });
        await open(page, route);
        await settle(page, route);

        // THE rule, stated first in the working agreement: "No horizontal page
        // scroll, ever." Wide content scrolls inside its own container; the
        // body does not. A 1px tolerance is allowed for sub-pixel rounding at
        // fractional device ratios — not for anything a person could see.
        const overflow = await measurePageOverflow(page);
        expect(
          overflow.scrollW,
          `${route} at ${w}px scrolls sideways: content is ${overflow.scrollW}px in a ${overflow.innerW}px viewport`,
        ).toBeLessThanOrEqual(overflow.innerW + 1);
      });

      test(`${route} keeps every control on the page`, async ({ page }) => {
        await page.setViewportSize({ width: w, height: h });
        await open(page, route);
        await settle(page, route);

        const escaped = await findControlsOffTheSide(page);
        expect(escaped, `${route} at ${w}px has controls off the side of the screen`).toEqual([]);
      });
    }
  });
}

// The fault CLAUDE.md calls unenforceable — true of parsing, not of measuring.
// The rule, its three exclusions and the story of the 154px false positive are
// all in `rules.ts`, above `findSilentlyClippedText`.
test.describe("nothing is cut off with no way to read it", () => {
  for (const { w, h, label } of SIZES) {
    test(`${label} clips nothing silently`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      const found: string[] = [];
      for (const route of ROUTES) {
        await open(page, route);
        await settle(page, route);
        for (const c of await findSilentlyClippedText(page)) found.push(`${route}  ${c}`);
      }
      expect(found, `text is cut off with no ellipsis and no scrollbar`).toEqual([]);
    });
  }
});

// Touch sizing is a rule about the POINTER, not about the screen. On the
// canonical widths, width is the only signal there is, so this asserts at
// 360 and leaves a 32px icon button alone at 1280.
//
// The Apple pass has the other signal. `hasTouch` is on, every size in the
// list is a device somebody holds, and an iPad Pro at 1366px is driven by
// the same finger as a 320px phone. So the floor applies at all of them.
//
// This block ran at a hardcoded 360px and nowhere else until 2026-09-17,
// under a comment reasoning that "asserting 44px at 1280 would be inventing
// a rule the product does not have". That is the reasoning
// `docs/ipad-was-never-measured.md` exists to refute — 744 to 1366px is an
// iPad and all of it is touch — and it is the same shape as the comment
// above #207's class list, which named `touch:` and then argued itself out
// of it. The signed-in sweep had already been fixed to run the floor at
// every Apple size; this half had not, so the public routes were measured
// at iPad sizes with a mouse.
test.describe("touch targets", () => {
  const sizes = APPLE ? APPLE_SIZES : [{ w: 360, h: 780, label: "360×780" }];
  for (const { w, h, label } of sizes) {
    for (const route of ROUTES) {
      test(`${route} has no control under 44px at ${label}`, async ({ page }) => {
        await page.setViewportSize({ width: w, height: h });
        await open(page, route);
        await settle(page, route);

        const small = await findControlsUnder44px(page);
        expect(small, `${route} at ${w}px has controls below the 44px floor`).toEqual([]);
      });
    }
  }
});
