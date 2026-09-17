# Owner QA Checklist (post round-5)

## Desktop — office flows
- [ ] Invoice popup → Take payment (saved card AND new card) → flips to Paid
      instantly; dashboard AR, client Outstanding, credit tile all update.
- [ ] Routes: Map at Today/Week/Month; Board today-only; Complete button works
      from the board; dispatch panel → set Work days as OFFICE MANAGER and
      confirm it persists after refresh; generated visits skip off-days.
- [ ] Client detail (commercial): stations overview map, numbered pins,
      click-to-edit; Units "Pulled from the property record"; change property
      Total units → subscription count + price + activity entry.
- [ ] DNA: enroll client → log sample w/ photo → set status → match dog →
      notice/bill (office role); techs must get errors via API only.
- [ ] Imports: upload the real Jobber CSV → auto-detects Jobber → commit →
      commit banner mentions the comms hold → clients list shows "Comms
      paused" chips → bulk Resume communications.
- [ ] Bulk bars everywhere: Clients (export/archive — archive hidden for
      dispatcher), Invoices (send/mark-paid confirm/void/export; switch
      filters and confirm selection clears), Leads, client Visits, Concerns,
      Zones, Inventory (archive + Restore), DNA, platform Tenants/Users.
- [ ] Weather: header cloud icon loads all zones (Michigan zones show
      Michigan weather); Routes risky day → reschedule respects work days;
      Undo works.
- [ ] Platform: edit a plan (monthly + annual price fields), add-on Coming
      soon (tenant sees badge; subscribed+disabled still cancellable), user
      detail actions, revenue org links open tenant detail.
- [ ] Signup: ?ref= pre-fills, coupon validates green, discount lands on the
      first Stripe subscription; gift card: redeem now requires a client and
      the client's credit balance increases.

## Added since this list was written

This file was written after round 5 on **2026-07-26**. Three hundred and
fifty-five commits and **ten new routes** have landed since, and none of them
were in it — so a full pass of the list above could come back clean while
leaving most of a quarter's work unopened. Found 2026-09-17 by diffing the
routes against the list rather than by anyone noticing.

- [ ] **Canvassing** (`/neighbors`, landed 2026-09-03). Add a lead by hand;
      seed doors from a client; walk the queue and move a door through
      To visit → Contacted → Interested → Signed up / Passed; delete an entry
      and confirm the dialog. **The ordering is the thing to actually look at**:
      doors with a pin are chained nearest-to-nearest and must not send you
      across town and back, and doors without one come after them, grouped by
      street and in house-number order. It has unit tests
      (`a-street-of-doors-on-one-pin.test.ts`) and is in two viewport sweeps;
      what nothing checks is whether the walk order makes sense to a person on
      a footpath.
- [ ] **My schedule** (`/my-schedule`). A tech's upcoming days: the day strip,
      "Thursday, 6 stops", View schedule into the right day.
- [ ] **Disputes** (`/disputes`). The dispute queue: open one, work it, confirm
      it leaves the queue.
- [ ] **Review queue** (`/review`). Same shape — a queue that must empty.
- [ ] **Pricing drift** (`/pricing-drift`), "Who is off the rate card". Confirm
      a client priced off-card appears, and that fixing the price clears them.
- [ ] **Tax reports** (`/tax-reports`). The screen an owner sends to an
      accountant: figures right, export lands.
- [ ] **Profile** (`/profile`). Photo upload, including a HEIC off a recent
      iPhone — the header says that is the case it was built for.
- [ ] **Settings: scheduling, client portal, online signup, franchise.** Four
      new settings screens. For each: change one value, refresh, confirm it
      stuck. `settings/franchise` also has "Join a franchise", which is the one
      with consequences.

**Two of these are worth doing on a phone as well as a laptop**, because they
are what a technician actually holds: canvassing and my-schedule.

## Phone
- [ ] Tab bars per role; ➕ sheet; More sheet incl. Sign out.
- [ ] Routes day list at any range; My Day 7-day strip; invoice cards with
      select-all; messages list→thread; client tabs scroll.
- [ ] Airplane mode → offline banner + last-synced day; Android back;
      notification tap lands on My Day; install: HoundStack icon + cream
      splash; install banner doesn't cover the tab bar.

## Live money
- [ ] One real Stripe charge; portal add-on request on prepaid client → bell
      notification appears for office; gift card redeem→credit→apply to
      invoice; portal pay page shows Paid immediately after paying.

## Link share
- [ ] Fresh share of app.houndstack.com shows the cream HoundStack card.
