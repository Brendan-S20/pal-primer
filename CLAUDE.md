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

Five of the rules above are checked by tests that scan the whole of `src/`
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

Six things about it are worth knowing before you trust or extend it:

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

A green test run is still not a substitute for opening the page at 360px.

Prior art worth reading rather than rediscovering: `docs/mobile-ux-audit.md`
(2026-07-23) audited the staff app against this standard and its findings are
still the best map of where the weak points are.

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
- **The browser cannot be pointed anywhere.**
  `src/integrations/supabase/client.ts` hardcodes `https://api.houndstack.com`
  and the production anon key, while `client.server.ts` reads
  `process.env.SUPABASE_URL`. So a local run is split down the middle: server
  functions on the local database, the browser on the live one. That is why
  credentials the seed had just used successfully came back `Invalid login
  credentials`. The suite proxies it in-process rather than changing shipping
  code — see `tests/e2e/point-the-browser-at-the-local-database.ts` — but
  **nobody can currently run this app against a local database without that
  trick**, which is worth knowing before debugging anything locally.

### What it covers, and what it deliberately does not

Thirteen QA-list routes render with real data and log nothing to the console.
That is the half of the list that was "open it and see". Behaviour — payment
flips the invoice, a queue empties, a setting survives a refresh — is the next
piece of work, and the distinction is worth keeping: **rendering with real
data is not the same as working.**

Two items stay with a person permanently. One real Stripe charge, because
test mode proves the integration and not that money moved. And an install on
a physical handset, because an emulator is not a phone.

### One limitation, stated rather than hidden

`supabase/config.toml` puts the local stack on 54421-54427, and CI's database
job reads the same file on the same machine — so this cannot run while
`sandboxes.yml`'s database job is running. Giving CI its own port range is the
fix; it has not been done because changing how CI starts its database to suit
a local convenience is the wrong way round.

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
