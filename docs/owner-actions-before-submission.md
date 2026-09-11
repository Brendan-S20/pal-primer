# What still needs you

Everything in here needs a console, an account, a card, or a judgement call
that is not mine to make. Nothing in here can be done from the repo.

Ordered by what blocks the most. Last measured 2026-09-09 against `main`
(`2799691`), except item 11, added 2026-09-11 against `5ec7654`. The 2026-08-26 pass against `76410a0` is what most of the DONE
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

## 9. The service worker was 404 in production. FIXED, DEPLOYED, VERIFIED

Nothing here needs you any more. Kept rather than deleted because the wrong
theories are the useful part, and because two of them were mine.

**Resolved 2026-09-10.** `/sw.js` answers 200 on `https://app.houndstack.com`:
21,477 bytes, 377 precache entries. `npm run check:pwa:live` prints

```
✓ the deployed site serves its service worker and links its manifest
```

and the `deployment` job in `ci.yml` is GREEN on `main` for the first time
since it was created.

**It was not a hosting problem. It was two directories.**
`@lovable.dev/vite-tanstack-config` overrides Nitro's output paths inside the
hosted build (`nitroOpts.output = { dir: "dist", serverDir: "dist/server",
publicDir: "dist/client" }`), while `vite.config.ts` hardcoded
`.output/public` for the PWA. Everything routed through Rollup or Nitro's own
`public/` copy followed Nitro and shipped; the two files `vite-plugin-pwa`
writes directly to disk in `closeBundle` followed the hardcoded path into a
directory the hosted build never created. `PWA_OUT_DIR` now derives all three
cases and a build-time guard compares it against the client environment's
resolved `outDir`, so the two can no longer disagree silently. #188.

**This line was wrong for three weeks and it was written here:** *"it cannot be
fixed from the repo."* It could. `check:pwa` read `.output/public`, which on a
laptop is right and in the hosted build is precisely the orphaned directory, so
the one check that could have seen it was pointed at the one place guaranteed
to look correct. A green build check and a red deploy check were both telling
the truth, and the conclusion drawn from them -- that the host was at fault --
did not follow.

**Two corrections worth keeping, both about method rather than code.** The fix
was called working before it had shipped, and then called broken when the
deployment being measured had been built before it landed. Same root error
twice: a local reproduction and a partial signal each treated as proof about
production. What settled it was measuring the running site after the right
commit reached it.

**A property of the pipeline that came out of this and is worth knowing:** the
host builds the commit it had synced when the deploy was triggered, not the
newest one. There is a one-deploy lag. `check:pwa:live` now prints the
deployment id it measured (#186) precisely so that "not deployed yet" and
"deployed and broken" stop looking identical.

### What was believed while it was open, and why each was wrong

Kept because every one of these was argued from real evidence, and the evidence
was not the problem.

**"The build is not the problem and never was."** Written here, repeatedly, and
false. `check:pwa` proved the worker was emitted into `.output/public` and was
green throughout -- correctly, because on a laptop that IS the deployed
directory. In the hosted build it is the orphan. The one check that could have
caught this was pointed at the one place guaranteed to look right.

**"It cannot be fixed from the repo."** It could, and it was, in
`vite.config.ts`. This sentence sat in this file for three weeks and is the
single line that cost the most, because it told everybody to stop looking.

**"The host does not serve the file."** True as an observation and wrong as a
diagnosis. The host served every file it was given. It was never given this one.

**The `deployment` gate was right the whole time.** It was wired on 2026-09-08
(#180) as a job in `ci.yml` gated `if: github.event_name != 'pull_request'`, so
no contributor is ever blocked by a red X they cannot clear. It reported a real
fault accurately for two days while the explanation attached to it was wrong,
which is the best argument for keeping a gate red rather than removing it: the
signal outlived every theory about it.

### The measurements, which were all true and still are

None of the following is retracted. They were measured carefully and they all
still hold; they simply did not support the conclusion drawn from them, which
was that the fault lay outside the repo. Worth reading before trusting any
future "we have ruled that out".

A redeploy was triggered from the Lovable API and **completed successfully**.
`/sw.js` was polled eighteen times over six minutes and answered 404 every
time. So re-deploying was not the fix -- correct, and it stayed correct right
up until the deploy that carried #188.

Four things are now measured rather than assumed:

- **The live output is current.** `manifest.webmanifest` served from production
  is byte-identical to the one a local build produces.
- **The build is correct on a clean tree.** `.output` was deleted and rebuilt
  from nothing. Both `sw.js` and `workbox-<hash>.js` are emitted into
  `.output/public`, and both appear in the public-asset manifest embedded in
  `.output/server/index.mjs`. An earlier theory that a *stale* `sw.js` from a
  previous build was propping the local build up is **wrong**, and was tested
  before it was believed.
- **The split is exact, and it is not "static files".** Everything copied from
  `public/` is served (`push-handlers.js`, `pwa-192.png`, `favicon.svg`), and so
  is everything the client build emits through Rollup, `manifest.webmanifest`
  included. The only two files missing are the two `vite-plugin-pwa` writes
  directly to disk in its `closeBundle` hook.
- **The 404 comes from the app, not the CDN.** Served files carry an
  `x-deployment-id` response header; the `/sw.js` 404 comes back as `text/html`
  with no such header, which is the SSR worker's own not-found page. The asset
  layer never had the file to serve.

A sixth thing, added after deploying 5e633c7 as deployment `b3e2917c` on
2026-09-09: **server-rendered head content DOES reach production.** The
`rel="manifest"` link and the `theme-color` meta added in #185 are both live in
the HTML at `/auth` immediately after that deploy. So the host is not dropping
anything the SSR worker renders, and a build made from a fresh commit and
deployed the same minute still answers 404 for `/sw.js`. It is neither a stale
deploy nor a one-off bad build, and it is not "the deploy loses things
generally". It is those two files.

That last bullet is the one that mattered, and it was read backwards. "Only
those two files are missing" was taken as evidence that the DEPLOY treats them
specially. It was evidence that the BUILD does: they are the only two files
whose destination is chosen by `vite-plugin-pwa`'s own option rather than by
Nitro. The same fact, pointing the other way, and it sat in this file for a day
before anybody turned it over.

**And a further thing, which changes how to READ all of the above: the host
does not deploy on push to `main`, and it builds the commit it had synced when
the deploy was triggered rather than the newest one.** The `rel="manifest"`
fix merged at 14:20, Lovable had the commit in its preview by 14:22, and
`app.houndstack.com` went on serving the deployment triggered by hand at 13:41.
Neither new tag was live and the `x-deployment-id` had not moved.

This matters because `ci.yml` runs `check:pwa:live` as a job attached to a
COMMIT. A red result reads as "this commit is not served correctly" when what
it means is "whatever is deployed is not served correctly", and those two come
apart by however long it has been since somebody pressed deploy. So the check
now prints the deployment id it measured, and its failure text says outright
that a merged fix may simply not be deployed yet. Nothing asserts on the id:
the check has no way to know which deployment SHOULD be live. It just stops
"not deployed" and "deployed and broken" from looking identical.

- [ ] Decide whether pushes to `main` should deploy automatically. Today every
      release is a manual step, so merged work sits until somebody presses the
      button, and the deployment gate on `main` grades whatever happens to be
      live rather than the commit it is attached to.

**One observation worth keeping, which is NOT the cause.** Nitro records
`/sw.js` in that embedded manifest with `size: 21373` while the file on disk is
21442 bytes: `vite-plugin-pwa` writes the worker twice and the scan lands
between the two writes. It is inert on Cloudflare, which serves assets from its
own upload rather than from those numbers, but it is wrong, and a runtime that
did trust the recorded length would serve a worker truncated by 69 bytes, which
fails to parse and installs nothing. Recorded so that whoever fixes the deploy
does not then chase this as a second mystery.

## 9b. The app was not installable either, for an unrelated reason. FIXED AND DEPLOYED

Found while measuring the above, and fixed in the repo the same day, so this
one needs nothing from you. It is here because it changes what "fix the worker"
buys.

The HTML at `https://app.houndstack.com/auth` carried four `<link>` rels:
stylesheet, two icons, and apple-touch-icon. There was no `rel="manifest"` on
any page, and no occurrence of `webmanifest` anywhere under `src/`.

`vite-plugin-pwa` does two things: it generates `manifest.webmanifest`, and it
injects the link that references it into `index.html`. This app is
server-rendered and the web build emits no `index.html`, so the first half ran
and the second half had nothing to run against. The manifest was generated,
deployed, and served with a 200 for the life of the app, and no browser ever
read it, because a manifest is only fetched when a document links it.

So the two halves of "this is a PWA" were broken independently: no worker
(hosting) and no installability signal (this). **Fixing the worker would not
have made the app installable on its own.** The link and a matching
`theme-color` now live in `src/routes/__root.tsx`, `check:pwa:live` asks the
running site for both, and `tests/a-webmanifest-nothing-pointed-at.test.ts`
holds it in place.

Deployed and verified on 2026-09-09 as deployment `b3e2917c`:

```
  deployment             b3e2917c-2c62-4009-ac89-32756df46966
  /sw.js                 404
  /manifest.webmanifest  200
  rel="manifest" in HTML /manifest.webmanifest
```

**What that does and does not buy.** The manifest is now linked and complete:
name, short_name, three icons including a 512 maskable, `start_url`, `scope`,
`display: standalone`, over HTTPS. What is still unknown is whether Chrome
offers an install prompt without a service worker, since its installability
criteria have changed more than once on exactly that point and differ between
desktop and Android. That is a question for a real browser on a real phone
rather than for this file, and it is why the site's claim register still holds
"install it on your phone" rather than releasing it.

The 200 on `/manifest.webmanifest` is why this hid for so long. It was listed
in `check:pwa:live` as a CONTROL, proving "other files from the same build
output ARE served, so the 404 is the worker specifically". That reading was
correct and still is. It simply answers a different question from "is any of
this reaching a browser", and one 200 looked like an answer to both.

## 10. Decide whether seats should reconcile on a schedule — NEW to this list

Not blocking anything, and not urgent. It is here because it is a decision
rather than a task, and because the money can move the wrong way while it waits.

The Stripe seat-overage quantity is reconciled to the active-employee count on
three events: a staff toggle, an invite accepted, and somebody opening the
billing page. **Nothing reconciles it on a schedule** — not the nightly run, not
a cron. Checked 2026-09-09.

Each of those three is best effort by design, so a Stripe hiccup cannot block a
staff toggle, and that should not change. As of 2026-09-09 a failure is at least
visible: the users page now warns that the billing seat count was not updated
and that the next invoice may not match the team. Before that it was silent.

What is still true is that an organization which does none of those three keeps
a drifted quantity indefinitely. The direction that matters is deactivating an
employee and going on charging for the seat, on an invoice the customer has no
reason to question. The opposite direction only costs us money.

- [ ] Decide whether the nightly run should reconcile seats for every org with a
      live subscription.

It is perhaps fifteen lines in `src/routes/api/public/hooks/nightly.ts`, calling
the `syncOrgSeatQuantity` that already exists. What makes it yours rather than
mine is that it adds an unattended Stripe API call per organization per night,
every night, forever. That is an operating cost and a rate-limit surface, and it
should be chosen rather than arrive in a commit.

## 11. Decide where the routing engine runs — NEW to this list

Not blocking submission. It is here because the dispatch path currently depends
on somebody else's demo server, and that is a decision rather than an oversight.

`src/lib/road-legs.server.ts` reads real driving distances from OSRM, and
`OSRM_URL` defaults to `https://router.project-osrm.org`. That is the public
**demo** server. Its operators say plainly it is not for production, there is no
SLA, and it is rate limited.

**The same bet is already placed on geocoding.** `src/lib/geocode.server.ts`
uses OpenStreetMap Nominatim on the same terms and names the same two ways out:
a paid provider or a self-hosted instance. Neither is wrong today, and both come
due at the same time, which is the reason to look at them together rather than
twice.

### What happens today when it is unavailable

It degrades rather than breaks: `drive_minutes()` falls back to its straight-line
estimate, so the worst case is the behaviour the product had before any of this
existed. Two things are worth knowing about that worst case.

The first is that the estimate is measurably wrong, which is why the road legs
were added. Against OSRM on four consecutive legs of a real day, the road ran
**1.44x to 2.42x** the straight line, against a model assuming a flat 1.45x; and
`dense_urban` assumes 11 km/h, so a hop OSRM drives in 22 minutes was costed at
**66.7**. The ETA being wrong is the visible part. The part that matters is that
a solver minimising the wrong quantity picks the wrong ORDER, and no amount of
2-opt fixes an objective that disagrees with the road by 2.4x on one leg. On 23
real stops the difference was about 17.6 minutes and 10 miles per truck per day.

The second is that this is at least no longer silent. Since 2026-09-08 the
routing panel names the cause -- router unreachable, wrong region, day too
large -- so a dispatcher sees that the day was estimated rather than measured
before they drive it. Before that, a day costed from straight lines and a day
costed from roads produced identical output.

### What it costs to close

`infra/osrm/` already holds `build.sh`, a `docker-compose.yml` and a README.
The whole change in the app is one environment variable:

    OSRM_URL=http://<host>:5000

`OSRM_ENDPOINTS` takes a JSON map of region to endpoint if you want national
coverage from several extracts rather than one national graph.

- [ ] Decide where OSRM runs in production: self-hosted, or a paid routing
      provider.
- [ ] Decide the same for Nominatim geocoding, which rides the same terms.

What makes this yours rather than mine is that both answers cost money or a box
to run, forever, and the alternative is a third-party demo server on the path a
technician uses at 6am.

### What has NOT been measured, and should not be assumed

Nothing in the test suite measures routing QUALITY. The tests prove the planner
runs, is reachable by the role that calls it, and does not crash. Whether the
route it returns is GOOD is checked by nothing. The 1.44x-2.42x figures above
are a one-off measurement of the OLD model against OSRM, written into a comment
-- they say the previous objective was wrong, not that the current one is right.

In particular, **OSRM has never been compared against Google Distance Matrix or
any other reference.** If parity with a commercial matrix ever gets claimed --
to a customer, in marketing copy, or in a decision about paying for one -- it
needs measuring first.

There is now a harness for exactly that, added 2026-09-11:

    npm run measure:routing              # samples days, costs nothing
    npm run measure:routing -- --spend   # bills Google, reports the answer

It samples the fullest real days, builds three cost matrices over the same
stops (OSRM, Google, and the app's own straight-line estimate computed by
Postgres), solves each with one identical solver, and scores all three orders
against Google. The number it reports is minutes per day: how much longer a day
routed on OSRM takes than the same day routed on Google. Without `--spend` it
calls nothing and only prints what a real run would buy.

- [ ] Run it, and decide from the number whether a paid matrix is worth it.

Two things it cannot tell you, both printed in its own output: it samples the
fullest days, so the percentage is not a fleet average, and on this database
those days all belong to ONE organization, which makes it a measurement of one
road network rather than of routing in general.

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
