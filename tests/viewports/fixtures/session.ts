import type { BrowserContext } from "@playwright/test";

import { PUBLIC_SUPABASE_URL } from "../../../src/lib/supabase-url";

/**
 * A signed-in browser, with no account anywhere.
 *
 * ── WHY NOT A REAL SESSION ────────────────────────────────────────────────
 *
 * Three options were on the table and two of them are shut.
 *
 *   1. A real user in the production project (`vsxzrbxublqrcfnxfwcu`). Not a
 *      candidate at any price: a layout sweep must never write to the database
 *      the business runs on, and a test that needs a password is a test nobody
 *      can run.
 *
 *   2. A local Supabase stack (`supabase start`) with a seeded demo org. This
 *      is the option the public sweep's own header anticipated — "needs a
 *      seeded org in a local Supabase stack". It is not available here and it
 *      is not merely missing a download: there is no `supabase` CLI on PATH,
 *      and while `/usr/bin/docker` exists the daemon does not answer
 *      (`/var/run/docker.sock` is absent), so nothing can start the stack. The
 *      repo has no `supabase/seed.sql` either — the only demo data is
 *      `seed_demo_org`, an RPC a signed-in user calls from Settings, which is
 *      to say it needs the session it was supposed to provide.
 *
 *   3. This. Mint a Supabase session, put it where the browser client looks
 *      for one, and answer the app's network calls from a fixture.
 *
 * ── WHY (3) IS NOT A COMPROMISE ───────────────────────────────────────────
 *
 * The sweep asserts LAYOUT. A box's width does not know where its text came
 * from. A client row rendered from a stub is the same flex row, in the same
 * Tailwind classes, at the same viewport, as one rendered from Postgres — and
 * it is the row, not the query, that overflows a 360px phone.
 *
 * What it buys on top of that is the part a live backend cannot give: the data
 * is CHOSEN. `docs/mobile-ux-audit.md` is about long names in narrow rows and
 * signup URLs with nowhere to break, so the fixture holds a 46-character
 * business name and a 78-character signup URL — the values that make the fault
 * visible, present on every run, on any machine, with no credential.
 *
 * ── HOW A SESSION GETS IN ─────────────────────────────────────────────────
 *
 * `src/integrations/supabase/client.ts` creates the browser client with
 * `storage: window.localStorage`, so the session is a localStorage entry
 * written before the app's first script runs. `page.addInitScript` is exactly
 * that hook.
 *
 * The KEY is the surprise. supabase-js derives `sb-<project-ref>-auth-token`
 * by default, but client.ts passes `storageKey: impersonating ? '…' : undefined`
 * and an explicit `undefined` OVERWRITES the default in the options spread. So
 * GoTrueClient ends up with `storageKey === undefined`, and every read is
 * `localStorage.getItem(undefined)` — the literal key `"undefined"`. That is
 * what this app stores its session under today; measured, not assumed.
 *
 * Both keys are written. The literal is what the app reads NOW; the derived
 * one is what it will read the day someone gives that ternary an `else`. The
 * sweep must not start failing on a fix.
 */

/** Project ref from `src/integrations/supabase/client.ts`. Still the ref and not
 *  the custom domain, because the only thing it is used for below is the
 *  DERIVED storage key `sb-<ref>-auth-token`, which supabase-js builds from the
 *  hostname of whatever URL it was given. That key is a fallback the app does
 *  not currently read at all — see the note above. */
export const SUPABASE_PROJECT_REF = "vsxzrbxublqrcfnxfwcu";

/** The origin the browser client actually talks to, imported rather than
 *  spelled out.
 *
 *  It used to be `https://${SUPABASE_PROJECT_REF}.supabase.co`, written out
 *  here as its own literal. When the custom domain was activated on 2026-08-19
 *  that made this fixture a second, silent source of truth: `stub-backend.ts`
 *  routes `${SUPABASE_ORIGIN}/**`, so the moment the app started calling
 *  api.houndstack.com every PostgREST request would have sailed past the stub
 *  and into the network fence — twenty signed-in surfaces failing at once, for
 *  a reason that has nothing to do with layout. Deriving it means the next URL
 *  change cannot do that. */
export const SUPABASE_ORIGIN = PUBLIC_SUPABASE_URL;

export const SWEEP_USER_ID = "00000000-0000-4000-8000-000000000001";
export const SWEEP_USER_EMAIL = "sweep.owner@houndstack-sweep.test";

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** A structurally valid JWT. Never verified by anything: the only server that
 *  would check the signature is the one this fixture replaces. Three segments
 *  because `requireSupabaseAuth` rejects a token that has fewer, and the
 *  dev server is still the thing serving the page. */
function mintAccessToken(expiresAt: number): string {
  return [
    b64url({ alg: "HS256", typ: "JWT" }),
    b64url({
      sub: SWEEP_USER_ID,
      aud: "authenticated",
      role: "authenticated",
      email: SWEEP_USER_EMAIL,
      iat: Math.floor(Date.now() / 1000),
      exp: expiresAt,
      session_id: "11111111-1111-4111-8111-111111111111",
    }),
    "viewport-sweep-not-a-signature",
  ].join(".");
}

export function sweepUser() {
  const now = new Date().toISOString();
  return {
    id: SWEEP_USER_ID,
    aud: "authenticated",
    role: "authenticated",
    email: SWEEP_USER_EMAIL,
    phone: "",
    app_metadata: { provider: "email", providers: ["email"] },
    // `tour_seen_at` suppresses OnboardingTour, which otherwise opens a modal
    // over the first authenticated page a fresh account sees. Measuring the
    // tour's dialog instead of the page underneath it is not what any of these
    // rules are about — and the tour has its own coverage in the public sweep's
    // sibling static tests.
    user_metadata: { full_name: "Dana Whitfield-Ramirez", tour_seen_at: new Date().toISOString() },
    // Two connected, one not — which is the state that actually stresses the
    // "Ways to sign in" card: a Disconnect button, a Connect button, and the
    // "Only way in" case all render off this. An empty array renders three
    // identical rows and measures none of them.
    identities: [
      {
        identity_id: "11111111-0000-4000-8000-000000000001",
        id: SWEEP_USER_EMAIL,
        user_id: SWEEP_USER_ID,
        provider: "email",
        identity_data: { email: SWEEP_USER_EMAIL, sub: SWEEP_USER_ID },
        created_at: "2026-01-01T00:00:00Z",
        last_sign_in_at: "2026-08-01T00:00:00Z",
      },
      {
        identity_id: "11111111-0000-4000-8000-000000000002",
        id: "google-oauth-subject",
        user_id: SWEEP_USER_ID,
        provider: "google",
        identity_data: { email: SWEEP_USER_EMAIL, sub: "google-oauth-subject" },
        created_at: "2026-02-01T00:00:00Z",
        last_sign_in_at: "2026-08-20T00:00:00Z",
      },
    ],
    created_at: now,
    updated_at: now,
    email_confirmed_at: now,
    confirmed_at: now,
    last_sign_in_at: now,
    is_anonymous: false,
  };
}

export function sweepSession() {
  // A day out. Long enough that no run can straddle the expiry, short enough
  // that a session left in a saved profile is not a lasting artefact.
  const expiresAt = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
  return {
    access_token: mintAccessToken(expiresAt),
    token_type: "bearer",
    expires_in: 24 * 60 * 60,
    expires_at: expiresAt,
    refresh_token: "viewport-sweep-refresh-token",
    user: sweepUser(),
  };
}

/**
 * Seed the session before any application script runs.
 *
 * Also pins the two localStorage preferences the Routes page reads
 * synchronously at mount, because both decide WHICH LAYOUT gets drawn and a
 * sweep that cannot choose one can only ever measure the default. See
 * `src/routes/_authenticated/routes.tsx`: `routes.viewMode`, `routes.range`.
 */
export async function installSignedInSession(
  context: BrowserContext,
  prefs: Record<string, string> = {},
): Promise<void> {
  const payload = JSON.stringify(sweepSession());
  await context.addInitScript(
    ([serialized, extras]: [string, Record<string, string>]) => {
      try {
        // The key the app actually reads today, and the key it would read if
        // client.ts ever stopped passing `storageKey: undefined`.
        localStorage.setItem("undefined", serialized);
        localStorage.setItem("sb-vsxzrbxublqrcfnxfwcu-auth-token", serialized);
        for (const [k, v] of Object.entries(extras)) localStorage.setItem(k, v);
      } catch {
        /* a context with storage disabled cannot be signed in; settle() will say so */
      }
    },
    [payload, prefs] as [string, Record<string, string>],
  );
}
