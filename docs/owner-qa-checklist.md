# Owner QA Checklist (post round-5)

**State on 2026-10-04.** Every item below says which half a machine proves and
which half still needs a person. A box is ticked only when a spec in
`tests/e2e/` covers the whole item as written; an item a spec covers in part
stays open, with the remaining part named.

## Most of this is now run by a machine

**Added 2026-09-19.** Everything below was marked "needs the owner's hands".
Most of it did not; it needed a database that remembers. The viewport sweeps
run against `tests/viewports/fixtures/stub-backend.ts`, which says of itself
`// Writes. Nothing here writes anywhere` — correct for measuring geometry,
and the reason a checklist full of round trips was out of its reach.

`npm run test:e2e` starts a local Supabase, replays every migration, seeds a
real tenant through the product's own `seed_demo_org` (in metro Detroit since
#320), and drives a browser against it, signed in through the real two-stage
form with RLS live. It runs on every push to `main` as part of the sandboxes
`database` job, and on any PR that touches `tests/e2e/**`.

Two kinds of proof, and the difference matters: **rendering with real data is
not the same as working.**

- **Renders.** `the-routes-the-qa-list-asks-about` opens every route on this
  list as the owner and fails on a console error: `/clients`, `/routes`,
  `/invoices`, `/my-day`, `/neighbors`, `/my-schedule`, `/disputes`,
  `/review`, `/pricing-drift`, `/tax-reports`, `/profile`,
  `/settings/scheduling`, `/settings/client-portal`.
- **Works.** A behavioural spec does the thing and then reads Postgres with
  the service role to confirm it happened. Each is named against the item it
  covers below.

Three of those specs found real faults on their first run, which is the
argument for having written them: `/settings/scheduling` never showed saved
values after a reload (uncontrolled inputs mounted before the query
answered); `/pricing-drift` had never built a report in production shape (an
ambiguous zones embed and a column that does not exist, stacked); and the
board-completes spec put itself on tomorrow for the hour after midnight
Eastern, because the runner's clock is not the business's.

**What stays with a person, permanently:**

- **One real Stripe charge.** Test mode proves the integration. It does not
  prove money moved. Only a real card on the real account does that, once.
- **An install on a physical handset.** An emulator is not a phone, and the
  difference is the entire reason to do it.

**Still manual, each for a stated reason:** the Stripe card form (test mode,
then the one real charge); the Jobber CSV and DNA photo flows (file uploads);
weather (a live provider to stub first); clients bulk-archive (restore is
per-client and asymmetric); `/settings/franchise` (its only round trip is
joining a franchise, which is irreversible on the seeded org); the link-share
card (needs the production URL); and the phone items.

---

## Desktop — office flows
- [ ] Invoice popup → Take payment (saved card AND new card) → flips to Paid
      instantly; dashboard AR, client Outstanding, credit tile all update.
      *Machine:* `the-invoice-flips-to-paid-and-postgres-agrees` proves the
      non-Stripe half — Record payment flips the invoice, writes a `payments`
      row with how and when it was paid, and survives a reload. *Person:* the
      card form itself (saved and new card), and the dashboard AR, client
      Outstanding and credit tile updating.
- [ ] Routes: Map at Today/Week/Month; Board today-only; Complete button works
      from the board; dispatch panel → set Work days as OFFICE MANAGER and
      confirm it persists after refresh; generated visits skip off-days.
      *Machine:* `the-board-completes-a-visit` (the visit flips in Postgres,
      the activity row lands, one fewer Complete after a reload);
      `three-more-settings-survive-a-refresh` (Work days persists — as the
      owner, and at `/settings/scheduling`, because the dispatch panel this
      line names no longer holds the control). *Person:* the map at each
      range, Work days as an office manager, and generated visits skipping
      off-days.
- [ ] Client detail (commercial): stations overview map, numbered pins,
      click-to-edit; Units "Pulled from the property record"; change property
      Total units → subscription count + price + activity entry.
      *Machine:* `total-units-reprice-the-subscription` (units reach the
      subscription and `property.updated` is logged; the price correctly holds,
      because the seeded zone has no commercial rates). *Person:* the stations
      map and pins, and a reprice on a zone that does have commercial rates.
- [ ] DNA: enroll client → log sample w/ photo → set status → match dog →
      notice/bill (office role); techs must get errors via API only.
      *Person* (photo upload).
- [ ] Imports: upload the real Jobber CSV → auto-detects Jobber → commit →
      commit banner mentions the comms hold → clients list shows "Comms
      paused" chips → bulk Resume communications.
      *Machine:* `an-import-brings-plans-and-balances` drives the import screen
      with a services file and a balances file and checks the plans, visits
      and opening-balance invoices in Postgres. *Person:* the real Jobber
      export, the auto-detect, and the comms hold.
- [ ] Bulk bars everywhere: Clients (export/archive — archive hidden for
      dispatcher), Invoices (send/mark-paid confirm/void/export; switch
      filters and confirm selection clears), Leads, client Visits, Concerns,
      Zones, Inventory (archive + Restore), DNA, platform Tenants/Users.
      *Machine:* `a-selection-does-not-survive-a-filter` (invoices and
      concerns: a filter switch clears the selection, and bulk resolve empties
      the concerns queue). *Person:* the other bars.
- [ ] Weather: header cloud icon loads all zones (Michigan zones show
      Michigan weather); Routes risky day → reschedule respects work days;
      Undo works. *Person* (live provider).
- [ ] Platform: edit a plan (monthly + annual price fields), add-on Coming
      soon (tenant sees badge; subscribed+disabled still cancellable), user
      detail actions, revenue org links open tenant detail.
      *Machine:* `the-platform-edits-a-plan` (monthly and annual prices, and
      the audit row). *Person:* the rest of the line.
- [ ] Signup: ?ref= pre-fills, coupon validates green, discount lands on the
      first Stripe subscription; gift card: redeem now requires a client and
      the client's credit balance increases. *Person* (Stripe).

## Added since this list was written

This file was written after round 5 on **2026-07-26**. Three hundred and
fifty-five commits and **ten new routes** had landed by 2026-09-17, and none of
them were in it — so a full pass of the list above could come back clean while
leaving most of a quarter's work unopened. Found by diffing the routes against
the list rather than by anyone noticing.

- [ ] **Canvassing** (`/neighbors`, landed 2026-09-03). Add a lead by hand;
      seed doors from a client; walk the queue and move a door through
      To visit → Contacted → Interested → Signed up / Passed; delete an entry
      and confirm the dialog. **The ordering is the thing to actually look at**:
      doors with a pin are chained nearest-to-nearest and must not send you
      across town and back, and doors without one come after them, grouped by
      street and in house-number order. *Machine:* unit tests
      (`a-street-of-doors-on-one-pin.test.ts`), two viewport sweeps, and
      `the-door-signs-up-on-the-spot` (Sign up at a door opens the real
      signup flow, or the paper fallback when online signup is off).
      *Person:* whether the walk order makes sense on a footpath.
- [x] **My schedule** (`/my-schedule`). A tech's upcoming days: the day strip,
      "Thursday, 6 stops", View schedule into the right day.
      `the-day-strip-lands-on-the-right-day`.
- [x] **Disputes** (`/disputes`). ~~The dispute queue: open one, work it,
      confirm it leaves the queue.~~ Untestable as written, by design:
      outcomes come from Stripe's webhook, and the page deliberately has no
      "mark as won". `a-dispute-is-witnessed-not-worked` covers what the page
      is — a chargeback shows read-only with the right copy, and its one
      switch survives a refresh.
- [x] **Review queue** (`/review`). Same shape — a queue that must empty.
      `the-review-queue-empties-and-stays-empty`.
- [x] **Pricing drift** (`/pricing-drift`), "Who is off the rate card". Confirm
      a client priced off-card appears, and that fixing the price clears them.
      `fixing-the-price-clears-the-drift`.
- [x] **Tax reports** (`/tax-reports`). The screen an owner sends to an
      accountant: figures right, export lands.
      `the-accountants-csv-adds-up` (the CSV downloads and its Total row
      matches Postgres).
- [ ] **Profile** (`/profile`). Photo upload, including a HEIC off a recent
      iPhone — the header says that is the case it was built for.
      *Machine:* renders only. *Person:* the HEIC upload.
- [ ] **Settings: scheduling, client portal, online signup, franchise.** Four
      new settings screens. For each: change one value, refresh, confirm it
      stuck. `settings/franchise` also has "Join a franchise", which is the one
      with consequences. *Machine:* scheduling (`a-setting-survives-a-refresh`),
      client portal and online signup (`three-more-settings-survive-a-refresh`).
      *Person:* franchise, on a disposable org.

**Two of these are worth doing on a phone as well as a laptop**, because they
are what a technician actually holds: canvassing and my-schedule.

## Phone
- [ ] Tab bars per role; ➕ sheet; More sheet incl. Sign out.
- [ ] Routes day list at any range; My Day 7-day strip; invoice cards with
      select-all; messages list→thread; client tabs scroll.
- [ ] Airplane mode → offline banner + last-synced day; Android back;
      notification tap lands on My Day; install: HoundStack icon + cream
      splash; install banner doesn't cover the tab bar. (iOS push needs the
      owner steps in `docs/ios-build.md` › Push notifications first; no device
      has registered in production as of 2026-10-04.)

## Live money
- [ ] One real Stripe charge; portal add-on request on prepaid client → bell
      notification appears for office; gift card redeem→credit→apply to
      invoice; portal pay page shows Paid immediately after paying.

## Link share
- [ ] Fresh share of app.houndstack.com shows the cream HoundStack card.
