# Native QA against staging

How to put a shipped-style native bundle (iOS or Android) in front of QA
without it touching production, and without anyone editing code to do it.

This page extends #663 (native-r2-04, "Supabase URL as a build setting"). It
does not repeat what #663 built; it says how to use it for QA, and what the
far end has to be for it to work. The build-time settings and their guards are
documented where they live: `vite.config.ts` (the `WHICH SUPABASE A NATIVE
BUILD TALKS TO (#623)` block), `scripts/build-native.mjs` and
`scripts/native-prod-hosts.mjs`, and pinned by
`tests/a-staging-binary-talks-only-to-staging.test.ts`.

---

## Why a native bundle cannot just point at a dev server

The bundle QA installs is the bundle the store gets: `npm run build:native`,
a production `vite build` that boots from `capacitor://localhost` (iOS) or
`https://localhost` (Android). Pointing it at `npm run dev` on a laptop fails
for two independent reasons (native-r2-05):

1. **Server-function ids do not match.** Every data call is
   `POST /_serverFn/<id>`, and the id is baked into the client bundle at build
   time. A production build and `vite dev` do not mint the same ids, so the
   bundle asks the dev server for functions it does not know by those names.
   The same thing happens, more quietly, against a production build of a
   _different commit_: any server function added, renamed or moved since then
   is a 404.
2. **The dev server does not admit the iOS app's origin.** The allowlist in
   `src/lib/cors.server.ts` (which already names both Capacitor origins) runs
   as request middleware in the built server. `vite.config.ts` sets no
   `server.cors`, so `vite dev` answers preflights with Vite's default, which
   admits `http(s)://localhost` and loopback only: `capacitor://localhost` is
   refused before the app's middleware runs. (Android's `https://localhost`
   happens to match that default, and still fails on reason 1 and on the
   transport rule below.)

There is also a transport rule underneath both: the shipped binary does not
relax ATS (iOS) or cleartext (Android). `capacitor.config.ts` only permits
`http://` when `CAP_SERVER_URL` is set for live reload, and an `https://localhost`
page on Android cannot fetch an `http://` origin at all. **The staging API must
be served over HTTPS with a publicly trusted certificate.**

Live reload (`CAP_SERVER_URL=… npx cap run ios`, `docs/ios-build.md`) is not a
substitute. It makes the WebView load the dev server's pages, so the origin,
the ids and the transport are all the dev server's — useful for development,
and not a test of the binary.

---

## What "staging" is

Two things, both owned by whoever operates the infrastructure — not QA, and
not set up by anything in this repo:

| Piece                         | What it must be                                                                                                                                                                                               | Why                                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Staging Supabase project**  | A separate Supabase project, built by replaying `supabase/migrations/` from empty (the rule in `CLAUDE.md`), with the edge functions deployed and a seeded demo tenant that has at least one field technician | `NATIVE_SUPABASE_URL` / `NATIVE_SUPABASE_PUBLISHABLE_KEY` point the binary's sign-in, storage and realtime here. A copy of production data is not staging. |
| **Staging web app** (the API) | A **production** build (`npm run build`, not `vite dev`) of the **same commit** the native bundle is built from, served over HTTPS on a non-`houndstack.com` host                                             | `NATIVE_API_ORIGIN` sends every server function here. Same commit is what makes the server-function ids line up.                                           |

The staging web app's **runtime** environment (set wherever it is hosted, never
in this repo) is the `.env.example` list with every value swapped for
staging's:

- `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_PROJECT_ID`,
  `SERVICE_ROLE_KEY` — the **staging** project. These are what server
  functions use to check the binary's bearer token, so they must name the
  same project as the binary's `NATIVE_SUPABASE_URL`; if they differ, sign-in
  succeeds and the first server call fails as unauthenticated.
- Stripe: test-mode keys or none. Twilio, email, push: unset or test
  credentials only. QA must not be able to text, email or charge a real
  customer from staging.
- `NATIVE_CORS_ORIGINS`: **leave unset.** The binary's origins
  (`capacitor://localhost`, `https://localhost`) are built into
  `cors.server.ts` and are admitted without it. It is only for an extra
  origin, such as a preview host calling the API from a browser.

**Known gap — do not QA the staging web app in a browser.** A hosted
`npm run build` compiles `src/integrations/supabase/client.ts` with the
production Supabase literal (the `VITE_SUPABASE_*` override is dev-only, on
purpose). So the staging web app's _server_ talks to staging while its
_browser pages_ sign in to production. It is an API host for the binary, not a
second website; browser QA stays on `npm run dev` or `npm run test:e2e`
against a local stack.

---

## Building a staging binary (QA)

No code edits. Set three values, build, sync.

1. Check out the commit the staging web app is running, and say which one:
   `git rev-parse --short HEAD` (the same first step `docs/device-qa-script.md`
   asks for).
2. Copy `docs/native-qa-staging.env.example` to a file **outside the repo**
   and fill in the three values. The
   publishable key is not a secret — it ships inside the binary — but it is
   staging's, and it does not belong in git.
3. Load it and build:

   ```bash
   # macOS / Linux
   set -a; . ~/houndstack-native-staging.env; set +a
   npm run build:native:staging
   npx cap sync ios        # or: npx cap sync android
   ```

   ```powershell
   # Windows PowerShell
   Get-Content $HOME\houndstack-native-staging.env |
     Where-Object { $_ -match '^\s*[A-Z_]+=' } |
     ForEach-Object { $k, $v = $_ -split '=', 2; Set-Item "env:$($k.Trim())" $v.Trim() }
   npm run build:native:staging
   npx cap sync android
   ```

   Do **not** run `npm run cap:sync` / `cap:sync:android` / `android:debug`
   afterwards: each of those runs `build:native` (production) first and
   replaces the staging bundle you just built.

4. Open and run as usual (`npx cap open ios`, or
   `android/build-debug.sh assembleDebug` for a debug APK).

### What refuses to build, so you do not have to check by eye

From #663, unchanged:

- `build:native:staging` with any of the three values missing, a
  `houndstack.com` host or the production project ref in either URL, or the
  production project's key → `[native build] refusing to build`.
- After the build, `scripts/native-prod-hosts.mjs` scans
  `dist-native/client` and fails if any `houndstack.com` host or the
  production ref survived into the bundle. The success line is
  `✓ staging native bundle contains no houndstack.com host and no production Supabase ref`.
  If you did not see it, you do not have a staging bundle.

### Checks that are not automated (one minute, before installing)

```bash
S=https://<your-staging-web-app-host>

# 1. The staging API is a production build that admits the app's origin.
#    Expect 204 and access-control-allow-origin: capacitor://localhost.
curl -si -X OPTIONS "$S/_serverFn/probe" \
  -H 'Origin: capacitor://localhost' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization, content-type, x-tsr-serverfn' \
  | grep -iE '^HTTP|access-control-allow-origin'

# 2. The bundle names the staging host it will call.
grep -rl "${S#https://}" dist-native/client | head -3
```

If (1) returns no `access-control-allow-origin`, the host is a dev server, an
old deploy from before the CORS middleware, or not this app; every server call
from the binary will fail with full signal.

---

## What a staging binary proves, and what it does not

It proves the bundle QA installs, built the way the store build is built,
works end to end against a real backend: sign-in, server functions, RLS,
storage uploads, realtime, deep links (which a staging build rewrites to the
staging web host).

It does not prove:

- **The production binary.** `build:native` and `build:native:staging` are
  the same build with different constants, but the store artifact is the
  production one. The pre-submission pass in `docs/device-qa-script.md` and
  `docs/app-store-submission.md` still runs on it.
- **Push.** APNs and FCM are keyed to the app id and production credentials;
  a staging server without push credentials sends none. Push stays a
  physical-device check against production, per `docs/ios-build.md`.
- **Money.** Stripe test mode proves the integration, not that money moved
  (`CLAUDE.md`: one real charge stays with a person).
- **A phone.** The simulator and emulator are not handsets. Camera, GPS,
  background location, the lock-screen route and sign in with Apple/Google
  need a physical device.

---

## If something is wrong

| Symptom                                                                 | Likely cause                                                                                                                    |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| App boots, every list is empty or "offline" with full signal            | Preflight refused: the API host is a dev server or an old deploy. Run check (1).                                                |
| Some screens load, one action 404s on `/_serverFn/…`                    | The staging web app is a different commit from the bundle. Rebuild from its commit.                                             |
| Sign-in works, the first screen says unauthenticated                    | Binary and staging server point at different Supabase projects. Compare `NATIVE_SUPABASE_URL` with the server's `SUPABASE_URL`. |
| Sign-in fails with `Invalid login credentials` for a known staging user | The bundle is production: `cap:sync` (or another script that runs `build:native`) ran after the staging build.                  |
| Build refuses with a production host                                    | Working as intended — one of the three values is production's.                                                                  |
