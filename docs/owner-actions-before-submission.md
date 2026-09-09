# What still needs you

Everything in here needs a console, an account, a card, or a judgement call
that is not mine to make. Nothing in here can be done from the repo.

Ordered by what blocks the most. Last measured 2026-09-09 against `main`
(`2799691`). The 2026-08-26 pass against `76410a0` is what most of the DONE
entries below rest on; item 2 was re-measured on 2026-08-30, and item 6, item 7
and item 9 on 2026-09-09.

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

## 6. Allow the app's redirect URL in Supabase — DONE

Was the single most important entry here, and you did it. OAuth buttons ship in
the binary as of 2026-08-27, so until the redirect was allowed every Google and
Facebook sign-in from inside the iOS app failed, and failed silently. Ticked on
`main` between this branch being written and 2026-09-09.

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

**Relocated to metro Detroit on 2026-08-30**, on your instruction. Was
Manhattan; every address, every pin and every technician start point now sits
in the Detroit suburbs.

| | before | after |
|---|---|---|
| Demo Pet Waste Co (110) | New York, NY | Royal Oak, Ferndale, Berkley, Huntington Woods, Pleasant Ridge, Clawson, Madison Heights, Oak Park |
| — Northside (10) | New York, NY | Troy, Birmingham, Rochester Hills, Bloomfield Hills |
| — Southside (10) | New York, NY | Dearborn, Allen Park, Lincoln Park, Wyandotte, Grosse Pointe Park |

Also changed, because moving the pins alone would have left the map incoherent:

- **Staff start points.** The depot is now `1750 E Lincoln Ave, Royal Oak`, at
  the centroid of the core service area rather than an hour's drive from it.
- **1,242 cached road legs deleted.** Every one was measured between Manhattan
  coordinates. It is a cache, so routing refetches against the new geography;
  leaving them would have priced Detroit routes on New York distances.
- **ZIP, city and coordinates now agree.** The old data did not — ZIP 10023 sat
  on downtown coordinates, and Brooklyn ZIPs sat on Manhattan pins. Harmless in
  a list, wrong the moment a screenshot shows a map.

**One thing the relocation missed, found and fixed 2026-08-30.** Thirty-one
properties carry a `boundary` — the drawn yard outline, GeoJSON in its own
column. The move rewrote `latitude`/`longitude` and did not touch it, so those
yards sat in Manhattan while their pins sat in Detroit, about 500 miles apart.
Nothing surfaced it: the address reads correctly, the pin lands correctly, and
the outline only appears once you open that property's boundary view.

Fixed by translating each polygon by its own property's exact delta, taken
from the backup, so shape is preserved rather than redrawn. Verified after:
boundaries now span 42.207–42.658, every polygon is still within 108 m of its
own pin as before, and the areas shrank 2.6% — which is
`cos(42.4°)/cos(40.7°)`, the correct amount for the same shape at a higher
latitude, and therefore evidence the translation was clean rather than a
reshape.

**A second thing the relocation missed, found 2026-09-08 and still open.** The
zones did not move. `Demo Pet Waste Co` has two: `Downtown Core`, matching on
ZIPs 10001, 10002 and 10003, and `Westside Suburb`, matching on 10023 and 10024
plus a polygon over Manhattan. Every one of the 110 active properties is now in
Michigan, in 480xx and 482xx, so **no property matches any zone** and neither
zone sets a centre or radius that could reach one.

This is the same class of miss as the boundaries above: the move rewrote the
addresses and left a geographic column behind. It shows up as 54 properties
carrying a `zone_id` the matcher would no longer give them, which the zones
page now reports rather than leaving to be discovered.

I have not fixed it, and will not without you, because both repairs are
plausible and they are not equivalent. **Re-running zone detection** clears
those 54 assignments, which is right if the ZONES are what is stale.
**Rewriting the two zones to Detroit ZIPs** keeps the assignments meaningful,
which is right if the zones are meant to describe the demo service area. The
first is one button on the zones page; the second is two rows. Say which and it
is done in a minute.

House numbers are synthetic and street names are real to those suburbs, so the
addresses read correctly without being anyone's home. The previous values are
in `backup.demo_geo_20260830` (130 properties, 10 staff); drop that table once
you are happy.

Still open, and both still need you:

- [ ] `brendancreataco@gmail.com` holds **owner** on the demo org. Keep or
      remove. Unchanged — this was not part of the relocation.
- [ ] **The two franchise locations are on `America/Chicago`.** Metro Detroit
      is Eastern, so their clocks read an hour off the parent, which is on
      `America/New_York`. I did not change it: a parent and its locations
      deliberately disagreeing may be the fixture that demonstrates per-location
      clocks, which is what
      `20260819130000_every-location-kept-the-parents-clock-and-rolled-over-an-hour-early`
      exists for. If it is not deliberate, the fix is `America/Detroit` on all
      three and I can do it in one statement. Worth settling before screenshots,
      because a time an hour out is the sort of thing a reviewer notices.

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

**That follow-up is now done, resolved differently.** This section used to say
`check:pwa:live` should be wired **after** the host was fixed, because a
knowingly-red gate teaches people to ignore it. The objection was right; the
conclusion was not, and waiting had already cost three weeks of silence.

It was wired on 2026-09-08 (#180) as the `deployment` job in `ci.yml`, gated
`if: github.event_name != 'pull_request'`. That is what dissolves the
objection: **a pull request never sees it.** No contributor is ever blocked by
a red X they are powerless to clear, which was the actual harm. It is a hard
gate on `main` and on manual dispatch, where the state it reports is state
somebody can act on.

So `main` is red today, on purpose and accurately, and goes green the moment
the host serves the worker. Re-measured on every push since; still 404.

**And it now costs a marketing claim too.** `docs/MARKETING_CLAIMS.md` in the
site repo lists "works offline", "install it on your phone" and "progressive
web app" as blocked, because the machinery is built and correct here and simply
is not served. It is a strong claim for a product used in driveways with one
bar of signal, and it is unavailable until this is fixed.

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
