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

Four of the rules above are checked by tests that scan the whole of `src/`
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

What is NOT enforced, and still has to be looked at: whether a thing is
centred, and whether a layout is merely cramped rather than broken.

**A value with no space in it — an address, a link, an id — used to be on that
list**, described here as impossible to check mechanically, because telling a
40-character signup URL from an eight-character promo code means knowing the
value. That is true of PARSING, which is why the four tests above stop short of
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

Four things about it are worth knowing before you trust or extend it:

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
  **It is RED by design while its findings are worked down — 22 surface/width
  combinations when it landed, 16 as of 2026-08-19.** They are real, they are
  listed with measured numbers in `docs/mobile-ux-audit.md` §6, and until they
  clear the `sandboxes.yml` step runs `continue-on-error`. Flip it to blocking
  the day it goes green — a permanently red gate teaches the same lesson as an
  absent one. Keep the number here honest: a count that drifts is worse than no
  count, because it reads as a measurement.

  Two things the first six fixes taught, worth having before you pick up the
  rest. **A list of off-side controls is a list of SYMPTOMS** — find the
  outermost element wider than the viewport, the one whose parent still fits,
  and fix that; everything under it is downstream, and on `/clients/:id` the
  obvious culprit was a real fault that was not the cause. **And measure right
  edges, not widths** — `/clients/new` and `/my-day` overflowed with no element
  wider than the screen at all.
- **Signed out is not a blank page here — it is `/auth`.** So the blank-page
  guard below is not enough for the authenticated half: `/auth` renders
  perfectly and clears every size threshold. Each surface therefore proves
  itself twice, with a locator only that page draws and a fixture string only
  its data contains. A sweep that measures the login screen twenty times is
  green and worthless.
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
