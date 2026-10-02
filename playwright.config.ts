import { defineConfig, devices } from "@playwright/test";

// ── WHY THIS EXISTS ───────────────────────────────────────────────────────
//
// CLAUDE.md states the responsiveness rules and then says, in as many words,
// that "a green test run is not a substitute for opening the page at 360px."
// Until now there was no way to do the second half: the repo had no browser of
// any kind, and all four enforced rules are STATIC analysis — they read JSX and
// class strings and reason about what the CSS will probably do.
//
// That catches the faults it was written for and cannot catch a layout that
// simply overflows. `min-w-0` present and the row still too wide, a grid whose
// columns don't fit, an absolutely-positioned element pushing the body — none
// of those are visible to a parser. They are visible to a browser, measured.
//
// So this is the other half, and it is deliberately NOT a replacement: the
// static tests name a file and a line, which a screenshot cannot, and they run
// in 30 seconds with no server.
//
// ── WHY THE DEV SERVER ────────────────────────────────────────────────────
//
// The production build targets the cloudflare-module preset, so `.output` is a
// Worker bundle rather than something node can serve. Layout is decided by the
// same Tailwind and the same components either way — bundling is what differs
// — so the dev server is the right thing to measure and much the simpler one
// to stand up. If that ever stops being true, this is the assumption to revisit.
export default defineConfig({
  testDir: "./tests/viewports",
  // `.spec.ts`, not `.test.ts`: vitest's include is `tests/**/*.test.{ts,tsx}`
  // and these must not be swept into that run, where there is no browser. The
  // separation is by EXTENSION rather than by an exclude, because
  // tests/the-wiring-is-connected.test.ts fails any vitest exclude naming
  // `tests/` — a file the runner does not name is a file CI cannot fail on.
  testMatch: /.*\.spec\.ts$/,
  // A layout assertion that needs retrying is a layout assertion that is wrong.
  retries: 0,
  // ── WHY 90s AND NOT THE 30s DEFAULT ───────────────────────────────────
  //
  // The first run of this on the self-hosted Mac failed exactly two of 54
  // assertions: /auth at 360px, which are tests 1 and 2 of the run. Both died
  // inside settle() with "Test timeout of 30000ms exceeded", while every later
  // test took 2–7 seconds. It was not a layout fault — it was Vite's cold
  // start.
  //
  // `webServer.url` waits for /auth to answer, but this app is server-rendered
  // and Vite transforms modules lazily: a 200 from the shell arrives long
  // before the route's module graph is built. So the FIRST navigation pays for
  // dependency optimisation and the whole SSR transform, on a checkout with no
  // warm cache, and nothing after it pays anything.
  //
  // Raising the ceiling is the honest fix. Warming the server in globalSetup
  // would hide the cost rather than allow for it, and a retry would turn a
  // deterministic layout check into a flaky one.
  timeout: 90_000,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: process.env.SWEEP_BASE_URL ?? "http://127.0.0.1:5599",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // ── PIN THE CLOCK, OR THE SWEEP MEANS SOMETHING DIFFERENT ON EVERY
        //    MACHINE IT RUNS ON ───────────────────────────────────────────
        //
        // Without this the browser inherits the host's time zone, and on
        // 2026-09-13 that cost a CI cycle: two `/routes` surfaces failed the
        // 44px floor on the runner (a Mac in US time) and passed locally (a
        // container in UTC), on the same commit, with no way to reproduce the
        // failure from the machine the change was written on.
        //
        // The path was `findRouteWarnings`, which compares an absolute
        // `eta_start` against LOCAL midnight of `scheduled_on`. Shift the zone
        // and the arithmetic moves by the offset, so whether the implausible-
        // route banner renders at all — and with it two buttons that were
        // 32px tall — depended on where the test ran. That banner is not the
        // only thing in this app that does date arithmetic against a local
        // midnight, so the fix belongs here rather than at that one call site.
        //
        // America/Chicago, and not UTC: a business time zone, behind UTC like
        // every one this product is used in, which keeps that class of fault
        // visible instead of pinning the one offset where the arithmetic
        // happens to come out clean.
        timezoneId: "America/Chicago",
        locale: "en-US",
        // Normally Playwright downloads a browser build matched to its own
        // version. Set SWEEP_CHROMIUM to point at one already on the machine
        // instead — for a sandbox with no browser download, or a runner where
        // the pinned build and the installed one disagree. Unset in CI, where
        // `playwright install` does the right thing.
        ...(process.env.SWEEP_CHROMIUM
          ? { launchOptions: { executablePath: process.env.SWEEP_CHROMIUM } }
          : {}),
      },
    },
  ],
  // Bound to 127.0.0.1 explicitly. Vite defaults to binding `::`, and a host
  // without IPv6 fails there with EAFNOSUPPORT before it serves anything.
  webServer: process.env.SWEEP_BASE_URL
    ? undefined
    : {
        command: "npx vite dev --port 5599 --host 127.0.0.1",
        url: "http://127.0.0.1:5599/auth",
        // ── IN CI THIS MUST START ITS OWN SERVER, NOT ADOPT ONE ──────────
        //
        // Reuse is a convenience locally: a dev server already up on 5599 is
        // this checkout, and attaching to it saves a cold start per sweep.
        //
        // On the self-hosted runner it is a way to go GREEN against code that
        // is not the code under test. The runner shares a machine with whoever
        // is working on it, so 5599 may be held by another branch, another
        // worktree, or a process orphaned out of an interrupted run — and
        // `reuseExistingServer: true` adopts it silently. On 2026-08-29 that
        // is exactly what happened: an orphaned `vite dev` from a developer's
        // own tree answered the sweep, the job logged not one `[WebServer]`
        // line, and all 58 public tests reported failures belonging to a
        // checkout the runner had never built. Red that time. Nothing about
        // the mechanism prefers red.
        //
        // False with CI set means Playwright refuses a busy port instead of
        // measuring whatever is behind it. A stale server becomes a loud
        // startup error naming the port, which is a fault about the runner —
        // where it belongs — rather than a layout finding that is not true.
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
        // Passed HERE rather than left to a `.env`, deliberately.
        //
        // The app needs these to boot; the public routes this sweep visits do
        // not read from the database, so placeholders are enough. But writing
        // them to `.env` to get the dev server up ALSO feeds them to vitest,
        // which loads the same file — and
        // tests/the-supabase-url-is-not-a-secret.test.ts then fails, because it
        // asserts on the fallback that a populated SUPABASE_URL displaces.
        //
        // That is a nasty trap: running the browser sweep would break the unit
        // suite, in a file that has nothing to do with either. Scoping the
        // values to this server keeps them out of every other runner.
        //
        // And deliberately NO VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY
        // here, which this block set until 2026-09-19. The browser client
        // (src/integrations/supabase/client.ts) now honors those in `vite dev`,
        // so setting them would point every browser request at 127.0.0.1:54421
        // — where the stub is NOT: fixtures/stub-backend.ts intercepts
        // `https://api.houndstack.com/**`, and its network fence passes
        // localhost through untouched. The sweep would then measure the app
        // failing to reach a database instead of the fixture, or, worse, a
        // real local stack if one happens to be up. Left unset, the client
        // falls back to the production URL and the stub answers it, exactly
        // as it always has. The server-side SUPABASE_URL below is different:
        // client.server.ts requires it to boot, and no server function's
        // answer is measured by these sweeps.
        env: {
          SUPABASE_URL: "http://127.0.0.1:54421",
          SUPABASE_PUBLISHABLE_KEY: "sb_publishable_placeholder",
          SUPABASE_PROJECT_ID: "localdev",
          SERVICE_ROLE_KEY: "sb_secret_placeholder",
          // Empty ON PURPOSE, so a developer's own `.env` cannot change what
          // the sweeps measure. With no build-time key the browser asks the
          // server (`getMapsBrowserKey`, answered null by the stub) and then
          // draws with the Leaflet fallback — which is what the map specs
          // locate, and the only thing that CAN draw behind the network
          // fence. The Google path is measured on purpose, against a fake, by
          // a-map-is-paid-for-once.spec.ts.
          VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_BROWSER_KEY: "",
        },
      },
});
