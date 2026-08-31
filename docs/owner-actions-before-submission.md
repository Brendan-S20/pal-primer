# What still needs you

Everything in here needs a console, an account, a card, or a judgement call
that is not mine to make. Nothing in here can be done from the repo.

Ordered by what blocks the most. Last measured 2026-08-26 against `main`
(`76410a0`), deployed and live.

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

- [ ] It is currently at the repo root. It is now gitignored, and it has never
      been committed, so nothing has leaked.

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

- [x] Set it in App Store Connect. `docs/app-store-submission.md` already says
      Productivity; App Store Connect said Utilities, so ASC is the one to
      change.

## 6. Allow the app's redirect URL in Supabase — NEW, and native sign-in needs it

- [x] Supabase → Authentication → URL Configuration → **Redirect URLs** → add
      `consulting.thenorth.houndstack://auth-callback`

Sign-in from inside the iOS app hands back to the app through that custom URL
scheme. Supabase refuses to redirect anywhere that is not on this list, and the
way it refuses is the problem: it silently sends the person to the site URL
instead, so the flow completes with no session and the app reports a sign-in
that came back empty. It does not look like a configuration error.

Nothing else about native sign-in needs a console: the scheme is registered in
Info.plist and the Browser plugin is wired through SPM.

## 7. The demo workspace, before screenshots

- [x] `brendancreataco@gmail.com` holds **owner** on the demo org. **Decided
      2026-08-31: keep.** Keep or
      remove.
- [ ] Confirm the demo data is what you want photographed. It is currently
      3 technicians and 21 stops on a day, no real addresses, no gate codes,
      no customer detail.

Then I can regenerate the App Store screenshots. The existing 11 were for
choosing shots, not for submitting, and they predate today's UI.

---

## 7. Facebook sign-in — IN REVIEW at Meta

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

## Why there are no sign-in buttons in the iOS app

Asked on 2026-08-26, and the answer is that it is deliberate. The whole OAuth
block sits behind `!IS_NATIVE_BUNDLE` in `src/routes/auth.tsx`, so the binary
ships email sign-in only. Two reasons, and the first is the hard one:

**Google refuses to run OAuth inside an embedded WebView.** It answers
`disallowed_useragent`. A Capacitor app IS an embedded WebView, so the button
cannot be made to work there however it is wired. A native flow needs
`ASWebAuthenticationSession` and a deep link back into the app, which is real
work rather than a flag.

**Guideline 4.8** requires Sign in with Apple wherever an app offers
third-party sign-in. Shipping Google alone would invite a rejection; shipping
none avoids the rule entirely.

Now that Apple genuinely works, an Apple-only button in the binary would
satisfy 4.8 by construction and dodge Google's WebView block. It is still not a
one-line change: the redirect comes back to `capacitor://localhost` and has to
be caught and handed to the session, which is the "proper native auth flow"
this repo has never had.

**Recommendation: ship v1 without it.** Email sign-in works in the binary,
nothing blocks submission, and 4.8 stays unengaged rather than merely
satisfied. Add native Sign in with Apple as a follow-up, when there is time to
do the deep link properly rather than at the end of a submission checklist.

## How to deploy, when you need to

`main` is deployed from Lovable. Merging alone does not ship anything.

A migration is different: it must be **applied to production separately**,
before the deploy that depends on it. Otherwise the code goes live calling a
function the database does not have. That gap was real for a few hours on
2026-08-25 with account deletion.
