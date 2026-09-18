// A tour step may not point at a route that redirects.
//
// ── WHAT HAPPENED ─────────────────────────────────────────────────────────
//
// The guided tour navigates to the area each step describes. Its effect was
// guarded the obvious way:
//
//     if (!step?.route || pathname === step.route) return;
//     void navigate({ to: step.route });
//
// which quietly assumes the router ends up where it was sent. `/settings` does
// not: `settings.index.tsx` throws `redirect({ to: "/settings/preferences" })`
// in `beforeLoad`. So the tour navigated to `/settings`, landed on
// `/settings/preferences`, compared that to `/settings`, found them different,
// and navigated again — for ever. The app rendered a blank white screen.
//
// iOS QA caught it on 2026-08-21 only because the automation screenshots every
// step: steps 1-7 have a mean pixel value around 145 (dimmed overlay over real
// content) and step 8 is 254, which is nothing but a status bar. Without those
// screenshots the run would have looked like a single flaky assertion.
//
// ── WHY THIS TEST AND NOT JUST THE FIX ────────────────────────────────────
//
// The effect is now keyed on a `useRef` of the step index, so it navigates once
// per step and CANNOT loop regardless of where the router ends up. That is the
// real fix and it makes this class of fault non-fatal.
//
// This test guards the other half, which the ref does not address: a step
// pointing at a redirecting route still highlights the wrong thing. The card
// says "Settings" while the spotlight and the URL are somewhere the step never
// named. Cheap to check, and it is the kind of thing that comes back — routes
// grow index redirects long after the tour that points at them was written.
//
// It also checks the routes EXIST. A typo in a tour step is otherwise a 404
// discovered by a customer on their first ever minute in the product.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { repoRelative } from "./support/repo-paths";

const ROOT = resolve(__dirname, "..");
const TOUR = resolve(ROOT, "src/components/OnboardingTour.tsx");

/** Every `route: "…"` in the tour's step list. */
function tourRoutes(): string[] {
  const src = readFileSync(TOUR, "utf8");
  const steps = src.slice(src.indexOf("const ALL_STEPS"), src.indexOf("function rectFor"));
  return [...steps.matchAll(/^\s*route:\s*"([^"]+)"/gm)].map((m) => m[1]);
}

/** The route files TanStack's file-based routing would match for a pathname.
 *  `/settings/preferences` → `settings.preferences.tsx`; a bare segment may
 *  also be served by `<segment>.index.tsx` under a layout of the same name. */
function routeFilesFor(pathname: string): string[] {
  const flat = pathname.replace(/^\//, "").replace(/\//g, ".");
  return [`${flat}.tsx`, `${flat}.index.tsx`]
    .map((f) => resolve(ROOT, "src/routes/_authenticated", f))
    .filter((f) => existsSync(f));
}

describe("the guided tour's steps point at pages that exist and stay put", () => {
  const routes = tourRoutes();

  it("finds the step list at all", () => {
    // If this fails the parse above has drifted and every assertion below is
    // vacuously true — which is exactly the failure mode this whole file is about.
    expect(routes.length).toBeGreaterThanOrEqual(5);
  });

  it.each(routes)("%s is a real route", (route) => {
    expect(
      routeFilesFor(route),
      `no route file for the tour's "${route}" — the first step of someone's ` +
        `first session would 404`,
    ).not.toHaveLength(0);
  });

  it.each(routes)("%s does not redirect somewhere else", (route) => {
    for (const file of routeFilesFor(route)) {
      const src = readFileSync(file, "utf8");
      // Only `beforeLoad`/`loader` redirects relocate the pathname on arrival.
      // A `redirect` inside a component's event handler is someone clicking
      // something and is none of this test's business.
      const head = src.slice(0, src.indexOf("component:") + 1 || src.length);
      expect(
        /throw\s+redirect\s*\(/.test(head),
        `the tour sends people to "${route}", but ${repoRelative(file, ROOT)} ` +
          `redirects away from it on load. Point the step at the destination ` +
          `instead: the card names one area while the URL and the spotlight ` +
          `are on another.`,
      ).toBe(false);
    }
  });
});
