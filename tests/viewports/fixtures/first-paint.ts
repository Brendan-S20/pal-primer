/**
 * How long a FIRST navigation to a route is allowed to take.
 *
 * `playwright.config.ts` already reasons this out for the test budget: this
 * app is server-rendered and Vite transforms modules lazily, so `webServer.url`
 * answering 200 on /auth proves nothing about any other route. The first
 * navigation to a route pays for that route's whole SSR transform, and nothing
 * after it pays anything. That is why the test timeout there is 90s and not
 * the 30s default, and why the comment says "raising the ceiling is the honest
 * fix" rather than warming the server or adding a retry.
 *
 * The specs then undercut it. A `toBeVisible({ timeout: 20_000 })` on that
 * first navigation gives up at 20s inside a 90s budget, so the generous test
 * timeout never gets to do its job. It held until 2026-09-14, when the
 * one-off cases suite failed on `Mac0s` at /invoices and /clients/:id -- both
 * the first assertion in their file, both "element(s) not found", both passing
 * locally in 11.4s cold and 2-3s warm, and all 233 other tests green. The
 * runner was mid-degradation that day (setup-node at 19 minutes against a
 * normal 5) and the suite had just grown from 227 tests to 235, so several
 * cold route transforms were competing for one saturated dev server.
 *
 * 60s, not 20. It stays inside the 90s test timeout, so a route that never
 * renders still fails with the assertion's own message rather than a bare
 * test-timeout. And a longer ceiling cannot invent a pass: the assertion still
 * has to come true, it is only allowed to come true late.
 *
 * Use this for the FIRST assertion after a `goto` -- the one proving the page
 * rendered at all. Assertions after it are measuring a page that is already up
 * and should keep a short, ordinary timeout, because there a long wait really
 * would just be slow failure.
 */
export const FIRST_PAINT_MS = 60_000;
