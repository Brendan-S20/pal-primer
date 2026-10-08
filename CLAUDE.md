# Working agreements

## Every screen is responsive. All of them, at every size.

Phones, tablets, and desktops from small laptops to very wide monitors. This is
not a phase, a follow-up ticket, or something the mobile routes get and the
office routes do not. A view is not finished until it works at every width.

**Why this is stated as a rule rather than left to taste:** the people using
this product are a one-or-two-truck business. The owner does the office work on
a laptop in the evening and the field work on a phone in a driveway, often on
the same day, often on the same screen. "Desktop app with a mobile version" is
the wrong model — there is one product and it is used from whatever is in the
person's hand.

### What "works" means, concretely

- **No horizontal page scroll, ever.** Wide content — tables, calendars, code,
  diagrams, wide toolbars — scrolls inside its own `overflow-x: auto` container.
  The page body does not.
- **Touch targets are at least 44px.** Not the icon: the button. See
  `ui/dialog.tsx` and `ui/sheet.tsx` for the pattern — a 16px glyph centred in a
  44px box, so nothing looks different and everything is hittable.
- **Nothing important is hover-only.** Hover does not exist on touch. A control
  that appears on `group-hover` is a control a phone user cannot reach.
- **Dense grids reflow, they do not shrink.** A seven-column week or a
  six-row month laid out as one grid does not become usable by getting smaller;
  below the breakpoint it needs a different shape, not a scaled one.
- **Text truncates instead of widening its row.** A flex item is never laid out
  narrower than its own content unless it is allowed to be — `min-w-0` on the
  item, or an overflow other than `visible`. Without that the row grows to fit
  the text, the control beside it goes over the edge, and the `truncate` that
  was meant to prevent all this never engages.
- **Test the narrow end properly.** 320–360px is a real phone, not an edge
  case. A fixed `w-80` popover overflows a 360px viewport.
- **Landscape and tablet are their own sizes.** A layout that only has "phone"
  and "desktop" branches usually fails between 640 and 1024, which is every
  tablet and every split-screen window.

### Before calling any UI work done

Check it at roughly 360px, 768px, 1280px and 1920px. If a view genuinely cannot
work at one of those widths, say so and say why — do not ship it silently broken
and do not quietly narrow the scope to the widths that happened to work.

### Some of this is enforced, so you find out before review

Seven of the rules above are checked by tests that scan the whole of `src/`
and name the offending file and line rather than counting violations:

- `tests/hover-does-not-exist-on-a-touchscreen.test.ts` — a `group-hover:`
  that reveals a control must have a `max-md:` escape. Decoration
  (`group-hover:scale-105`) is deliberately not caught.
- `tests/wide-things-that-set-the-width-of-the-page.test.ts` — every raw
  `<table>` with four or more columns needs a horizontal scroll container,
  and must not be inside `overflow-hidden`, which clips the right-hand
  columns away with no scrollbar and no way to reach them. Anything built on
  `<Table>` from `ui/table.tsx` already scrolls and is exempt.
- The same file pins the touch sizing on `ui/tabs.tsx`.
- `tests/a-flex-row-as-wide-as-its-longest-word.test.ts` — every element that
  truncates is traced up through the flex rows it sits in, and each item on
  that chain has to be able to shrink. It parses the JSX rather than matching
  it, because the question is about nesting. Note which end it names: an
  element that carries `truncate` is exempt, because `truncate` includes
  `overflow-hidden` and that is exactly what `min-w-0` would have bought. What
  fails is the wrapper in between — the `flex-1` div with nothing else on it —
  and that is what the failure message points at. Deliberately silent on
  `whitespace-nowrap` alone, on `flex-col`, on grids, and on `shrink-0`.
- `tests/a-thumb-is-not-a-screen-width.test.ts` — touch-target SIZING is
  spelled `touch:`, never `max-md:`. The distinction is the one
  `docs/ipad-was-never-measured.md` was written about: `max-md:` is a guess
  about WIDTH standing in for a fact about INPUT, and it is wrong on every
  iPad, which is 744–1366px and all of it touch. **This one is a ratchet
  rather than a cleanup** — there were zero violations when it landed. It
  exists because the rule was learned in #115, fixed with the `touch:` variant
  in `src/styles.css`, and then broken again by #207, which spelled a new
  control's floor `max-md:min-h-11` and left two 16px buttons on every iPad
  size for two days. Deliberately silent on `max-md:` for layout
  (`max-md:flex-col`, `max-md:hidden`) and on the `max-md:` hover escapes the
  first test in this list *requires*: show-or-hide may key on width, how big a
  thing is for a finger may not.
- `tests/an-icon-does-not-give-up-its-width.test.ts` — every sized lucide
  icon carries `shrink-0`. An icon in a flex row is a flex item, and beside
  wrapping text it gives up width by however much THAT row's text needs, so
  a column of rows starts its text at a different x on every row: measured
  on the Get started checklist in the iOS simulator, identical `h-5 w-5`
  icons, titles starting anywhere from x=165 to x=177. `h-5 w-5` is a
  request; `shrink-0` is the floor, and on an icon it is never wrong. Also a
  ratchet from zero: 429 icons in 124 files were fixed in the change that
  added it.
- `tests/a-page-does-not-draw-its-own-column.test.ts` — a signed-in page's
  column (max width, horizontal gutter, top padding, the gap between its
  sections) is decided ONCE, by `src/components/PageShell.tsx`, which the
  `_authenticated` layout wraps around every page. A route component's root
  element may not carry `mx-auto`, `container`, a `max-w-*`, horizontal
  padding or a negative horizontal margin. A page that genuinely needs every
  pixel (the dispatch board, the maps, My Day) declares
  `staticData: { pageWidth: "wide" }` on its route, which lifts the 1600px cap
  and nothing else — same gutter, same left edge. A band that has to run edge
  to edge uses `PAGE_BLEED_X` and `data-page-bleed`. Ratchet from zero: 21
  page roots carried a column of their own when it landed (2026-10-02), and
  the owner's words were "the page widths should be identically the same
  when viewing it on the same size screen." The browser half,
  `tests/viewports/every-page-has-the-same-margins.spec.ts`, measures every
  signed-in page at the four widths and fails one whose column, heading or
  top-level sections start or end anywhere else.

What is NOT enforced, and still has to be looked at: whether a thing is
centred, and whether a layout is merely cramped rather than broken.

**There is a second agent on this repo, and it reads a different file.** `main`
deploys from Lovable, whose own AI agent can edit `src/` from a browser. It does
not read this file — it reads the project's *knowledge*, which was **empty until
2026-09-16** and now holds a condensed version of the rules above, section 2 of
`docs/app-store-submission.md`, and the migration rule. Set on project
`da34c6c7-a052-492e-a400-8085bfb98730` via the Lovable MCP tools
(`get_project_knowledge` / `set_project_knowledge`).

So **a change to the enforced rules above is a change in two places.** The tests
will catch an agent that breaks a rule, but only after it has written the code
and somebody has pushed it; the knowledge is what stops it being written. If you
add a sixth rule, or retire one, update both. Two copies of a rule is the setup
for exactly the drift this file keeps finding elsewhere, and the only defence is
knowing the second copy exists.

**A value with no space in it — an address, a link, an id — used to be on that
list**, described here as impossible to check mechanically, because telling a
40-character signup URL from an eight-character promo code means knowing the
value. That is true of PARSING, which is why the five tests above stop short of
it: the class list is identical either way and the JSX only says
`{org.signupUrl}`. It is not true of MEASURING. At render time the string has a
width and the box has a width, and a browser knows both. See the next section.

### And some of it is now measured in a real browser

`tests/viewports/every-public-page-at-every-width.spec.ts` loads the public
routes at 360 / 768 / 1280 / 1920 in Chromium and asserts from computed
geometry: no horizontal page scroll, no control off the side, no control under
44px below `md`, and nothing clipped with no ellipsis and no scrollbar — the
long-value fault above. Run it with `npm run test:viewports`; it needs a dev
server, which the Playwright config starts for you.

Seven things about it are worth knowing before you trust or extend it:

- **It does not replace the static tests.** Those name a file and a line, which
  a screenshot cannot, and they run in seconds with no server. The browser
  catches what a parser cannot see; the parser says where to go and fix it.
- **It now covers signed-in routes too, on a stubbed backend.**
  `every-signed-in-page-at-every-width.spec.ts` sweeps twenty authenticated
  surfaces on a session minted into `localStorage`, with every request answered
  by a fixture and a network fence that turns back anything not on localhost.
  No credential, nothing reaches production, and the dataset is chosen to be
  awkward on purpose — a 46-character client name, a 78-character signup URL,
  seven technicians — because a fixture that is tidier than reality measures
  nothing. Run it with `npm run test:viewports:auth`.
  It landed on 2026-08-19 with **22 failing surface/width combinations** and
  reached **zero the same day**, so the `sandboxes.yml` step is a hard gate
  rather than `continue-on-error`. Eighteen were real; **four were false
  positives in the rule itself** and are worth knowing about before you trust a
  finding — see `docs/mobile-ux-audit.md` §6.8.

  Three things those fixes taught, which will save you a cycle each. **A list
  of off-side controls is a list of SYMPTOMS** — find the outermost element
  wider than the viewport, the one whose parent still fits; on `/clients/:id`
  the obvious culprit was a real fault that was not the cause. **Measure right
  edges, not widths** — `/clients/new` and `/my-day` overflowed with no element
  wider than the screen at all. **And a clipped element still reports a wide
  rect**, so a scan that ranks by `getBoundingClientRect()` will point at
  something inside a scroll container that cannot affect the page; on
  `/clients` the real cause was a 1x1 `sr-only` span escaping a `position:
  static` scroller.
- **Eleven Apple sizes with touch ON is a different check, and as of
  2026-09-17 it is in CI.** `APPLE_SIZES=1` substitutes the width list — 320
  to 1366, with the real heights, so a short landscape viewport is its own
  case — and sets `hasTouch`, which makes Chromium report `pointer: coarse`
  and `hover: none`. The second half is the half that finds things: on
  2026-08-21 a sweep reported 382 passed / 0 failed at iPad viewports while
  emulating a MOUSE, and the same code failed 105 of them the moment touch
  was turned on. Run it with `npm run test:viewports:apple:sweeps`. The older
  `npm run test:viewports:apple` is the unfiltered on-demand version: only 3
  of the 20 specs read the variable, so it re-runs seventeen one-off cases
  unchanged and regenerates the App Store screenshots as a side effect.
  Before this landed nothing ran either on a schedule, which is how #207 left
  two 16px buttons on every iPad size for two days — it was found by a person
  typing the command. `the-sweeps-are-not-the-whole-suite` could not catch
  that at the time: it asserted every SPEC is named by a step in
  `sandboxes.yml`, and this is the same two specs in a different MODE.
  Coverage of files is not coverage of configurations. It now checks the
  configuration too — a spec whose source reads `APPLE_SIZES` must be
  selected by a step whose script SETS it — so the hole this bullet
  describes is closed rather than merely documented.
- **Signed out is not a blank page here — it is `/auth`.** So the blank-page
  guard below is not enough for the authenticated half: `/auth` renders
  perfectly and clears every size threshold. Each surface therefore proves
  itself twice, with a locator only that page draws and a fixture string only
  its data contains. A sweep that measures the login screen twenty times is
  green and worthless.
- **A fixture of the wrong SHAPE measures the fallback, and looks exactly as
  green as one of the right shape.** Tidiness is the failure mode the dataset
  was built against; this is the other one. `visits.eta_start` and `eta_end` are
  `timestamptz`, and until 2026-09-13 the dataset emitted bare clock strings
  (`"08:15:00"`) for them. Every consumer in `src/` reads them through
  `new Date(...)`, which makes that an Invalid Date, so ScheduleCalendar,
  MobileDayList, VisitDetailDrawer, the client Visits tab, the customer portal
  and My Day's own ETA label each rendered their empty branch — and the sweep
  measured, at four widths across twenty surfaces, a label production always
  draws and the fixture never did. Nothing failed, because nothing was there.
  When you add a rule, check what the fixture actually puts on the page, not
  that the page is green.
- **Assertions of the form "nothing is wrong" all pass on a blank page**, so
  `settle()` refuses to measure a route that did not render. That guard is
  there because the sweep spent several runs green against a Vite error page
  during development, and made an earlier mutation test look successful for the
  wrong reason. If you add a rule here, add it to a page you have proved is
  rendering.
- **Safe-area insets can be emulated, so measure them rather than reading
  CSS.** Chromium's `env(safe-area-inset-*)` is 0 by default, which is why the
  first sheet fix (#332) could only assert that the rules were present. But
  `Emulation.setSafeAreaInsetsOverride` over CDP makes `env()` resolve to the
  override whatever the viewport meta says, and
  `tests/viewports/what-the-iphone-showed.spec.ts` uses it to put a dialog's
  top edge below a 62px status bar at 402x874, with a probe that refuses to
  measure until the insets have actually taken. Before that, the iPhone 17
  Pro's dialogs measured 35px from the top, inside the status bar, with every
  test green.
- **Under `isMobile`, a page wider than the phone makes the phone wider.**
  Chromium's mobile emulation zooms out to fit the layout, and
  `window.innerWidth` — the visual viewport — grows with it. Until 2026-09-28
  the overflow rule compared `scrollWidth` against `innerWidth`, so every spec
  that set `isMobile` was comparing a number to itself: `/leads` measured 495
  against 495 on a 360px phone, `/reports` 786 against 786. `rules.ts` now
  measures against the viewport the test asked for. The same fix found the
  rest of that gap: neither page had a fixture, so `/leads` drew an empty
  state narrower than the real one and `/reports` threw on a null, and the
  unlisted-route sweep — which proved only that the tab bar was on screen —
  measured the error boundary inside it. Both are now signed-in surfaces with
  data, and that sweep refuses an error boundary. Turning the rule back on
  found five more pages it had been hiding the same way: `/franchise` was 18px
  too wide, three settings pages had only ever been measured as error
  boundaries, and `/settings/automation` and `/settings/lead-form` had
  controls under 44px that no fixture had ever drawn.

A green test run is still not a substitute for opening the page at 360px.

Prior art worth reading rather than rediscovering: `docs/mobile-ux-audit.md`
(2026-07-23) audited the staff app against this standard and its findings are
still the best map of where the weak points are.

## A tech's screen speaks the tech's language.

The screens a field technician reads in a working day are listed in
`tests/support/tech-screens.ts` — My Day and everything it opens, the tab bar,
the sidebar, Preferences. On those screens every word a person reads comes from
`t()` in `src/lib/i18n/`, with the same key in `en.ts`, `es.ts`, `ar.ts` and
`zh.ts`. Many scooping techs work in Spanish, and the owner who hires them may
not; Arabic and Simplified Chinese were added on 2026-10-02 on the same screens.

**Why this is stated as a rule:** until 2026-09-29 the language picker existed
and translated about a dozen strings on My Day. A tech who chose Español got a
Spanish page title over an English route. A picker that half-works is worse
than none, because it tells the owner the job is done.

- `tests/a-tech-screen-has-no-english-left-in-it.test.ts` parses the listed
  files and names file:line for any hardcoded English: JSX text, rendered
  strings, literal `aria-label`/`title`/`placeholder`/`alt`, and `toast.*` /
  `confirm*` arguments. The escape is an `i18n-ignore` comment, used once
  (map app brand names), and the test pins that list.
- `tests/en-and-es-have-the-same-keys.test.ts` (named for the first two,
  covers all four): every locale has every English key and placeholder, and
  every plural form its language has — Arabic six (`_zero` `_one` `_two`
  `_few` `_many` `_other`), Chinese only `_other` — checked against
  `Intl.PluralRules` so the list cannot be invented; and every key a tech
  screen asks for exists.
- **Arabic reads right to left.** lib/i18n puts `dir="rtl"` and `lang` on
  `<html>`. On a tech screen, and in the `ui/` pieces they use, spell a side
  logically — `ms-`/`me-`/`ps-`/`pe-`/`start-`/`end-`/`text-start`/
  `rounded-s`/`border-s` — never `ml-`/`pr-`/`left-`/`text-left`, and flip a
  chevron that means "next" with `rtl:rotate-180`. A code, a ticket number or
  a phone number goes in `<span dir="ltr">`; a customer's or the office's own
  text (an address, a name, a note) in `<bdi>`. Maps are never mirrored
  (`useMapRenderer` sets `dir="ltr"` on its container).
  `tests/my-day-in-arabic-reads-right-to-left.test.tsx` renders My Day in
  Arabic and fails on any physical-direction class in the markup, and on any
  English; `tests/viewports/a-tech-who-reads-arabic-or-chinese.spec.ts`
  measures it at phone and iPad sizes with touch on.
- Fixed codes (skip reasons, photo kinds, statuses) are translated by code,
  with English as the fallback. Dates go through the formatters' locale
  argument, not a second formatter.
- **What stays English on purpose:** office-only screens, anything sent to a
  customer (email, SMS, portal, PDFs — those speak the business's language),
  and anything a person typed. The portal's shared components are pinned to
  English so a customer's browser language never switches them.

Adding a screen to `TECH_SCREENS` is the whole of extending the rule. Like the
rules above, this one is also in the Lovable project knowledge.

## A list renders by key, and `<>` cannot carry one.

`{rows.map(r => <>…</>)}` has no key. Not a missing one — an impossible one:
React keys the direct child of the array, that child is the fragment, and the
shorthand takes no props. Write `<Fragment key={r.id}>`.

**Why this is stated as a rule rather than left to React's warning:** because
the warning was there, in the output, and nothing acted on it.
`settings.users.tsx` mapped the user list to a bare `<>` holding two rows, and
put a key on each of the rows inside it. Those keys are inert — the rows are
static siblings in a fixed position, not a list — but they are why it passed
review. The file does not read like it forgot about keys. It reads like it
thought about them twice.

The cost is not cosmetic. Every row on that page owns state React attaches
positionally: the expanded-panel set, a `<Select>` for the role, a button
whose label reads from the row. Deactivate somebody, the list refetches and
re-sorts, and the open panel and the dropdown stay at their old offsets —
now belonging to whoever moved into that position.

It was found on 2026-09-17 in the dev-server log of an APPLE_SIZES sweep that
reported 402 passed. The sweep measures geometry and does not read the
console, so "React is logging a correctness error on every render" and "all
green" were the same run.

`tests/a-fragment-cannot-carry-the-key.test.ts` enforces it, and **parses
rather than greps**, because the question is about position and not spelling:
a text scan for `<>` finds component returns too, and the one written first
flagged three sites of which two were exactly that. It is mutation-tested
against the real file as it shipped — the pre-fix version fails it, the
post-fix version passes — rather than against a reconstruction. Deliberately
silent on a component's own `return (<>…</>)`, on a fragment passed as a
prop, on `<Fragment key={…}>`, and on a nested helper's return inside a map
callback.

## A stub backend cannot answer a question about writing.

`tests/viewports/` measures twenty authenticated surfaces and is right to run
against `fixtures/stub-backend.ts`, which says of itself `// Writes. Nothing
here writes anywhere`. Geometry does not need a database, and a sweep that
could write could corrupt itself between cases.

But it means the whole of `docs/owner-qa-checklist.md` was out of reach, and
that list is what stands between this product and being live. Nearly every
item on it is a ROUND TRIP: change a value and refresh, take a payment and
watch the invoice flip, work a queue and watch it empty. A stub returns the
fixture regardless of who asked, so it cannot tell a working page from one
whose query is wrong, or a policy scoped to the right tenant from one scoped
to none.

`npm run test:e2e` is the other half. It starts a local Supabase, checks the
migration count, seeds a tenant, and drives a browser against it — real
Postgres, real RLS, real sign-in through the two-stage form.

### Five things it had to learn, which are written into the files

- **The seeder refuses a service-role caller.** `seed_demo_org` checks
  `auth.uid()` against the caller's role, and a service-role request has none,
  so the most privileged key in the system is the one identity it rejects.
  The seed signs in as the owner instead, which means the fixture is built
  through the same path the product's own Reseed button takes.
- **It refuses an org with no field technician**, correctly: an org with
  visits and nobody to run them is a state the product cannot reach, so
  seeding one would build a fixture tidier than reality — the exact failure
  `docs/mobile-ux-audit.md` records the viewport fixtures making.
- **A trigger silently overrode an insert.** `is_field_tech: true` stored as
  `false`, because it is derived from `role` unless `is_field_tech_overridden`
  says a human decided. No error; just a row that did not say what was
  written.
- **Server-rendered HTML types fine and does nothing.** `page.goto()` resolves
  on `load`, before React attaches, so keystrokes land in the DOM while state
  stays empty and a server-rendered `disabled` never lifts. Two wrong
  diagnoses came out of that. `tests/e2e/sign-in.ts` waits for a React fiber
  rather than a timeout, because a sleep passes today and rots into a flake on
  a slower machine.
- **The browser could not be pointed anywhere, and now can be — in dev only.**
  `src/integrations/supabase/client.ts` hardcoded `https://api.houndstack.com`
  and the production anon key, while `client.server.ts` reads
  `process.env.SUPABASE_URL`. So a local run was split down the middle: server
  functions on the local database, the browser on the live one. That is why
  credentials the seed had just used successfully came back `Invalid login
  credentials`. Since 2026-09-19 the client honors `VITE_SUPABASE_URL` /
  `VITE_SUPABASE_PUBLISHABLE_KEY` — but only behind `import.meta.env.DEV`, so
  the override is compiled out of every production build and no build
  environment can repoint the shipped app. Three things guard the fix,
  because the file says of itself "automatically generated" and the Lovable
  agent edits it: `tests/the-browser-client-can-be-pointed-at-a-local-database.test.ts`
  pins the shape and fails loudly on a regeneration that drops it; the E2E
  in-process proxy (`tests/e2e/point-the-browser-at-the-local-database.ts`)
  stays as the backstop that keeps a stomped run harmless rather than writing
  to production; and the Lovable project knowledge carries the same rule.
  One consequence for the viewport sweeps: `playwright.config.ts` must NOT
  set the two `VITE_SUPABASE_*` variables for its dev server, because the
  stub intercepts `https://api.houndstack.com/**` and the network fence
  passes localhost through — pointing the browser at 127.0.0.1 would send
  every request past the fixture.

### What it covers, and what it deliberately does not

Thirteen QA-list routes render with real data and log nothing to the console.
That is the half of the list that was "open it and see". The behaviour half
followed, and is now most of the 21 specs in `tests/e2e/`, each asserting the
Postgres side as well as the screen: recording a payment flips the invoice
and writes the `payments` row; the review queue and the concerns queue empty
and stay empty through a reload; four settings round-trip through a refresh;
the board completes a visit; pricing drift clears when the price is fixed;
the accountant's CSV total matches a service-role sum; plus tech-role specs
(a billable skip, a completion with no photo, the time clock) and the portal
re-clean request. `docs/owner-qa-checklist.md` maps each checklist item to
the spec that covers it. The distinction is still worth keeping: **rendering
with real data is not the same as working**, which is why the list says per
item which half a machine proves.

Two items stay with a person permanently. One real Stripe charge, because
test mode proves the integration and not that money moved. And an install on
a physical handset, because an emulator is not a phone.

### One limitation that no longer holds

`supabase/config.toml` puts the local stack on 54421-54427, and CI's database
job used to read the same file on the same machine — so E2E could not run
while `sandboxes.yml`'s database job was running. Since 2026-09-19 that job
rewrites its own checkout's config.toml onto 54521-54527 with its own
project_id (`<id>-ci`) before `supabase start`. The project_id matters as
much as the ports: the CLI names every container, volume and network after
it, so two stacks sharing an id are one stack. The step fails loudly if the
patterns stop matching config.toml, because a silent no-op there puts both
stacks back on shared ports. 545xx is therefore taken; a third project on
this machine takes 546xx.

And the isolation bought more than coexistence: **the sandboxes database job
now runs this whole E2E suite** after the proofs, on the stack it just built
from the migrations — seed, dev server, browser, RLS live. A change to
`tests/e2e/**` or `playwright.e2e.config.ts` routes to that job on a PR; a
push to main always runs it. `reuseExistingServer` is off under CI for the
same orphaned-dev-server reason playwright.config.ts documents.

## Every migration replays into an empty database. All of them, in order.

`supabase db reset` drops the local database and replays
`supabase/migrations/` from nothing. Every file has to survive that with no
tenant, no rows, no cron schedule and no year of production history in front of
it. A migration is not finished when it applies to production; it is finished
when it applies to a database that has never seen production.

**Why this is stated as a rule rather than left to taste:** on 2026-08-15 this
repo could not do it, and had not been able to for about a month. Ten
consecutive replays turned up ten faults, and not one of them was visible to
anything else we run. Nine were in different files; the tenth was the ninth
again, because the first fix for it was wrong — a guard built on the premise
that an empty `cron.job` identifies a fresh build, which one grep of this repo
disproves, since two migrations schedule jobs of their own before that file
runs. That round is the reason the rule below is phrased as "does the sequence
being replayed establish the thing" rather than anything cleverer. `check-migrations` compares
migration file names against the applied ledger. `check-baseline-objects` asks
whether the objects those files create exist in the live database. Both compare
the repo to a database that already exists — one grown incrementally, where
every migration ran with its predecessors' *and* operations' state already in
place — so both were green the entire time. Neither asks the only question a new
environment cares about: can these files BUILD one. That is what the `database`
job in `.github/workflows/sandboxes.yml` does, and it is the only check here
that can see the class of fault where production holds state the repo's files
never describe.

### What a migration may assert, concretely

- **Never assert operations state a migration cannot itself create.** A cron
  job, a tenant, an organization with clients and an owner, rows of any kind —
  a fresh build has none of it, and an assertion that needs it fails the replay
  for a reason that has nothing to do with the change. `process-email-queue` is
  scheduled by a human at a console; no file in this repo schedules it, so no
  replay can ever satisfy it. `run-billing-cycles` IS scheduled, by an earlier
  migration in the same sequence, so asserting it is fine. The distinction is
  not "does it mention cron" — it is whether the sequence being replayed
  establishes the thing.
- **A number measured from the live database is a premise, not a product.** If
  the value came from running a query on the day the file was written — 150
  policies in `public`, 34 trigger functions, 93 unindexed foreign keys — it
  describes a database, not this change, and it belongs in `RAISE WARNING`. It
  should still print its number: the point of keeping it is that somebody reads
  the log. An assertion about what the migration ESTABLISHES stays a
  `RAISE EXCEPTION`, because a replay can prove that one from any starting
  state — "no colliding policy pair remains", "no index is left INVALID",
  "nothing returning `trigger` is reachable by anon". Security properties are
  almost always of the second kind, and downgrading one is not a trade this
  rule licenses.
- **Say so, loudly, when a check could not run.** A probe that needs two
  tenants has nothing to measure on a fresh build, and that is fine — what is
  not fine is a log where "the experiment says the leak is closed" and "no
  experiment was run" look the same. Record the skip and warn on it.
- **Never call `pg_get_functiondef` over an unbounded set of routines.** It
  raises on any `pg_proc` row that is not a plain function or procedure — an
  aggregate or a window function has no `CREATE` statement to reconstruct —
  and what lives in `public` is not the same on every database. Name the
  function (`proname = '…'`, or a `::regprocedure` literal), or read `p.prosrc`,
  which cannot raise for any `prokind` and is the function BODY, which is
  usually what the scan was looking through anyway. A `prokind` filter is not
  the fix: Postgres does not promise to evaluate AND terms left to right, so
  the planner may call the function on the row the filter was meant to exclude.

### Some of this is enforced, and some of it cannot be

Two of the rules are checked by `tests/the-wiring-is-connected.test.ts`, which
walks the migrations in filename order and names the offending file and line:
a block that `RAISE EXCEPTION`s on a cron job must name a job an earlier
migration schedules — collected after the check, so a file cannot vouch for
itself with a `cron.schedule` written below its own assertion — and no call site
may pass `pg_get_functiondef` a set it has not narrowed by name. Both are
mutation-tested against the wrong versions that actually shipped, including the
plausible-looking `prokind` fix.

**Whether a measured number would have held on a fresh build is not mechanical
and there is deliberately no test for it.** The class list is identical either
way; only a replay knows. Nothing checks that a `RAISE WARNING` deserved to be
one, and nothing stops the next `$pre$` block from pinning today's row count. So
run the job. `supabase db reset` needs Docker and the Supabase CLI, takes a few
minutes, and is worth it before merging anything that touches
`supabase/migrations/` — a green `verify` says only that the repo agrees with a
database that already exists.

## Four rules from 2026-10-02, each enforced by a test

Each landed with the change that needed it; this is where they are written down
together, and the Lovable project knowledge carries the same four (a change to
one copy is a change to both).

- **Every RLS table gets two-step sign-in.** A migration that runs
  `ENABLE ROW LEVEL SECURITY` then calls
  `SELECT public.require_mfa_policy('public.<table>');`. That policy is
  RESTRICTIVE: it can only take access away. So a check block that counts
  policies — "no FOR ALL", "exactly four", "deny-all means none" — counts
  `permissive = 'PERMISSIVE'` only; five older checks counted everything and
  broke every SQL proof the day the policy landed (#302).
  → `tests/a-password-was-the-only-lock.test.ts`
- **Maps only through `useMapRenderer`** (`src/lib/maps/`). Google bills per map
  CREATED; the hook makes one per screen, only once it is on screen, and moves
  overlays on it after that. A component that imports Leaflet or Google directly
  undoes both. → `tests/google-draws-the-maps.test.ts`
- **A SQL proof takes turns.** Every `tests/sql/*.proof.sql` takes
  `pg_advisory_lock(hashtext('houndstack.proof'))` before anything else, and the
  test file that runs it sets `vi.setConfig({ testTimeout: 300_000 })` —
  applying a migration locks the tables it alters, so proofs in parallel
  deadlocked (#300), and waiting for the lock is time vitest counts (#304).
  → `tests/the-proofs-take-turns.test.ts`
- **CI runs on Windows too.** The main test job takes whichever runner is free.
  Compare paths through `repoRelative` / `toPosix` in
  `tests/support/repo-paths.ts`, never `slice(root.length + 1)`; and an npm
  script never starts with `VAR=1 cmd`, which PowerShell cannot run — set the
  variable in a node script, as `scripts/build-native.mjs` does (#303).

Two more from 2026-10-04, same terms (both are in the Lovable knowledge too):

- **Every route is placed for Android.** A new path goes in `APP_LINK_*` (a
  staff page, which opens in the app, mirrored in
  `android/app/src/main/AndroidManifest.xml`) or `STAYS_IN_BROWSER` with a
  reason (customer pages, `/auth` as the web OAuth redirect, anything that
  buys HoundStack) in `src/lib/android-app-links.ts`. Android before 15
  cannot exclude a path inside a claimed prefix, so settings is listed page
  by page (#325). → `tests/an-android-link-opens-the-app-only-where-it-should.test.ts`
- **`postinstall` stays.** `scripts/patch-native-plugins.mjs` moves
  `@capacitor-community/apple-sign-in`'s `capacitor-swift-pm` range from 7 to
  8; without it Swift Package Manager cannot resolve and no iOS build starts
  (#324). It fails loudly only where iOS is built, so it cannot block a
  Lovable publish. → `tests/a-plugin-still-on-capacitor-7-stopped-every-ios-build.test.ts`

And one from what the owner's iPhone showed (2026-10-04):

- **A width floor is not a shrink floor.** `touch:min-w-11` replaces a flex
  item's automatic minimum ("no narrower than my content") with 44px, so a
  small button beside a long description shrank to 44px on touch and its
  label ran out through its own border ("Add card", "Add item"). Anything
  with a 44px `min-w-*` and text inside it also carries `shrink-0`; the `sm`
  and `icon` button sizes do it for every caller. A header with a title and
  description on one side and an action on the other is
  `flex flex-wrap … justify-between gap-3`.
  → `tests/a-width-floor-is-not-a-shrink-floor.test.ts`, and in a browser
  `findControlsNarrowerThanTheirLabel` in `tests/viewports/rules.ts`.

And one from the Twilio toll-free resubmission (2026-10-06):

- **The toll-free number texts account holders only.** A business's client
  or lead is texted only from that business's own subaccount, through
  `endCustomerSmsSender(orgId)` in `src/lib/twilio-credentials.server.ts`,
  which returns null rather than falling back to anything. Gateway mode (the
  platform's Twilio) only type-checks with `purpose: "account_holder"`, and
  `platformAccountHolderFrom()` is allowlisted to the inbound webhook. The
  filing says the number is "not used ... to message account holders' own
  customers"; until #341 every automated client text preferred it.
  → `tests/the-toll-free-number-texts-account-holders.test.ts`

And one from opening the product to other pet services (2026-10-08):

- **A pet-waste page is signposted only to a pet-waste business.**
  `organizations.service_lines` says what a business runs; without
  `pet_waste`, the waste log, DNA, deep clean and the other modules in
  `PET_WASTE_MODULES` (`src/lib/service-lines.ts`) are hidden from its staff.
  Any menu entry (sidebar / More `NavItem`, settings `Tab`, command-palette
  row) whose path is in `PET_WASTE_ROUTES` carries `petWasteOnly: true`, and
  its list filters on it. Hiding only: no server function refuses a write
  because of a line, nothing is deleted, a module that is still configured
  (a first cleanup, area pricing, a seasonal campaign) stays visible, and an
  answer that cannot be read is pet waste (`serviceLinesOrDefault`).
  → `tests/a-dog-walker-should-not-have-to-learn-about-dump-sites.test.ts`

And one that is not a test: **the local Supabase stack on 54421-54427 is the
database CI's test job runs the SQL proofs against** (the runner is this
machine). A branch's migration applied there for a quick look fails every other
PR's proofs until it is gone; `supabase db reset` from a main checkout puts it
back.
