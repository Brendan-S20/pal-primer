# What still needs you

Everything in here needs a console, an account, a card, or a judgement call
that is not mine to make. Nothing in here can be done from the repo.

Ordered by what blocks the most. Last measured 2026-08-30 against `main`
(`18aed23`). The 2026-08-26 pass against `76410a0` is what most of the DONE
entries below rest on; item 2 and item 9 were re-measured on the later date.

---

## 1. Sign in with Apple — DONE

Live on the web, verified by following the redirect and reading what Apple
returned: `appleid.apple.com` renders the real "Sign in to Apple Account", and
the `client_id` is `consulting.thenorth.houndstack.web` — the **Services ID**,
not the App ID. That is the trap this section used to warn about and it was
avoided.

Google and Facebook are live too. `npm run check:oauth` reports all three.

**Diarise the expiry.** Apple caps the client secret at about six months. When
it lapses, Sign in with Apple stops at Apple, invisibly to the app.
`npm run apple:secret` prints the date when it generates one.

## 2. Move the `.p8` out of the repo directory — DONE

- [x] Gone from the repo root, and nothing leaked. Re-verified 2026-08-30:
      no `.p8` anywhere in the working tree, and
      `git log --all --diff-filter=A -- '*.p8'` is empty, so no such file was
      ever added on any branch. `.gitignore` still covers `*.p8`,
      `AuthKey_*.p8`, `*.p12` and `*.mobileprovision` for the next one.

      The same sweep checked the rest of history for secrets. `.env` WAS
      tracked once and is in history, but every committed version holds only
      `SUPABASE_URL`, `SUPABASE_PROJECT_ID` and `SUPABASE_PUBLISHABLE_KEY` —
      no `SERVICE_ROLE_KEY` in any of the four commits that touched it. Those
      three are publishable by design, which
      `tests/the-supabase-url-is-not-a-secret.test.ts` asserts. **Nothing to
      rotate.**

That key downloads from Apple **once** and cannot be re-fetched. Anyone holding
it can mint Sign in with Apple secrets for the team until it is revoked, so the
recovery is revoke, regenerate, re-sign — not "change a password". Keep it
somewhere else; `apple:secret` takes a path.

---

## 3. Xcode Cloud — ALREADY DONE, and this entry was stale

There is no Test action to delete. The workflow has one Action, **Archive -
iOS**, with Distribution Preparation set to App Store Connect, and two
Post-Actions: TestFlight Internal Testing (Stackers) and TestFlight External
Testing (The Hounds). The truncated "Test..." entries in the sidebar are those
two TestFlight post-actions.

The Test action was deleted by the owner much earlier in the project, right
after the "There are no test bundles available to test" failure. This checklist
kept carrying it as outstanding for days afterwards, which is worse than not
listing it: a checklist that asks for work already done teaches people to skim
it.

The original diagnosis was still correct and is worth keeping, because it
explains why a Test action can never work here: `ios/App/App.xcodeproj` has
exactly ONE target and it is of type `application`. The UITests are a separate
project, `ios/UITests/UITests.xcodeproj`, so the App workspace has no test
bundle to run. If a Test action is ever added back, it will fail the same way.

## 4. App Privacy questionnaire — DONE

## 5. Category — DECIDED: Productivity

- [ ] Set it in App Store Connect. `docs/app-store-submission.md` already says
      Productivity; App Store Connect said Utilities, so ASC is the one to
      change.

## 6. Allow the app's redirect URL in Supabase — BLOCKING

The single most important entry here. OAuth buttons ship in the binary as of
2026-08-27, so without this every Google and Facebook sign-in from inside the
iOS app fails, and fails silently. A reviewer would hit it on the first tap.
See the superseded-section note near the end for why this changed.

- [ ] Supabase → Authentication → URL Configuration → **Redirect URLs** → add
      `consulting.thenorth.houndstack://auth-callback`

Sign-in from inside the iOS app hands back to the app through that custom URL
scheme. Supabase refuses to redirect anywhere that is not on this list, and the
way it refuses is the problem: it silently sends the person to the site URL
instead, so the flow completes with no session and the app reports a sign-in
that came back empty. It does not look like a configuration error.

Nothing else about native sign-in needs a console: the scheme is registered in
Info.plist and the Browser plugin is wired through SPM.

## 7. The demo workspace, before screenshots

- [ ] `brendancreataco@gmail.com` holds **owner** on the demo org. Keep or
      remove.
- [ ] Confirm the demo data is what you want photographed. It is currently
      3 technicians and 21 stops on a day, no real addresses, no gate codes,
      no customer detail.

Then I can regenerate the App Store screenshots. The existing 11 were for
choosing shots, not for submitting, and they predate today's UI.

---

## 8. Facebook sign-in — IN REVIEW at Meta

Live and verified from our side. One thing is still not checkable from here:

- [ ] Confirm the Meta app is **Live**, not Development, once review completes.

In Development it works for anyone with a role on the app and fails for every
real buyer, and the two are indistinguishable to an unauthenticated request —
so no automated check can see the difference. Test it with an account that has
no role on the Meta app.

**A note on how this was found broken.** The Client IDs field originally held an
app ACCESS TOKEN, `APPID|APPSECRET`, so the app secret was going out in a query
string on every attempt and Facebook was answering "Invalid App ID" inside a
200 response. `check:oauth` passed it, because it only knew how to read a 4xx
and a redirect-to-error. It now reads the body and refuses any `client_id`
containing a pipe. The secret has been rotated.

## 9. The service worker is still 404 in production — NEW to this list

Not submission-blocking: the iOS binary does not use it, and this is web-only.
It is on the list because it affects every web visitor right now, it has been
open since 2026-08-28, and it cannot be fixed from the repo.

- [ ] Make the host serve `/sw.js` from the build output at
      `https://app.houndstack.com`.

Re-measured 2026-08-30 with `npm run check:pwa:live`:

```
/sw.js                 404
/manifest.webmanifest  200
/favicon.ico           200
```

Files from the same build directory are served; the worker specifically is
not. `src/pwa/register.ts` calls `serviceWorker.register("/sw.js")` on every
production page load, so every visitor gets a console error, no install
prompt, and no offline tolerance.

**The build is not the problem and never was.** `check:pwa` reads
`.output/public`, proves the worker is emitted with a populated precache, and
has been green throughout — correctly. #145 established this and said so
plainly: *"WHAT IT DOES NOT DO IS FIX THE DEPLOY. The build emits the file and
the host does not serve it, which is a hosting question rather than a repo
one."* That is still true, which is why it needs you rather than a commit.

**One repo-side follow-up, deliberately deferred.** `check:pwa:live` is the
only `check:*` script no workflow runs — it was written CI-safe on purpose
(exit 1 only when the origin ANSWERS and the worker is missing, so a flaky
network cannot fail a build) and then wired to nothing. Wiring it now would
put a knowingly-red gate into CI, which is the habit `sandboxes.yml` already
warns about: a check that can only be red teaches people to ignore it. Wire it
**after** the host is fixed, the way the signed-in viewport sweep was made a
gate the day its 22 failures reached zero.

## Things you do NOT need to do

Listed so they stop taking up room.

| | state |
|---|---|
| Google sign-in | **live on the web**, verified against a real Google sign-in page |
| Account deletion (5.1.1(v)) | **live in production**, `authenticated`/`service_role` only |
| Auto-routing | **fixed and verified in production** — 21 stops split 8 / 7 / 6 |
| Routing panel | reduced to who / which days / Apply |
| Frequency repricing + visit-debit bounds | applied to production |
| Migration drift | in sync — 302 files, 276 applied, 201 functions declared |
| Deploy | `main` is live; `latest_commit_sha` matches |

---

## The iOS app DOES have sign-in buttons now — this section was stale

Superseded, and worth reading because the old answer is still quoted around.

Asked on 2026-08-26, the answer was "deliberate: the whole OAuth block sits
behind `!IS_NATIVE_BUNDLE`, so the binary ships email sign-in only," with a
recommendation to ship v1 that way. **That stopped being true on 2026-08-27.**
`src/routes/auth.tsx` now carries the header *"OAUTH SHIPS IN THE BINARY,
2026-08-27"* and the block is no longer gated.

What changed is the half that could change. Google still refuses OAuth inside
an embedded WebView (`disallowed_useragent`) and the app's WKWebView is still
one — that never went away. The native path stopped using the WebView:
`nativeOAuthSignIn` opens the provider in SFSafariViewController through
`@capacitor/browser`, which Google treats as a system browser, and the session
comes back through the custom URL scheme. Apple does not even need the browser
— `nativeAppleSignIn` uses the system ASAuthorization sheet and returns a token
directly.

**Guideline 4.8 is now satisfied rather than dodged.** Sign in with Apple is
offered alongside Google and Facebook instead of nothing being offered. Apple
must stay in that list for as long as either of the others is in it.

**This is why item 6 is blocking and not housekeeping.** With OAuth buttons in
the shipped binary, the Supabase redirect allow-list is the difference between
a working sign-in and one that fails silently. Supabase does not reject an
unlisted redirect; it sends the person to the site URL instead, so the flow
completes with no session and the app reports a sign-in that came back empty.
A reviewer tapping "Sign in with Apple" would hit exactly that. Under the old
email-only plan the entry could wait; it cannot now.

## How to deploy, when you need to

`main` is deployed from Lovable. Merging alone does not ship anything.

A migration is different: it must be **applied to production separately**,
before the deploy that depends on it. Otherwise the code goes live calling a
function the database does not have. That gap was real for a few hours on
2026-08-25 with account deletion.
