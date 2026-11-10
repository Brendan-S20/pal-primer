# Native QA: acceptance runs on production, in the demo org

Acceptance testing of HoundStack, web or native, runs against **production,
signed into the production demo org**. Not a separate staging location.

Decision: Brendan, relayed on Nov 10, 2026 at 1:45 AM ET, in his words: "Use
the production demo org for acceptance testing". It is recorded on #737, the
PR that first added this page.

PR #737 described a separate staging Supabase project and a
non-`houndstack.com` API host as the QA target for a shipped-style native
bundle. That stack was never stood up, and testers do not need it, or any
other non-production host, to complete acceptance testing. The build guards
behind it are real and still tested, so that path stays documented below as an
**optional isolated path**, not the acceptance path.

---

## The acceptance path

### What to test

- **Web:** `https://app.houndstack.com`.
- **iOS / Android:** a production bundle. That is `npm run build:native`
  (which `npm run cap:sync`, `cap:sync:android` and `android:debug` run for
  you), or a TestFlight / internal-track build. It sends server functions to
  `https://app.houndstack.com` and signs in to the production Supabase
  project. No environment file, no extra build settings.

Say which build at the start of the run: `git rev-parse --short HEAD` for a
local build, or the store build number. A local native build must be of the
commit production is running. A bundle from a different commit asks for
server-function ids production does not have, and any function added, renamed
or moved since then fails with a 404 (the first reason in the next section).

### How to know you are in the demo org

The acceptance target is **the production organization whose
`organizations.slug` is `demo`**. Nothing else.

- **Slug `demo`.** That is the identifier that decides. The workspace has been
  called **Demo Pet Waste Co** (`docs/ios-qa-results.md`,
  `docs/owner-actions-before-submission.md`), but a name can be edited and the
  slug is what the code checks.
- **Metro Detroit seed data** from `seed_demo_org` (#320; section 3 of
  `docs/app-store-submission.md`). Clients such as `Riverside HOA` are seed
  data.
- **Accounts end in `@demo.test`**, for example `owner@demo.test`.
  `tech@demo.test` and `dispatcher@demo.test` also appear in this repo.
  Passwords are supplied by the owner and are not in this repo.
- **Invites from the demo org must use `@demo.test`.** The server refuses any
  other address (`src/lib/users.functions.ts`).

Before the first action, check the account you signed in with ends in
`@demo.test` and the business shown is the demo org. If either is not true,
sign out and stop.

**The Reseed card is not proof.** `isDemoOrganization()` in
`src/lib/demo-org.ts` is `is_comped === true || slug === "demo"`. It decides
who may see the Reseed button; it does not name the acceptance target. Comped
orgs include design partners and real businesses, and they are off limits.
Only the org with slug `demo` is the acceptance target.

### Safety rules

These hold for every acceptance run. A step that cannot be done inside them is
recorded as **not run**, with the reason. That is a correct result, not a
failure (the rule at the top of `docs/device-qa-script.md`).

1. **Demo or test records only.** Use the demo org's own seeded data, records
   you create inside the demo org, and `@demo.test` accounts. Nothing else.
2. **No real org's data.** Never touch Detroit Doo Disposal's data, never sign
   in as or send anything to `detroitdoodisposal@gmail.com`, and never open,
   read or change any other real organization's data. This includes comped
   and design-partner orgs.
3. **No real messages.** Send no real customer emails or texts. Do not fire
   Twilio, production email or push at a real person. Do not add a real phone
   number or email address to a demo record to see a message arrive. If a
   flow would contact a real customer, stop and mark it not run.
4. **No money.** Do not take a card payment or start a checkout in
   production. Checking that the control is there is fine; submitting it is
   not. One real charge stays with the owner (`CLAUDE.md`).
5. **Do not Reseed casually.** Reseed wipes and rebuilds the demo org for
   everyone testing in it at the time. Press it only when the run calls for
   it and nobody else is mid-run.

---

## Why a native bundle cannot just point at a dev server

This is why acceptance uses production rather than a laptop.

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
page on Android cannot fetch an `http://` origin at all. Production is served
over HTTPS with a publicly trusted certificate, which is one more reason
acceptance runs there. **An optional staging API would have to be served the
same way.**

Live reload (`CAP_SERVER_URL=… npx cap run ios`, `docs/ios-build.md`) is not a
substitute. It makes the WebView load the dev server's pages, so the origin,
the ids and the transport are all the dev server's. That is useful for
development, and not a test of the binary.

---

## Optional isolated path: a separate staging stack

**Not the acceptance path.** None of this exists today, and acceptance testing
does not need it. It is here for a future case that needs a backend with no
production data in it at all, because the guards that keep such a build off
production are real and are tested.

This extends #663 (native-r2-04, "Supabase URL as a build setting"). It does
not repeat what #663 built. The build-time settings and their guards are
documented where they live: `vite.config.ts` (the `WHICH SUPABASE A NATIVE
BUILD TALKS TO (#623)` block), `scripts/build-native.mjs` and
`scripts/native-prod-hosts.mjs`, and pinned by
`tests/a-staging-binary-talks-only-to-staging.test.ts`.

### What "staging" is

Two things, both owned by whoever operates the infrastructure (not QA), and
not set up by anything in this repo:

| Piece                         | What it must be                                                                                                                                                                                               | Why                                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Staging Supabase project**  | A separate Supabase project, built by replaying `supabase/migrations/` from empty (the rule in `CLAUDE.md`), with the edge functions deployed and a seeded demo tenant that has at least one field technician | `NATIVE_SUPABASE_URL` / `NATIVE_SUPABASE_PUBLISHABLE_KEY` point the binary's sign-in, storage and realtime here. A copy of production data is not staging. |
| **Staging web app** (the API) | A **production** build (`npm run build`, not `vite dev`) of the **same commit** the native bundle is built from, served over HTTPS on a non-`houndstack.com` host                                             | `NATIVE_API_ORIGIN` sends every server function here. Same commit is what makes the server-function ids line up.                                           |

The staging web app's **runtime** environment (set wherever it is hosted, never
in this repo) is the `.env.example` list with every value swapped for
staging's:

- `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_PROJECT_ID`,
  `SERVICE_ROLE_KEY`: the **staging** project. These are what server
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

**Known gap: do not QA the staging web app in a browser.** A hosted
`npm run build` compiles `src/integrations/supabase/client.ts` with the
production Supabase literal (the `VITE_SUPABASE_*` override is dev-only, on
purpose). So the staging web app's _server_ talks to staging while its
_browser pages_ sign in to production. It is an API host for the binary, not a
second website; browser QA stays on `npm run dev` or `npm run test:e2e`
against a local stack.

### Building a staging binary (optional)

No code edits. Set three values, build, sync.

1. Check out the commit the staging web app is running, and say which one:
   `git rev-parse --short HEAD` (the same first step `docs/device-qa-script.md`
   asks for).
2. Copy `docs/native-qa-staging.env.example` to a file **outside the repo**
   and fill in the three values. The
   publishable key is not a secret (it ships inside the binary), but it is
   staging's, and it does not belong in git.
3. Load it and build:

   ```bash
   # macOS / Linux
   set -a; . ~/houndstack-native-staging.env; set +a
   unset CAP_SERVER_URL    # live reload would load a dev server, not the bundle
   npm run build:native:staging
   npx cap sync ios        # or: npx cap sync android
   ```

   ```powershell
   # Windows PowerShell
   Get-Content $HOME\houndstack-native-staging.env |
     Where-Object { $_ -match '^\s*[A-Z_]+=' } |
     ForEach-Object { $k, $v = $_ -split '=', 2; Set-Item "env:$($k.Trim())" $v.Trim() }
   Remove-Item env:CAP_SERVER_URL -ErrorAction SilentlyContinue
   npm run build:native:staging
   npx cap sync android
   ```

   Do **not** run `npm run cap:sync` / `cap:sync:android` / `android:debug`
   afterwards: each of those runs `build:native` (production) first and
   replaces the staging bundle you just built.

4. Open and run as usual (`npx cap open ios`, or
   `android/build-debug.sh assembleDebug` for a debug APK).

#### What refuses to build, so you do not have to check by eye

From #663, unchanged:

- `build:native:staging` with any of the three values missing, a
  `houndstack.com` host or the production project ref in either URL, or the
  production project's key → `[native build] refusing to build`.
- After the build, `scripts/native-prod-hosts.mjs` scans
  `dist-native/client` and fails if any `houndstack.com` host or the
  production ref survived into the bundle. The success line is
  `✓ staging native bundle contains no houndstack.com host and no production Supabase ref`.
  If you did not see it, you do not have a staging bundle.

#### Checks that are not automated (one minute, before installing)

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

# 3. The synced native config loads the bundle, not a remote page.
#    Expect no output. A "url" under "server" means CAP_SERVER_URL was set
#    at sync time and the app will ignore the staging bundle entirely.
grep -n '"url"' ios/App/App/capacitor.config.json \
  android/app/src/main/assets/capacitor.config.json 2>/dev/null
```

If (1) returns no `access-control-allow-origin`, the host is a dev server, an
old deploy from before the CORS middleware, or not this app; every server call
from the binary will fail with full signal.

### What a staging binary proves, and what it does not

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

### If something is wrong

| Symptom                                                                 | Likely cause                                                                                                                    |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| App boots, every list is empty or "offline" with full signal            | Preflight refused: the API host is a dev server or an old deploy. Run check (1).                                                |
| Some screens load, one action 404s on `/_serverFn/…`                    | The staging web app is a different commit from the bundle. Rebuild from its commit.                                             |
| Sign-in works, the first screen says unauthenticated                    | Binary and staging server point at different Supabase projects. Compare `NATIVE_SUPABASE_URL` with the server's `SUPABASE_URL`. |
| App shows a dev server's pages, or a blank screen with no network       | `CAP_SERVER_URL` was set when `npx cap sync` ran. Unset it and sync again; check (3) shows nothing.                             |
| Sign-in fails with `Invalid login credentials` for a known staging user | The bundle is production: `cap:sync` (or another script that runs `build:native`) ran after the staging build.                  |
| Build refuses with a production host                                    | Working as intended: one of the three values is production's.                                                                   |
