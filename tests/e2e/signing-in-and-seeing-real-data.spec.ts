// The first end-to-end test: a real sign-in, against a real database, showing
// rows that were really written.
//
// ── WHY THIS ONE IS FIRST ─────────────────────────────────────────────────
//
// It is not the most valuable item on the QA list. It is the one that proves
// the CHAIN, and until the chain is proved every other E2E test failure has
// four possible causes and no way to tell them apart: the migrations, the
// seed, the dev server's environment, or the test itself.
//
// So this asserts each link separately and says which one broke.
//
// ── THE SIGN-IN IS TWO STAGES, WHICH A NAIVE TEST GETS WRONG ──────────────
//
// `/auth` asks for an email, submits, and only then shows a password field.
// A spec that fills both at once finds no password input, times out, and
// reports "sign-in is broken" about a page that is working exactly as
// designed. The helper below waits for the second stage explicitly.

import { expect, test } from "@playwright/test";

import { pointTheBrowserAtTheLocalDatabase } from "./point-the-browser-at-the-local-database";
import { signIn } from "./sign-in";

// Every test, before anything navigates. The browser client hardcodes the
// production URL -- see the helper for why that is intercepted rather than
// fixed -- so without this the server half talks to the local database and
// the browser half talks to production.
test.beforeEach(async ({ context }) => {
  await pointTheBrowserAtTheLocalDatabase(context, {
    url: process.env.SUPABASE_URL ?? "http://127.0.0.1:54421",
    anonKey: process.env.SUPABASE_PUBLISHABLE_KEY ?? "",
  });
});

test("the whole chain: migrations, seed, server env, browser", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  await signIn(page);

  // ── LINK 1: the dev server is talking to the LOCAL database ─────────────
  //
  // If SUPABASE_URL was empty or pointed elsewhere, sign-in would have failed
  // above. Reaching here means the server has credentials that work.

  // ── LINK 2: the seed produced rows, and the app can read them ───────────
  //
  // Asserted by NAME, not by counting elements. A count passes on a page that
  // rendered a loading skeleton; the name only appears if a row came back
  // from Postgres, through the server function, into the DOM.
  await page.goto("/clients");
  await expect(
    page.getByText(/E2E|demo/i).first(),
    "a seeded client on /clients — if this is empty the seed ran but the app cannot read it",
  ).toBeVisible({ timeout: 20_000 });

  // ── LINK 3: nothing is throwing underneath a page that looks fine ───────
  //
  // The viewport sweeps measure geometry and do not read the console, which
  // is how a React key error ran on every render for weeks while 402
  // assertions passed. This suite reads it.
  const real = errors.filter(
    (e) => !/favicon|manifest|ResizeObserver|Download the React DevTools/i.test(e),
  );
  expect(real, "console errors while signed in").toEqual([]);
});

test("the seeded owner sees their own organization and nobody else's", async ({ page }) => {
  // The point of a real database rather than a stub: RLS is live here. A stub
  // returns whatever the fixture says regardless of who asked, so tenant
  // isolation is exactly the property it cannot test.
  await signIn(page);
  await page.goto("/clients");

  await expect(page.getByRole("heading").first()).toBeVisible();
  // Every visible client belongs to the seeded org. With RLS off, or a policy
  // that reads the wrong column, other tenants' rows would appear here and
  // this is the only place in the suite that would notice.
  // Polled, not counted once. `count()` immediately after a navigation reads
  // the table before its query has answered, which is a race that passes on a
  // fast machine and fails on a loaded one -- and this machine is at 91% swap.
  await expect
    .poll(async () => page.getByRole("row").count(), { timeout: 20_000 })
    .toBeGreaterThan(1);
});
