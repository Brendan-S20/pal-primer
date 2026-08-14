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
        reuseExistingServer: true,
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
        env: {
          SUPABASE_URL: "http://127.0.0.1:54321",
          SUPABASE_PUBLISHABLE_KEY: "sb_publishable_placeholder",
          SUPABASE_PROJECT_ID: "localdev",
          SERVICE_ROLE_KEY: "sb_secret_placeholder",
          VITE_SUPABASE_URL: "http://127.0.0.1:54321",
          VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_placeholder",
          VITE_SUPABASE_PROJECT_ID: "localdev",
        },
      },
});
