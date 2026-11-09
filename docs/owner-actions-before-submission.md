# What still needs you

Everything in here needs a console, an account, a card, or a judgement call
that is not mine to make. Nothing in here can be done from the repo.

Ordered by what blocks the most. Last measured 2026-09-09 against `main`
(`2799691`), except item 11, added 2026-09-11 against `5ec7654`. The 2026-08-26 pass against `76410a0` is what most of the DONE
entries below rest on; item 2 was re-measured on 2026-08-30, and item 6, item 7
and item 9 on 2026-09-09. **Items 7, 11, 11b, 12 and 13 were re-checked on
2026-10-04 against `a47e2a52`** and production, read-only.

## What is still open, in one list (2026-10-04)

The sections below keep the history of each item; this is the list to work
from. Each line says where the detail is.

1. ~~**Backups.**~~ **DONE 2026-10-04.** `BACKUP_PASSPHRASE` is set; run
   37213954144 made an encrypted backup (140 tables, 47,799 rows) and the
   drill restored it into an empty database: 140 of 140 tables with exactly
   the backed-up rows, all 232 foreign keys intact, 6 cron jobs restored and
   switched off. The first run's drill had failed on the email queue tables
   (#328). Nightly from here; the drill repeats every Sunday.
2. ~~**iOS push.**~~ **DONE 2026-10-04.** The owner's iPhone registered at
   17:30 UTC on a business account and a test notification arrived. Two gaps
   found on the way: a platform-admin login never registers (correct: nothing
   pushes to one), and the app had no way to ask again. Preferences now has
   "Notifications on this phone" (ask, open iOS Settings, send a test to your
   own devices), and push failures report to Sentry (#331).
3. ~~**Sentry.**~~ **DONE 2026-10-04.** Published; test errors arrived from
   the iOS app (HOUNDSTACK-1) and the server (HOUNDSTACK-2), with no name,
   email or IP. Crash Data is declared in App Privacy. Errors from the
   platform console now carry the admin's user id too (#329).
4. **Routing and geocoding: decided 2026-11-09, Google Maps Platform for now**
   (item 11, #529). What is left is yours: create the $25/month budget alert,
   read the caching terms, then turn Google on with `ROUTING_PROVIDER=google`
   and `GEOCODING_PROVIDER=google` next to `GOOGLE_MAPS_API_KEY` (Geocoding
   API + Routes API only) -- all in `docs/google-maps-spend.md`. Until those
   two are set, the app still uses the OSRM demo and Nominatim/Geocodio, key
   or no key.
5. **The `Mac0s` runner** (item 12): still 16 GB, swap 83% used on
   2026-10-04, Supabase CLI still v2.78.1 against v2.119.0.
6. **Check the Google map once in the iOS app, and confirm the budget alert**
   (item 13).
7. **Diarise the Sign in with Apple secret expiry** (item 1), parked
   deliberately.
8. **Drop `backup.demo_geo_20260830`** when you are happy with the Detroit
   demo (item 7). It is still there on 2026-10-04.
9. The App Store pre-submit list: `docs/app-store-submission.md` §5.
10. The person-only QA items: `docs/owner-qa-checklist.md` — chiefly one real
    Stripe charge and an install on a physical handset.

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

**Parked by the owner on 2026-09-15**, deliberately rather than forgotten. It is
recorded here because the failure mode is silent: nothing in this repo can
detect a lapsed Apple secret, so the only thing standing between you and a
sign-in method that stops working is a calendar entry. Worth making once the
launch settles.

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

## 4. App Privacy questionnaire — DONE, one addition open

Answered before error monitoring shipped. Since #323 the app sends crash
reports to Sentry, so **Diagnostics › Crash Data** needs adding; see item 3 in
the open list above.

## 5. Category — DECIDED: Productivity

- [x] **Done, 2026-09-15.** Set in App Store Connect, as Productivity then
      Business. The doc and the console agree again.

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

**RESOLVED by 2026-10-04.** Read from production that day: `Demo Pet Waste Co`
has one zone, `Main`, whose ZIP list is metro-Detroit 480xx–483xx and which
holds all 110 of its properties, and each franchise location has two Detroit
zones of its own. The seed that Reseed runs writes Detroit too since #320
(20261004010000). The paragraph below is what was true on 2026-09-08.

**A second thing the relocation missed, found 2026-09-08.** The
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
you are happy. (Still present on 2026-10-04.)

Still open, and both still need you:

- [x] **Keep. Decided 2026-09-15.** `brendancreataco@gmail.com` holds owner on
      the demo org. It costs nothing and it exercises the Google sign-in path
      with a second real account, which no automated check does.
- [x] **The two franchise locations were on `America/Chicago`. Settled
      2026-09-12: both are Eastern.** You decided they were not a deliberate
      fixture, and the evidence agreed -- their own customers average
      42.580, -83.188 and 42.284, -83.141, which is metro Detroit, and
      `provision_franchise_location` copies the PARENT's timezone, so a location
      created today would already be Eastern. These two predate
      `20260805080000`, whose `WHERE` matched the parent alone.

      Applied as `America/New_York` rather than the `America/Detroit` this entry
      originally proposed, because that is what the parent already holds and the
      two are the same offset and the same DST rules. Matching the parent is
      also what the provisioning function would have produced.

      `20260819130000`'s decision that each location uses its OWN clock is
      untouched and still correct. It was right about the design and wrong about
      one input. The cost, weighed and accepted: the demo data no longer spans
      two timezones, so nothing in the seed exercises that rollup path by hand.

**Three routing settings on the demo org were stale in the same way, and are
now fixed.** None of these needs anything from you; they are recorded because
they came out of the same relocation and the same 2026-08-05 "NYC demo org"
migration, which set four values in one statement and was only ever undone one
value at a time.

| | was | now | why |
|---|---|---|---|
| `area_type` | `dense_urban` (11 km/h) | `suburban` (28 km/h) | 110 properties average 42.486, -83.151. 11 km/h is documented as "Manhattan, Boston core". |
| `road_factor` | 1.45 on the parent, 1.30 on everyone else | **1.35 everywhere, including the column default** | 3,168 measured OSRM legs give a median of 1.354. Both values in use were wrong, in opposite directions. |
| `timezone` | `America/Chicago` on both locations | `America/New_York` | above |

- [x] **Dropped, 2026-09-15.** `park_walk_min` stays 6 on the parent and 2
      elsewhere. Owner's call, and a reasonable one: it pulls in more variables
      than the difference is worth, and the difference is four minutes on demo
      data. The measurement attempt below is kept because it explains WHY it
      could not be settled with evidence, which is the part worth not
      repeating. **`park_walk_min` is 6 on the parent and 2 on every other
      organization** -- the fourth value from that same statement. 6 minutes is
      a city figure: find a space, walk back. 2 is a suburban driveway.

      I tried to measure it rather than guess and could not. There is no
      `arrived_at`, but the gap between one visit's `completed_at` and the next
      one's `started_at`, minus the OSRM road time for that leg, IS park and
      walk. The data cannot carry it: 324 visits have both timestamps and they
      hold **four distinct service durations** between them, with a median
      inter-stop gap of 64 minutes. Those timestamps are seeded, not observed,
      so the residual measures the seeder.

      So this one is a judgement, not a measurement. Say 2 and it matches
      everything else in one statement.

## 8. Facebook sign-in — LIVE

Live and verified from our side. One thing is still not checkable from here:

- [x] **Live, confirmed 2026-09-15.** Review completed and the app is Live, so
      it now works for buyers with no role on the Meta app.

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

- [x] **Decided 2026-09-15: no, and commit straight to `main`.** Through launch
      the workflow is commits to `main` rather than feature branches, with
      releases staying a manual step. Branches come back when the product is
      stable and the work turns into hot fixes or a 1.1. The deployment gate
      still grades whatever is live rather than the commit it is attached to —
      that is understood and accepted for now, not overlooked.

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

- [x] **Decided 2026-09-15: no nightly job.** Reconciliation stays event-driven.
      The owner's reasoning, and it is the right one: every change that moves a
      seat count is initiated through this product, so the record already exists
      at the moment it happens and a nightly sweep re-derives what is already
      known. The 2026-09-09 warning on the users page stays, because that is
      what makes a failed event visible rather than silent.

It is perhaps fifteen lines in `src/routes/api/public/hooks/nightly.ts`, calling
the `syncOrgSeatQuantity` that already exists. What makes it yours rather than
mine is that it adds an unattended Stripe API call per organization per night,
every night, forever. That is an operating cost and a rate-limit surface, and it
should be chosen rather than arrive in a commit.

## 11. Decide where the routing engine runs — DECIDED 2026-11-09: Google, for now

**Decision (Brendan, 2026-11-09, #529):** geocoding and routing run on Google
Maps Platform (Geocoding API, Routes API Compute Route Matrix) for now, instead
of Geocodio plus a self-hosted OSRM server. No self-hosted router and no new
paid vendor. Spend over $25/month must alert. The provider sits behind one
setting (`ROUTING_PROVIDER` / `GEOCODING_PROVIDER`, src/lib/providers/config.ts)
so routing can move to OSRM when volume makes it cheaper. Weather is out of
scope. The owner steps -- server key, budget alert, caching terms -- are in
`docs/google-maps-spend.md`. The history below is kept for context.


**What changed by 2026-10-04, none of which decides it.** The planner's search
moved out of Postgres into `src/lib/route-solver.ts` (#298); the app now skips
OSRM when every leg is cached and fresh, paces the public demo 1.1 s apart,
counts every measuring run in `road_leg_runs`, and shows a Routing health card
on /platform/overview. Geocodio is wired: setting `GEOCODIO_API_KEY` switches
every server-side geocode to it. Whether `OSRM_URL` or `GEOCODIO_API_KEY` is set
in production is a Lovable secret this repo cannot read, and `road_leg_runs`
held no rows on 2026-10-04, so the health card has nothing to say yet. The two
decisions below are still yours.

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
      The paid way out is already wired: setting `GEOCODIO_API_KEY` switches
      every server-side geocode to Geocodio (imports and backfills as one batch
      request), with Nominatim kept as the fallback when it errors.

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

- [ ] Run the Google arm, and decide from the number whether a paid matrix is
      worth it. **Two of the three arms have been run; the Google one has
      not**, because this environment has no `GOOGLE_MAPS_API_KEY`. Set one and
      the harness does the rest -- about 2,000 elements for a full run, and it
      refuses rather than overspending past `--max-elements`.

What the two runnable arms produced on 2026-09-11, against OSRM rather than
Google:

| | |
|---|---|
| straight-line estimate vs OSRM road time | **3.4x-3.7x** at the median, up to **6.1x** on the worst leg |
| cost of the ORDER that estimate picks | about **6.6%** more driving |
| actual road speed | p10 28.4, median 36.9, p90 45.0 km/h |
| actual road factor | p10 1.14, median 1.34, p90 1.79 |

The bottom two rows are what `road_factor` and `area_type` were corrected
against in section 7. **Parity with Google remains unclaimed and unmeasured** --
this compares the app's own estimate against OSRM, which is a different
question from whether OSRM matches a commercial matrix.

Two things it cannot tell you, both printed in its own output: it samples the
fullest days, so the percentage is not a fleet average, and on this database
those days all belong to ONE organization, which makes it a measurement of one
road network rather than of routing in general.

A third, learned by running it: the first version reported two days where
routing on the WORSE matrix produced a BETTER order, which cannot be true of
cost models. The solver's greedy start was a free variable worth 12-15% of
spread against an effect of 3-6%, so the number was reporting which stop
happened to sort first. Fixed by trying every start; the figures above are from
after that.

## 11b. The Auth server's connection cap — DONE

- [x] **Switched by the owner to percentage-based allocation.** Evidence: the
      Supabase performance advisor run on 2026-10-04 no longer reports the
      Auth connection finding (its only findings are unindexed foreign keys,
      unused indexes and the backup table's missing primary key).

What follows is the 2026-09-16 finding, kept for why it mattered.

Found on 2026-09-16 by running Supabase's PERFORMANCE advisor, which had never
been run against this project. Recorded nowhere before now.

> Your project's Auth server is configured to use at most **10 connections**.
> Increasing the instance size without manually adjusting this number will not
> improve the performance of the Auth server. Switch to a percentage based
> connection allocation strategy instead.

Supabase's own remediation link is the *going into production* guide, which is
the transition this product is making right now. It is inert while one demo
tenant signs in. It becomes the ceiling on concurrent sign-ins the moment real
ones do, and the trap in that sentence is the expensive one: paying for a bigger
instance and getting no more Auth throughput, because the allocation is absolute
rather than proportional.

- [x] Switch Auth to percentage-based connection allocation in the Supabase
      dashboard, before the first real sign-in load rather than after.

**The security advisor was re-run at the same time and nothing regressed** — the
6 anon-executable functions are the same 6, the 9 deny-all tables the same 9, no
ERROR-level findings. Compared by name rather than by count, because
`docs/security-advisor-triage.md` opens by warning that the count moves. The
full re-run is recorded at the end of that file.

## 12. The `Mac0s` CI runner — NEW to this list, and the newest of these entries

Every workflow in this repo runs on one self-hosted Mac. Three separate faults
appeared on it on 2026-09-13 and 14, and none of them is in the code. They are
here rather than only in a chat log because the machine is yours and this is the
list of things that are.

**1. `setup-node` went from about five minutes to about nineteen, in a step, in
one night.** Measured off the job timings of consecutive runs:

| run | started | `actions/setup-node@v4` |
| --- | --- | --- |
| #208 CI | 12:33 UTC 09-13 | 5m 32s |
| #209 CI | 13:47 | 7m 09s |
| #210 CI | 16:56 | 4m 41s |
| #211 Sandboxes | 02:47 UTC 09-14 | **19m 16s** |
| #211 CI | 03:36 | **19m 19s** |

Something changed between 17:00 and 02:30. It is not the workflow — `cache: npm`
is configured and unchanged — and it is not the repo, because the same step on
the same file took five minutes the afternoon before. On a single runner this is
not cosmetic: six jobs a pull request at fourteen extra minutes each is most of
an hour of wall clock per change.

**2. A bus error in the native build.** #211's first CI attempt died with
`Bus error: 10` — exit 138, SIGBUS — partway through `npm run build:native`:

```
76656 Bus error: 10   npm run build:native
transforming...
##[error]Process completed with exit code 138.
```

The same command on the same commit completes elsewhere in 12.46 seconds, and
the step passed on a later attempt in 24 seconds. A process killed by SIGBUS is
a memory or filesystem fault, not a failing test.

**It happened a second time the same day**, on #214, which is what turns this
entry from an anecdote into a pattern. Same signal, different step — the "Build
(and verify the service worker is real)" step of `Typecheck, lint, tests`:

```
✓ built in 9.24s
sh: line 1: 93391 Bus error: 10           vite build
##[error]Process completed with exit code 138.
```

Read those two lines together. **Vite reported success and the process was then
killed.** Typecheck had already passed and all 3,625 unit tests had already
passed on that same commit, in that same job, minutes earlier. There is no
reading of that in which the diff is at fault.

The single permitted re-run passed the identical step in 34 seconds — and, on
the same machine within the same hour, `setup-node` came back down to 4m57s.
Fault (1) and fault (2) are therefore not independent: the machine was slow and
throwing bus errors in the same window, and recovered from both together. That
is one underlying problem with two symptoms, which is the useful thing to know
before chasing them separately.

**3. The browser sweep ran out of its budget**, cancelled at 30m13s against
`timeout-minutes: 30`, with the last of its three sweeps mid-run. That one is
half mine — the case-spec step gained four specs on the 13th and 14th — and the
budget is now 45 minutes, with the arithmetic in a comment in
`sandboxes.yml`. But 19 minutes of a 30-minute budget spent before any test
ran is what actually tipped it, so the raise is a splint and not a repair.

**3b. A job cancelled mid-run with nothing superseding it.** On #214's first
head the browser sweep was **cancelled** at 22:04Z, four minutes into "Measure
the one-off cases", having already passed the public and signed-in sweeps. Both
workflows use `concurrency: cancel-in-progress` keyed on `github.ref`, so a push
cancels an in-flight run — but no push had happened, and no newer run existed
for that ref. Nothing asked for that cancellation.

Worth separating from (3): that one ran out of a budget, which is a number a
human chose. This one was taken away while it was working, which is not.

**4. And, separately, the container-restart race**, which predates all of this:
`failed to execute http request: Get "http://127.0.0.1:54321/storage/v1/bucket":
context deadline exceeded` on the database job, three occurrences, each after
every migration had already applied, each cleared by a single re-run. The
Supabase CLI on the runner is v2.78.1 against v2.117.0 current.

- [x] **Measured 2026-09-15. It is MEMORY, and it is not close.** This asked for
      disk health first, then memory. Disk is fine — 69Gi free on root, 199Gi on
      `RufloLocal`, both about 10-15% used. Memory is not:

      | | |
      |---|---|
      | physical RAM | **16 GB** |
      | swap | **15.4 GB used of 16.4 GB — 94% full** |
      | swapouts since boot | **277,844,036** |
      | swapins since boot | 265,362,767 |
      | load average | **59-72 on 8 cores** |
      | uptime | 17 days |

      A quarter of a billion swapouts and a 94%-full swap file is not a busy
      machine, it is a machine that has been thrashing for a long time. And it
      explains **every** fault in this section with one mechanism rather than
      four coincidences.

      **Why SIGBUS specifically.** Vite, esbuild and rolldown all read through
      `mmap`. When the system cannot back a memory-mapped page — which is what
      an exhausted swap file means — the access raises SIGBUS, not ENOMEM. That
      is exactly the shape of fault (2): *"Vite reported SUCCESS and the process
      was then killed."* The build finished, and the teardown touched a page the
      kernel could no longer produce.

      The same pressure explains `setup-node` at 19 minutes against a normal 5
      (unpacking a tarball while paging), a browser sweep that overran its
      budget, and a viewport spec that failed on an assertion about *geometric
      stability*, which is the first thing to break when frames arrive late.

      **What is actually on this machine**, measured while CI was queued: Docker
      Desktop with 12 containers, an Android emulator, a Playwright sweep,
      Chrome, Finder, and `ChatGPT.app` at 68% CPU. The self-hosted runner is
      sharing 16 GB with an interactive desktop.

      **In fairness, some of that load was mine** — the emulator and the sweep
      were my doing, and I stopped the emulator on finding this. But swap does
      not reach 94% and a quarter-billion swapouts in one afternoon; that is 17
      days of accumulation, and it was already true on 2026-09-14 when the two
      bus errors landed.

      **Three flakes in one afternoon, all the same shape.** Collected while
      doing other work on 2026-09-15, and each one re-run to prove it rather
      than assumed:

      | spec | failure | on re-run |
      |---|---|---|
      | invoices filters (CI) | stability timeout at 90s | passes locally |
      | `/get-started` at 402px | "execution context was destroyed" | 149 passed |
      | iPad Pro portrait clip check | `page.goto` timeout at 90s | 149 passed |
      | the tech search bar (CI) | `toBeVisible()` after 1.7m | **5 passed in 42.9s** |
      | the day map at 768px (CI) | `toBeVisible()` after 1.7m | **5 passed in 42.9s** |

      The last two are the sharpest illustration in the set: on the runner they
      burned 1.7 minutes each and failed; on the same source locally the whole
      file passes in under forty-five seconds.

      None is a layout fault. All three are a timeout or a stability assertion,
      which are the first things to break when the machine cannot schedule
      promptly. `playwright.config.ts` has `retries: 0`, so any one of them
      fails a whole run and is indistinguishable from a real finding until
      somebody re-runs it by hand — which is the second-order cost of the
      memory problem and the reason it is worth fixing rather than living with.

      **And then it happened again, an hour later, on a one-character diff.**
      CI run 35032585730 on `3002bbb`, 2026-09-15 23:15, in the "What ships
      inside the native binary" step:

      ```
      transforming...✓ 760 modules transformed.
      ... 89495 Bus error: 10           npm run build:native
      ##[error]Process completed with exit code 138.
      ```

      That commit changes one character inside a string literal — an em dash to
      a colon, to satisfy `check:em-dashes`. There is no reading of that diff in
      which it produces a bus error.

      This is the **third** SIGBUS on this runner and the first one that arrived
      *after* the diagnosis above rather than before it. The prediction the
      diagnosis makes is "Vite will keep dying at teardown while swap is full",
      and it did, on a diff that cannot be blamed. Treat this entry as
      confirmed rather than argued.

      **This probably also explains #216, which is open as a lightningcss bug.**
      That PR swaps the CSS minifier to escape a SIGABRT inside lightningcss,
      and its own investigation is what makes the case. Read its three findings
      together:

      - The panic is `serialize_name(&ident[2..])` on an ident whose backing
        string is **empty** — and the PR says plainly that is an input **"no
        parse of real CSS produces, since every dashed ident starts with `--`
        and is therefore at least two bytes."**
      - It was **never reproduced locally**: "Forty consecutive builds *before*
        this change were clean." Every observation is from CI run
        34252803499 — on this runner.
      - The line is byte-identical in 1.32.0, 1.33.0 and master, no changelog
        mentions it, and **the issue tracker has no report of it.** For a
        library this widely used, nobody else hitting it is itself evidence.

      An impossible input, arriving nondeterministically, only on the one
      machine that is demonstrably truncating file writes and raising SIGBUS,
      is better explained by memory corruption than by a bug in the parser. The
      truncated 10.8MB `rolldown` binary found on 2026-09-15 is the same shape
      of fault: a byte sequence that should not exist, on the same host.

      **This is not an argument against merging #216.** It measures smaller CSS
      output, it removes one of three lightningcss entry points, and it is well
      evidenced. It is an argument about what it *is*: the PR already says
      "this is a reduction in exposure, not a proof that the build can no longer
      abort", and that sentence is likely more literally true than it was
      written to be. If the aborts continue after it merges, the answer is not
      the remaining two entry points — it is this section.

      Nothing has been reported upstream, and on this reading nothing should be.

      - [ ] **Decide what to do about it.** Three options, in ascending order of
            cost: reboot to clear 15 GB of swap, which buys time and fixes
            nothing; stop running CI on the machine somebody is also using, which
            is the honest fix and overlaps with the runner-shape question below;
            or more RAM, since 16 GB does not fit Docker plus an emulator plus a
            browser sweep plus a desktop.
- [ ] Update the Supabase CLI on the runner, v2.78.1 against v2.117.0
      (v2.119.0 by 2026-10-04; still v2.78.1 on the runner that day). It was
      listed here as "the most likely fix for (4)", the container-restart race.
      **It was not**, and that should be recorded before somebody updates it and
      believes the update fixed something. (4) was a PORT COLLISION: another
      project's stack held 54321-54327, Docker restarted it at every login, and
      no CLI version would have changed that. Fixed 2026-09-17 by giving this
      project 54421-54427 in `supabase/config.toml`. The update is still worth
      doing on its own merits; it is no longer a fix for anything named here.
- [x] **Decided 2026-09-15: one runner is enough, a second is not the answer.**
      The queueing is real but it is a symptom — see the memory measurement
      above. A second runner on the same host would inherit the same exhausted
      swap; a second HOST is a different proposal and belongs with the decision
      immediately above, not here.

## 13. Google draws the maps — the key's settings in Google Cloud — DONE, one check left

**The owner reports the browser key set up** (restrictions, key source). That
is a Google Cloud and Lovable setting this repo cannot read, so the boxes
below are ticked on the owner's word rather than on a measurement. What is
still open is the iOS check at the end of this section, which needs the real
key on a real build.

Every map now draws through the Google Maps JavaScript API (src/lib/maps/).
With no key, or a key Google refuses, each map falls back to the old
Leaflet + OpenStreetMap drawing, so nothing goes blank — but that fallback is
the thing you moved off, so the browser console line to look for is
`[maps] Google ...`: it says which of the three fallbacks happened.

On the BROWSER key (the one restricted to the Maps JavaScript API — not the
Places/server key):

- [x] **API restriction:** Maps JavaScript API only. Nothing else is called
      from the browser. Maps Embed, Maps Static and Map Tiles are NOT needed
      (no surface is a single pin with no overlay, so nothing qualifies for the
      free Embed API).
- [x] **Application restriction → Websites**, these entries exactly:
      - `https://app.houndstack.com/*` (the only web host; `www.app` has
        not resolved since 2026-08-10, see src/lib/app-origin.ts)
      - `https://localhost/*` — the Android app (Capacitor serves the bundle
        from `https://localhost`)
      - `capacitor://localhost/*` — the iOS app
      - optional, only if you want real maps in Lovable's preview:
        `https://id-preview--da34c6c7-a052-492e-a400-8085bfb98730.lovable.app/*`.
        Do NOT add `https://*.lovable.app/*`: that lets every Lovable app on
        the internet spend your quota.
- [x] **No Map ID is needed.** Pins are HTML overlays, not Advanced Markers.
- [ ] **A budget alert** on the billing account (not confirmed either way):
      **$25/month**, the figure decided on 2026-11-09, covering geocoding and
      routing as well as maps. Step by step in `docs/google-maps-spend.md`.
      Not a quota that would stop maps for your users — an email if something
      is wrong. It does not exist until someone creates it there.
- [x] **Where the key comes from.** Either is enough, and the app tries both:
      the Lovable Google Maps connector's
      `VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_BROWSER_KEY` (inlined at build), or a
      runtime secret named `GOOGLE_MAPS_BROWSER_KEY` (read by
      `getMapsBrowserKey` on the server). The runtime secret also covers the
      native apps without adding anything to Xcode Cloud.

**The iOS caveat, plainly.** Google documents website restrictions as
guaranteed only for `http`/`https` referrers, and the iOS app's origin is
`capacitor://localhost`. Ionic/Capacitor users report that adding
`capacitor://localhost/*` works for the Maps JavaScript API; it has not been
verified on a device here, because that needs the real key. Check it once on
the iOS build: a Google-styled map is the pass; an OpenStreetMap-styled map
with `[maps] Google refused the Maps JavaScript API key` in the Safari Web
Inspector console is the fail. If it fails, the choices are a SECOND browser
key with no application restriction, restricted to the Maps JavaScript API
and given a daily quota, used only by the native build (set it as
`VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_BROWSER_KEY` in the Xcode Cloud workflow's
environment; a key inlined at build wins over the server's) — or the native Maps
SDK for the technician's route map, which you have already planned for after
launch. Android needs no second key: `https://localhost` is an https referrer.

## Things you do NOT need to do

Listed so they stop taking up room.

| | state |
|---|---|
| Google sign-in | **live on the web**, verified against a real Google sign-in page |
| Account deletion (5.1.1(v)) | **live in production**, `authenticated`/`service_role` only |
| Auto-routing | **fixed and verified in production** — 21 stops split 8 / 7 / 6 |
| Routing panel | reduced to who / which days / Apply, plus a one-run arrival-window override since #298 |
| Frequency repricing + visit-debit bounds | applied to production |
| Migration drift | checked by `check-migrations` and `check-schema-declared` in CI. The 2026-08-26 figure was 302 files and 276 ledger rows; on 2026-10-04 it is 373 files and 348 rows. The two counts are not expected to match, because early history was applied under other names (MASTER_BRIEF §4) and MCP-applied files are recorded under the MCP's own timestamp |
| Deploy | `main` reaches production when someone presses Publish in Lovable; merging alone does not ship (see the end of this file) |

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
