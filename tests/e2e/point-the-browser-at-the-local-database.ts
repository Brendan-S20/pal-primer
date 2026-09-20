// The browser half of this app could not be configured, so it was proxied.
//
// ── THE FINDING ───────────────────────────────────────────────────────────
//
// Until 2026-09-19, `src/integrations/supabase/client.ts` did not read an
// environment variable. It hardcoded them:
//
//     const SUPABASE_URL = "https://api.houndstack.com";
//     const SUPABASE_PUBLISHABLE_KEY = "eyJ...";
//
// So every request the BROWSER made went to production, whatever the dev
// server was started with. The server half (`client.server.ts`) does read
// `process.env.SUPABASE_URL`, so a local run was split down the middle: server
// functions reached the local database, the browser reached the live one.
//
// That is why the first working sign-in failed with `Invalid login
// credentials` for a user the seed had created and successfully signed in as
// seconds earlier. The seed talked to localhost. The browser talked to
// production, where that user does not exist and never should.
//
// ── THE FILE IS NOW FIXED, AND THIS PROXY DELIBERATELY STAYS ──────────────
//
// client.ts now honors VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY in
// `vite dev` (and only there — the override is behind import.meta.env.DEV, so
// production ships the literals, always). playwright.e2e.config.ts passes the
// local values to its dev server, so in a normal run the browser goes to the
// local stack directly and no route registered here ever matches.
//
// It stays because client.ts says of itself "This file is automatically
// generated" and the Lovable agent edits it from a browser. If a regeneration
// drops the env reads, requests to api.houndstack.com reappear — and this
// proxy turns them back to localhost, so the E2E suite keeps testing the
// right database instead of silently writing to production while every spec
// stays green. The LOUD signal for that stomp is
// tests/the-browser-client-can-be-pointed-at-a-local-database.test.ts, which
// pins the shape of the fix; this file is the quiet backstop that keeps a
// stomped run harmless. Both halves matter: a backstop without the test is a
// silent revert, a test without the backstop is one bad merge away from an
// E2E suite that writes to production.
//
// ── AND WHY IT FETCHES RATHER THAN REDIRECTS ─────────────────────────────
//
// `route.continue({ url })` is the API built for rewriting a request, and it
// refuses this one:
//
//     New URL must have same protocol as overridden URL
//
// Production is https; a local Supabase is http. So the request is performed
// here and the bytes are returned. That makes the test process the proxy,
// which is worth saying plainly rather than hiding behind a helper name.
//
// ── THE KEY HAS TO MOVE TOO, WHICH IS EASY TO MISS ───────────────────────
//
// Forwarding production's anon JWT to the local GoTrue gets it rejected, and
// that failure reads as an auth problem rather than a routing one. Supabase
// sends the key twice, as `apikey` and inside `Authorization: Bearer`, and
// both need swapping -- but the Authorization header only while it still
// carries the anon key. Once a user signs in it carries their session, and
// overwriting that would sign them out mid-test.

import type { BrowserContext } from "@playwright/test";

const PRODUCTION = "https://api.houndstack.com";
const LOCAL_ONLY = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

export async function pointTheBrowserAtTheLocalDatabase(
  context: BrowserContext,
  opts: { url: string; anonKey: string },
) {
  const local = opts.url.replace(/\/$/, "");
  if (!LOCAL_ONLY.test(new URL(local).origin)) {
    // The same allowlist as the seeder, for the same reason: this exists to
    // keep test traffic OFF production, and a typo pointing it at another
    // live host would do the exact opposite of its purpose.
    throw new Error(`refusing to proxy the browser to ${local}; it must be local`);
  }
  if (!opts.anonKey) throw new Error("no anon key; the local stack would reject every request");

  await context.route(`${PRODUCTION}/**`, async (route) => {
    const req = route.request();
    const target = req.url().replace(PRODUCTION, local);

    const headers = { ...req.headers() };
    const sentKey = headers["apikey"];
    if (sentKey) headers["apikey"] = opts.anonKey;
    const auth = headers["authorization"];
    if (auth && sentKey && auth === `Bearer ${sentKey}`) {
      headers["authorization"] = `Bearer ${opts.anonKey}`;
    }
    // Addressed to api.houndstack.com. Forwarded to localhost they make the
    // local stack answer a preflight it never agreed to.
    delete headers["host"];
    delete headers["origin"];

    let res: Response;
    try {
      res = await fetch(target, {
        method: req.method(),
        headers,
        body: ["GET", "HEAD"].includes(req.method())
          ? undefined
          : (req.postDataBuffer() ?? undefined),
        redirect: "manual",
      });
    } catch (err) {
      // Say which request died. A proxy that aborts silently presents as the
      // page failing for no reason, which is the hardest kind to chase.
      await route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({ error: `e2e proxy could not reach ${target}: ${String(err)}` }),
      });
      return;
    }

    const body = Buffer.from(await res.arrayBuffer());
    const out: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      // `content-encoding` describes an encoding fetch has already undone, and
      // `content-length` no longer matches after that. Passing either on makes
      // the browser try to decode plain bytes.
      if (k !== "content-encoding" && k !== "content-length") out[k] = v;
    });

    await route.fulfill({ status: res.status, headers: out, body });
  });
}
