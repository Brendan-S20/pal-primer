/**
 * Every browser measurement this repo has ever run was signed in as an owner.
 *
 * ── WHY THAT IS A GAP AND NOT A DETAIL ────────────────────────────────────
 *
 * `getMyProfile` returns `role: "owner"`, hard-coded, and nothing has ever
 * overridden it. So the nav is the owner's nav, `usePermissions` says yes to
 * everything, and every route-level gate in the app is dead code as far as any
 * sweep is concerned. Two of the three people who use this product all day are
 * not owners.
 *
 * The role does not come from the profile, which is where I looked first. It
 * comes from `getMyOrg().organization.role` — a different field on a different
 * call — and four stubs have to agree or the app draws one role's nav around
 * another role's page and measures neither honestly.
 *
 * ── WHAT THIS CAN AND CANNOT PROVE ────────────────────────────────────────
 *
 * It reads `ROUTE_ROLES` and asks the app to agree with it, so it CANNOT tell
 * you the policy is right — that a dispatcher should see `/review` and not
 * `/invoices` is a business decision and no test has an opinion. Said plainly
 * because a test that derived its expectations from the thing it is testing
 * and did not say so would be worse than no test.
 *
 * What it does prove is that the policy is ENFORCED, per path, in a browser,
 * which is the part that actually breaks: a route added without going through
 * the layout that gates it, or a prefix entry ordered so that `/settings`
 * shadows `/settings/billing` — a hazard the constant's own comments already
 * warn about, with nothing checking it.
 *
 * And it proves two things the constant cannot say at all:
 *
 *   - a refused route lands somewhere the role can USE — a dispatcher on
 *     /dashboard, a tech on /my-day — rather than on /auth, which is what a
 *     gate that mistakes "no permission" for "no session" would do, and which
 *     renders perfectly and would pass every layout rule below;
 *   - every page each role IS allowed to open holds together at 430px. That
 *     had never been measured for anyone but the owner.
 */
import { test, expect, type Page } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend, type SweepRole } from "./fixtures/stub-backend";
import { canAccess } from "../../src/hooks/useMyRole";
import {
  measurePageOverflow,
  findControlsOffTheSide,
  findSilentlyClippedText,
  findControlsUnder44px,
} from "./rules";

/** The routes a non-owner might plausibly reach for. Not every route in the
 *  app: the ones with a `$param` need an id, and the platform console is not
 *  reachable by any of these roles by construction. */
const ROUTES = [
  "dashboard",
  "leads",
  "clients",
  // Zones & pricing is inside Settings since #864; /zones only forwards here.
  "settings/zones",
  "routes",
  "my-day",
  "waste-log",
  "messages",
  "notifications",
  "concerns",
  "inventory",
  "invoices",
  "onboarding",
  "reports",
  "tax-reports",
  "disputes",
  "analytics",
  "review",
  "franchise",
  "imports",
  "profile",
  "help",
  "neighbors",
  "dna",
  "payments",
];

/** Where each role is sent when it asks for something it may not have. Both
 *  are pages that role can use; neither is /auth. */
const LANDING: Record<string, string> = {
  dispatcher: "/dashboard",
  tech: "/my-day",
};

async function signInAs(page: Page, role: SweepRole) {
  await installSignedInSession(page);
  await installStubBackend(page, { role });
}

// ── ONE NAVIGATION, EITHER SIDE OF EACH EDGE ─────────────────────────────
//
// Reported 2026-09-27 at 768px: the sidebar AND the tab bar. The tab bar
// reaches `lg` for a tech (useTabletTier) and the sidebar docked at `md`
// regardless, so 768–1023 had both — for a tech only, which is why a sweep
// that was only ever an owner never saw it. tests/two-navigations-at-768.test.ts
// checks the arithmetic; this checks that the browser agrees with it, at the
// pixel either side of each breakpoint.
for (const role of ["dispatcher", "tech"] as const) {
  test.describe(`signed in as a ${role}, exactly one navigation`, () => {
    for (const width of [767, 768, 1023, 1024]) {
      test(`@${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await signInAs(page, role);
        await page.goto(LANDING[role], { waitUntil: "domcontentloaded" });
        // Something has to be drawn before "not both" means anything: a blank
        // page has neither.
        const bar = page.getByRole("navigation", { name: "Primary" }).first();
        const docked = page.locator('[data-sidebar="sidebar"]:not([data-mobile])').first();
        await expect(bar.or(docked).first()).toBeVisible({ timeout: 30_000 });
        await page.waitForTimeout(700);
        const shown = { bar: await bar.isVisible(), sidebar: await docked.isVisible() };
        expect(shown, `${role} @${width}px`).not.toEqual({ bar: true, sidebar: true });
        expect(shown.bar || shown.sidebar, `${role} @${width}px: no navigation`).toBe(true);
      });
    }
  });
}

for (const role of ["dispatcher", "tech"] as const) {
  test.describe(`signed in as a ${role}`, () => {
    test.use({ viewport: { width: 430, height: 932 }, isMobile: true, deviceScaleFactor: 2 });

    test("the role actually took", async ({ page }) => {
      // Without this the whole file is a second owner sweep wearing a label.
      // A tech cannot open /invoices; an owner can. If the override silently
      // stopped working, this is the assertion that says so rather than
      // twenty-five green measurements of the wrong account.
      await signInAs(page, role);
      await page.goto("/invoices", { waitUntil: "domcontentloaded" });
      // Polled, not slept. The gate runs in `beforeLoad` after the route's
      // chunk resolves, and on a cold dev server that is several seconds --
      // a fixed wait here failed while the identical assertion below passed,
      // purely because the second one ran against a warm module graph.
      await expect
        .poll(() => new URL(page.url()).pathname, {
          timeout: 30_000,
          message: `a ${role} reached /invoices`,
        })
        .toBe(LANDING[role]);
    });

    for (const route of ROUTES) {
      const allowed = canAccess(role, `/${route}`);

      test(`/${route} — ${allowed ? "opens" : "is refused"}`, async ({ page }) => {
        await signInAs(page, role);
        await page.goto(`/${route}`, { waitUntil: "domcontentloaded" });

        if (!allowed) {
          await expect
            .poll(() => new URL(page.url()).pathname, {
              timeout: 30_000,
              message:
                `a ${role} asking for /${route} should land on ${LANDING[role]}. ` +
                `/auth in particular would mean the gate confused "no permission" ` +
                `with "no session" — and /auth passes every layout rule there is.`,
            })
            .toBe(LANDING[role]);
          return;
        }

        // The mobile tab bar, by its landmark name rather than its contents:
        // a tech's bar is three tabs (Today / Schedule / More) and has no
        // "Home" in it at all, so a content-matched locator is an owner-shaped
        // guard that reports a tech's pages as unrendered. /auth's only <nav>
        // is an unnamed legal footer, so this still separates the two.
        await expect(page.getByRole("navigation", { name: "Primary" }).first()).toBeVisible({
          timeout: 30_000,
        });
        await page.waitForTimeout(700);
        expect(
          new URL(page.url()).pathname,
          `a ${role} was refused /${route}, which ROUTE_ROLES allows`,
        ).toBe(`/${route}`);

        const { scrollW, innerW } = await measurePageOverflow(page);
        expect(scrollW, `${role} /${route}: page scrolls sideways`).toBeLessThanOrEqual(innerW + 1);
        expect(await findControlsOffTheSide(page), `${role} /${route}`).toEqual([]);
        expect(await findSilentlyClippedText(page), `${role} /${route}`).toEqual([]);
        expect(await findControlsUnder44px(page), `${role} /${route}`).toEqual([]);
      });
    }
  });
}
