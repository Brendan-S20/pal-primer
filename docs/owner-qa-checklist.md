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
