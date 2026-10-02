// A second Playwright project, because these tests are the opposite of the
// other ones.
//
// ── WHY NOT JUST ADD A DIRECTORY TO playwright.config.ts ──────────────────
//
// The sweeps in `tests/viewports/` are fast, parallel, and deliberately
// hermetic: every request is answered by `fixtures/stub-backend.ts`, with a
// network fence that turns back anything not on localhost. They measure
// geometry, they never write, and they can run anywhere with no services up.
//
// These need a Postgres with 325 migrations in it, they write, and they must
// run one at a time against shared state. Sharing a config would mean one
// file's `fullyParallel` and `webServer` had to be right for both, and the
// first person to tune it for one would quietly break the other.
//
// ── WHAT THIS COVERS THAT NOTHING ELSE CAN ────────────────────────────────
//
// `docs/owner-qa-checklist.md` has twenty-two items and almost all of them are
// round trips: change a value, refresh, confirm it stuck. Take a payment, see
// the invoice flip. Work a queue, see it empty. A stub that cannot write can
// render every one of those pages perfectly and prove nothing about any of
// them.
//
// ── WHAT IT STILL CANNOT COVER, AND WILL NOT PRETEND TO ───────────────────
//
// Two things on that list stay with a person, and it is worth naming them so
// the gap is a decision rather than an oversight:
//
//   * ONE REAL STRIPE CHARGE. Test mode proves the integration; it does not
//     prove that money moved. Only a real card on the real account does that,
//     once.
//   * AN INSTALL ON A PHYSICAL HANDSET. An emulator is not a phone, and the
//     difference is the whole reason to do it.
//
// Everything else on the list -- the HEIC upload, airplane mode, the Jobber
// CSV, the queues, the settings round trips -- is reachable from here.

import { defineConfig, devices } from "@playwright/test";

const PORT = 5601;
const BASE = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /.*\.spec\.ts$/,

  // ── SERIAL, AND THAT IS NOT A PERFORMANCE COMPROMISE ────────────────────
  //
  // One database, shared. Two specs marking the same invoice paid, or one
  // reseeding while another reads, produce failures that depend on ordering
  // and cannot be reproduced -- the most expensive kind of red. The sweeps go
  // wide because their backend is a fixture per page; these go narrow because
  // theirs is a single Postgres.
  fullyParallel: false,
  workers: 1,

  // No retries. A retry here re-runs against state the first attempt already
  // changed, so a pass on the second attempt means less than nothing: it can
  // be the first attempt's write making the second one succeed.
  retries: 0,

  reporter: process.env.CI ? [["line"], ["json", { outputFile: "e2e.json" }]] : [["list"]],
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE,
    // These tests fail in ways that need looking at rather than reading.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },

  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } } },
  ],

  // The dev server needs REAL Supabase credentials pointed at the LOCAL stack.
  // They are passed through rather than defaulted, so a missing one fails
  // loudly at startup instead of silently starting a server that talks to
  // nothing and produces twenty identical "page did not render" failures.
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `npx vite dev --port ${PORT} --host 127.0.0.1`,
        url: `${BASE}/auth`,
        // Locally, adopting a dev server already on 5601 saves a cold start.
        // In CI it is a way to go green against code that is not the code
        // under test — the runner is also somebody's development machine, so
        // the port may be held by another branch or an orphaned process. The
        // viewport config learned this on 2026-08-29 (58 tests reported
        // failures belonging to a checkout the runner never built); same
        // rule here, for the same reason, now that this suite runs in CI.
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
        env: {
          SUPABASE_URL: process.env.SUPABASE_URL ?? "",
          SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
          SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY ?? "",
          VITE_SUPABASE_URL: process.env.SUPABASE_URL ?? "",
          VITE_SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY ?? "",
          // Empty so a developer's `.env` cannot point a local run at real
          // Google from 127.0.0.1 — a referrer no key allows, which Google
          // answers with a console error these specs would report. Maps draw
          // with the Leaflet fallback here.
          VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_BROWSER_KEY: "",
          // ...and the runtime name `getMapsBrowserKey` reads, for the same reason.
          GOOGLE_MAPS_BROWSER_KEY: "",
        },
      },
});
