// Every route on the owner's QA list, opened against a real database.
//
// ── WHAT THIS REPLACES, AND WHAT IT DOES NOT ──────────────────────────────
//
// `docs/owner-qa-checklist.md` has twenty-two items, and ten of them are new
// routes that landed after the list was written on 2026-07-26. They were
// added to it on 2026-09-17 by diffing the route tree against the list, which
// found that three hundred and fifty-five commits of work had never been on
// it at all.
//
// The signed-in viewport sweep already opens twenty surfaces, so why this?
// Because that sweep answers a different question. It runs against
// `fixtures/stub-backend.ts`, which says of itself:
//
//     // Writes. Nothing here writes anywhere
//
// A stub returns the fixture regardless of who asked, so it cannot tell a
// page that works from a page whose query is wrong, a policy that scopes to
// the right tenant from one that scopes to none, or an empty state from a
// broken one. Everything here comes out of Postgres, through RLS, as the
// signed-in owner.
//
// ── THE TWO THINGS EVERY ROUTE IS ASKED ───────────────────────────────────
//
// 1. Did it RENDER, proved by something only that page draws. Not a heading
//    count, not "no error thrown" -- a named thing. The lesson is written
//    into CLAUDE.md twice: assertions of the form "nothing is wrong" all pass
//    on a blank page, and a sweep that measures the login screen twenty times
//    is green and worthless.
//
// 2. Did anything THROW underneath it. The geometry sweeps do not read the
//    console, which is how a React key error ran on every render for weeks
//    while 402 assertions passed. This suite reads it, because a page that
//    looks right and logs a correctness error on every render is not a page
//    that works.

import { expect, test, type Page } from "@playwright/test";

import { pointTheBrowserAtTheLocalDatabase } from "./point-the-browser-at-the-local-database";
import { signIn } from "./sign-in";

test.beforeEach(async ({ context }) => {
  await pointTheBrowserAtTheLocalDatabase(context, {
    url: process.env.SUPABASE_URL ?? "http://127.0.0.1:54421",
    anonKey: process.env.SUPABASE_PUBLISHABLE_KEY ?? "",
  });
});

/**
 * One entry per QA-list route.
 *
 * `proof` is a locator only THAT page draws. Where a page's own copy is
 * generic, the proof is seeded data instead -- which is the stronger of the
 * two anyway, because it cannot be satisfied by the shell rendering.
 */
const ROUTES: Array<{ path: string; qa: string; proof: RegExp }> = [
  { path: "/clients", qa: "Bulk bars: Clients", proof: /client/i },
  { path: "/routes", qa: "Routes: map at Today/Week/Month", proof: /route|today|week/i },
  { path: "/invoices", qa: "Bulk bars: Invoices", proof: /invoice/i },
  { path: "/my-day", qa: "Phone: My Day 7-day strip", proof: /my day|today|stop/i },
  { path: "/neighbors", qa: "Canvassing (landed 2026-09-03)", proof: /neighbo|door|lead|canvass/i },
  { path: "/my-schedule", qa: "My schedule", proof: /schedule|upcoming|day/i },
  { path: "/disputes", qa: "Disputes: a queue that must empty", proof: /dispute/i },
  { path: "/review", qa: "Review queue", proof: /review/i },
  { path: "/pricing-drift", qa: "Who is off the rate card", proof: /pricing|rate card|drift/i },
  { path: "/tax-reports", qa: "Tax reports", proof: /tax|report/i },
  { path: "/profile", qa: "Profile", proof: /profile|photo|name/i },
  { path: "/settings/scheduling", qa: "Settings: scheduling", proof: /schedul/i },
  { path: "/settings/client-portal", qa: "Settings: client portal", proof: /portal/i },
];

/** Noise every app produces, which is not a correctness signal. */
const IGNORABLE =
  /favicon|manifest\.webmanifest|ResizeObserver|Download the React DevTools|\/sw\.js|Failed to load resource.*40[34]/i;

async function openSignedIn(page: Page, path: string) {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !IGNORABLE.test(m.text())) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`uncaught: ${e.message}`));

  await page.goto(path);
  // Settled enough that a query has answered. Not a fixed sleep: the body
  // having real text is the condition, and a page that never gets there
  // fails here rather than passing an assertion about nothing.
  await expect
    .poll(async () => (await page.locator("body").innerText()).trim().length, { timeout: 25_000 })
    .toBeGreaterThan(200);
  return errors;
}

test.describe("every route the QA list names, against real data", () => {
  // Signed in once per test rather than once per file: Playwright gives each
  // test a fresh context, and sharing one would make the order matter.
  for (const { path, qa, proof } of ROUTES) {
    test(`${path} renders and throws nothing — QA: ${qa}`, async ({ page }) => {
      await signIn(page);
      const errors = await openSignedIn(page, path);

      // `.filter({ visible: true })` before `.first()`. Without it, a match in
      // a collapsed nav wins the race and the assertion fails on a page that
      // is drawing the right thing -- which is exactly how
      // /settings/client-portal failed the first time this ran.
      await expect(
        page.getByText(proof).filter({ visible: true }).first(),
        `${path} drew nothing that identifies it. A blank or error page satisfies every ` +
          `"nothing is wrong" assertion, so this asks for something only this page draws.`,
      ).toBeVisible({ timeout: 20_000 });

      expect(errors, `${path} logged errors while looking fine`).toEqual([]);
    });
  }
});

test("the seeded data actually reaches the pages that count it", async ({ page }) => {
  // The fixture is 10 clients, 149 visits, 34 invoices. A page showing an
  // empty state here means the query or the policy is wrong, and that is
  // invisible to a stub which would have returned its fixture either way.
  await signIn(page);

  await page.goto("/clients");
  await expect
    .poll(async () => page.getByRole("row").count(), { timeout: 20_000 })
    .toBeGreaterThan(1);

  await page.goto("/invoices");
  await expect
    .poll(async () => page.getByRole("row").count(), { timeout: 20_000 })
    .toBeGreaterThan(1);
});
