import { test, expect, type Page } from "@playwright/test";
import {
  WIDTHS,
  measurePageOverflow,
  findControlsOffTheSide,
  findSilentlyClippedText,
  findControlsUnder44px,
} from "./rules";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend, type StubReport } from "./fixtures/stub-backend";
import { SURFACES, type Surface } from "./fixtures/surfaces";

/**
 * The other half of the browser sweep: the pages you have to be signed in to
 * see.
 *
 * CLAUDE.md, on `every-public-page-at-every-width.spec.ts`:
 *
 *     "It only covers PUBLIC routes. Everything behind /_authenticated needs a
 *      session, so the surfaces docs/mobile-ux-audit.md is actually about are
 *      not in it yet."
 *
 * They are now. Same four widths, same four rules, same browser — the only new
 * thing is a session, and `fixtures/session.ts` explains at length why it is a
 * minted one rather than a real account.
 *
 * ── WHAT IS DIFFERENT FROM THE PUBLIC HALF, AND WHY ───────────────────────
 *
 *   * ONE PAGE LOAD, FOUR RULES. The public sweep loads each route once per
 *     rule. That is affordable for six static pages and it is not affordable
 *     for twenty surfaces that each wait on a dozen queries. So every rule
 *     runs against a single load and the findings are collected, then asserted
 *     together. A pleasant side effect: a failure lists everything wrong with
 *     that page at that width instead of the first thing.
 *
 *   * SURFACES, NOT ROUTES. Three entries in `fixtures/surfaces.ts` are the
 *     same URL with something opened or something switched on. A sweep that
 *     only measures first paint cannot see a floating card, a dialog or a tab
 *     panel — and those are exactly the controls most likely to be built at a
 *     fixed width. `w-80` is 320px; a phone is 360px; the margin for error is
 *     two paddings.
 *
 *   * THE GUARD IS SPECIFIC. See the long note in `fixtures/surfaces.ts`: the
 *     signed-out failure mode here is not a blank page, it is `/auth`, which
 *     is a well-built page that passes every size threshold. Counting elements
 *     cannot tell the two apart. Naming something only this page draws can.
 *
 * ── RUNNING IT ────────────────────────────────────────────────────────────
 *
 *     npm run test:viewports:auth      (this file)
 *     npm run test:viewports           (both halves)
 *
 * No credentials. Nothing to seed. Nothing reaches the network — the fixture
 * intercepts the browser client's own origin (`PUBLIC_SUPABASE_URL`, today
 * `https://api.houndstack.com`) before anything can leave, which is deliberate:
 * that project is production. The origin is imported rather than written out,
 * so activating the custom domain on 2026-08-19 could not leave the stub
 * routing one host while the app called another.
 */

/** Below `md`. Touch sizing is a phone rule; at 768 the `md:` styles are on. */
const TOUCH_WIDTH = 360;

/**
 * One line per DISTINCT fault, with how many elements have it.
 *
 * A table of fifty rows with a 16px icon button in each is one mistake made
 * once, in one component, and printing it fifty times buries the other four
 * findings on the page. The count is kept because "×50" and "×1" are different
 * facts about how much of the screen the fault covers.
 */
function collapse(findings: string[]): string[] {
  const counts = new Map<string, number>();
  for (const f of findings) counts.set(f, (counts.get(f) ?? 0) + 1);
  return [...counts].map(([f, n]) => (n === 1 ? f : `${f}   [×${n}]`));
}

async function settle(page: Page, surface: Surface, widthLabel: string) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await page.waitForTimeout(250);

  const where = `${surface.id} at ${widthLabel}`;

  const health = await page.evaluate(() => ({
    path: location.pathname,
    els: document.querySelectorAll("*").length,
    text: document.body.innerText.trim().length,
    overlay: Boolean(document.querySelector("vite-error-overlay")),
    // TanStack Router's error boundary. A route whose loader threw renders
    // this, and it is a page: it has a heading, two buttons and a message, so
    // it clears any size threshold while containing none of the app.
    boundary: document.body.innerText.includes("Something went wrong"),
  }));

  expect(health.overlay, `${where} rendered a Vite error overlay`).toBe(false);
  expect(
    health.boundary,
    `${where} rendered the router's error boundary instead of the page`,
  ).toBe(false);

  // The signed-out bounce. `_authenticated.beforeLoad` redirects to /auth on a
  // rejected identity and to /no-workspace on an account with no org; both are
  // pages this sweep's public half already proves are well laid out, so
  // measuring one of them would be a green run about the wrong screen.
  expect(
    health.path,
    `${where} ended up on ${health.path} — the session did not take, so what was measured is not this page`,
  ).toBe(surface.path);

  expect(
    health.els,
    `${where} rendered only ${health.els} elements — the page did not render, so every assertion about it would pass vacuously`,
  ).toBeGreaterThan(40);
  expect(
    health.text,
    `${where} rendered only ${health.text} characters of text — the page did not render`,
  ).toBeGreaterThan(200);

  // The two that make this guard about THIS page rather than about any page.
  await expect(
    surface.proof(page).first(),
    `${where}: ${surface.proofLabel} is not on screen, so this is not the surface the test names`,
  ).toBeVisible({ timeout: 15_000 });

  const hasData = await page.evaluate(
    (needle) => document.body.innerText.includes(needle),
    surface.expectsData,
  );
  expect(
    hasData,
    `${where} rendered its chrome but not "${surface.expectsData}" — an empty surface has no layout to measure`,
  ).toBe(true);
}

/** Whatever the surface says has to be opened, plus proof it opened. */
async function openExtras(page: Page, surface: Surface, widthLabel: string) {
  if (!surface.open) return;
  await surface.open(page);
  await page.waitForTimeout(400);
  if (surface.opened) {
    await expect(
      surface.opened(page).first(),
      `${surface.id} at ${widthLabel}: ${surface.openedLabel} never appeared, so the thing this surface exists to measure was not measured`,
    ).toBeVisible({ timeout: 10_000 });
  }
}

for (const { w, h, label } of WIDTHS) {
  test.describe(label, () => {
    for (const surface of SURFACES) {
      test(`${surface.id} is laid out inside ${w}px`, async ({ page, context }) => {
        await installSignedInSession(context, surface.prefs);
        const stubs: StubReport = await installStubBackend(context);

        await page.setViewportSize({ width: w, height: h });
        await page.goto(surface.path);
        await settle(page, surface, label);
        await openExtras(page, surface, label);

        const findings: string[] = [];

        // 1 — "No horizontal page scroll, ever."
        const overflow = await measurePageOverflow(page);
        if (overflow.scrollW > overflow.innerW + 1) {
          findings.push(
            `PAGE SCROLLS SIDEWAYS: content is ${overflow.scrollW}px in a ${overflow.innerW}px viewport`,
          );
        }

        // 2 — a control past the edge is unreachable even without page scroll.
        for (const c of await findControlsOffTheSide(page)) {
          findings.push(`CONTROL OFF THE SIDE: ${c}`);
        }

        // 3 — text clipped with no ellipsis and no scrollbar.
        for (const c of await findSilentlyClippedText(page)) {
          findings.push(`CLIPPED SILENTLY: ${c}`);
        }

        // 4 — touch targets, below md only.
        if (w <= TOUCH_WIDTH) {
          for (const c of await findControlsUnder44px(page)) {
            findings.push(`UNDER THE 44px FLOOR: ${c}`);
          }
        }

        // Say so, loudly, when part of the page came from nothing. An
        // unstubbed server function answers `null`, which usually renders an
        // empty state — the surface still passed its data proof, but a section
        // of it was measured empty and that is worth knowing before anyone
        // reads a green run as full coverage.
        if (stubs.unstubbed.length) {
          const note = `no fixture for: ${stubs.unstubbed.join(", ")}`;
          test.info().annotations.push({ type: "unstubbed", description: note });
          console.warn(`  ⚠ ${surface.id} at ${label} — ${note}`);
        }
        // Same rule for the fence. A host the page reached for is a host the
        // fence answered instead, and whatever it was going to load is not on
        // the screen that was just measured.
        if (stubs.blockedHosts.length) {
          const note = `off-host requests turned back: ${stubs.blockedHosts.join(", ")}`;
          test.info().annotations.push({ type: "fenced", description: note });
        }

        expect(
          collapse(findings),
          `${surface.id} at ${w}px breaks the responsiveness agreement`,
        ).toEqual([]);
      });
    }
  });
}
