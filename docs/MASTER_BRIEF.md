# HoundStack — Master Work Brief

> **Brief version: v1.5** · Released 2026-07-31 · Supersedes: v1.4, v1.3, v1.2, v1.1, v1.0
> **Canonical location:** this file, `Brendan-S20/pal-primer` → `docs/MASTER_BRIEF.md`.
> It covers BOTH repos — `pal-primer` (the app) and `HoundStack` (the marketing
> site) — and the marketing repo carries a pointer to it rather than a second
> copy, so the ledger can never disagree with itself.
> **Next version trigger:** live QA run, or the next completion report.

This is the status ledger and changelog. §3–§13 of v1.0 (do-not-break list,
engineering guardrails, definition of done) are unchanged and still authoritative
— see the v1.0 document. What follows is what MOVED.

---

# 1. CHANGELOG

### v1.5 — 2026-07-31

**The money side of BUILD-6 is finished.** A franchise can collect on its
locations' behalf or leave them collecting for themselves; either way the
royalty is computed the same, refunds and chargebacks are recorded and carried
forward, and each period settles in whichever direction the balance actually
runs. The last piece — actually applying carried-forward adjustments to a
settlement — is in, and re-running a settlement no longer changes what is owed.

**BUILD-13 shipped: the accountant's pack.** Ten reports covering income on both
bases, the bridge between them, receivables aged at a point in time, refunds,
write-offs, processor volume against the 1099-K, franchise settlements and
referral rewards. Every sheet declares its basis and carries its own caveats
into the CSV.

**Payment routing is finally reachable.** The parent can now set, per location,
whether the franchise collects and who bears a refund — settings the charge
funnel and the settlement math have always enforced and nothing could set. The
1099-K explanation sits at the switch, from the same function the tax reports
use, so the two surfaces cannot disagree about an owner's own filing.

**IMP-10 closed, and it was hiding a money bug.** One definition of revenue,
mirrored in SQL, with a parity test that fails on drift. Getting there surfaced
BUG-21, a third copy of the royalty calculation in the nightly cron, and a query
that counted declined cards as income.

**Shipped:** BUILD-13, IMP-10, BUG-20 through BUG-27, and the settlement,
adjustment and routing halves of BUILD-6.

**New:** BUG-20 (settlement regeneration was not idempotent), BUG-21 (a
same-period refund counted twice), BUG-22 (`chargeback_responsibility`
unprotected), BUG-23 (`/reports` silently truncated at 1000 invoices), BUG-24
(the settlement billed a location for refunds it had already paid itself),
BUG-25 (only the first partial refund recorded), BUG-26 (a won dispute never
repaid once the statement had gone out), BUG-27 (settlement periods measured in
UTC days).

**On how the second half of that list was found.** BUG-21 came out of running
the generator twice on purpose. BUG-22 through BUG-27 came out of a dedicated
adversarial pass over the money code that had just been written and verified —
briefed to produce concrete failing scenarios and to discard any finding it
could not demonstrate. It returned fourteen, of which these are the ones that
moved money. Reading the same code for plausibility would have found none of
them: every version read perfectly well.

**Also worth knowing:** four migrations had been applied to the live database
without a matching repo file, which meant the IMP-2 drift check was reporting
green while genuinely being unable to see them. Filed; the check is honest again.

### v1.4 — 2026-07-30

**BUILD-10 shipped** — guardrail 10.5's review queue, which the guardrail had
been referring to as though it existed. Research pass on BUILD-6 surfaced two
live security/data bugs unrelated to it; both are logged below as new items.

**Shipped:** BUILD-10, BUG-9(b), IMP-7, BUILD-8 (AI Business Advisor).

**New:** BUG-18, BUG-19 (both found by the BUILD-6 survey, both reachable
today), BUILD-12 (invoice dispute queue).

### v1.3 — 2026-07-29

Second cycle. **BYOK removed from the product, not just from the ledger** — v1.2
recorded the decision but deferred the removal, so Settings still asked customers
for Anthropic/OpenAI keys and for their own Twilio credentials. IMP-9 closes that;
see the detail below for why the "wait for BUILD-2/BUILD-3" ordering was wrong.

**Shipped:** BUILD-1 (plan entitlements), BUG-14, IMP-1, IMP-3, IMP-4, IMP-9,
BUILD-4, MKT-1, MKT-4.

**Verified already fixed, no code written:** BUG-8, BUG-13, BUG-15, BUG-16.

**Four more migrations applied and verified:** credential encryption at rest,
the abandoned-impersonation-grant sweep, plan entitlements, and dropping
`org_ai_credentials`.

### v1.2 — 2026-07-29

Recorded the BYOK retirement decision and its impact on IMP-1.

### v1.1 — 2026-07-29

First Claude Code completion report against v1.0. All 10 blocking questions
answered; §12 steps 2–4 worked.

**Shipped (unverified — awaiting live QA):** BUG-1, BUG-2, BUG-4, BUG-9a,
BUG-10, BUG-12, BUG-17, IMP-2, IMP-8, BUILD-11, MKT-2.

**Verified already fixed, no code written:** BUG-3, BUG-5, BUG-6, BUG-7, VER-4.
Roughly a third of the P1 list was closed by QA round 5 before this cycle began;
those needed re-verification, not new code.

**Three migrations applied to production**, then verified by querying the result
rather than trusting the tool: the impersonation session window, the station
label cleanup, and the portal timezone fix. Plus BUILD-11's close-out schema.

**Corrections to v1.0** — see §1.1 below. Four of them change what an item means.

### v1.0 — 2026-07-27
First consolidated release. (See the v1.0 document.)

---

## 1.1 Corrections to v1.0

These are places where v1.0's premise did not survive contact with the code or
the data. Recorded here so the next cycle doesn't re-derive them.

**BUG-9(a) — the instruction would have regressed a prior fix.**
v1.0 says "derive duration whenever both timestamps exist." Implementing that
literally makes an identical start/completion pair derive 0 and render "Under a
minute" — asserting a real sub-minute service happened. `visit-lifecycle.ts`
deliberately treats that pair as unknown because it is the signature of the old
office-completion fabrication bug. **Closed as already-correct-by-design.** What
the ticket was actually reaching for shipped instead: known-bad timestamps now
read "Needs review", distinct from genuinely-missing ones.

**BUG-9 affects two visits, not one.** `f336fc0e` (the Jul 2 record named in
v1.0) and `04a7898a`, whose timestamps were written fourteen days after its
scheduled date. Both remain in the database, now flagged in the UI.

**BUILD-8's premise is wrong.** "Three SKUs have live subscribers (AI
Receptionist 1, Priority Support 1, Done-for-you 1)" reads as three customers at
risk. All three belong to **one org — "Demo Pet Waste Co"** — which is internal
and deliberately configured for testing. There are no external paying customers
in the database at all. Q-10's "cancel with credit/refund" is therefore **moot,
not executed**: there is nobody to refund.

**MKT-1's catalog numbers match neither side.** v1.0 says "6 buyable SKUs, 9
roadmap SKUs." The app's `platform_addons` table holds **6 add-ons, all of them
`status='coming_soon'` and `is_active=false`** — zero are purchasable. The
marketing site advertises **4** add-ons as buyable, of which **3 do not exist in
the app catalog at all** (AI Business Advisor, Referral Programs, Franchise
Management). So "site must match app" executed literally would mean the site
advertises nothing for sale. **Needs an owner decision — see Q-13.**

**BYOK is retired from the product** *(owner decision, 2026-07-29)*.
v1.0 assumed bring-your-own-key as a supported path, and BUILD-4 said to "keep
BYO as an Enterprise option rather than deleting it." That is reversed. Every
integration is managed by HoundStack:

- **AI** runs on HoundStack's keys. Tenants buy an allowance and pay overages
  (Q-7: soft caps + overage billing).
- **Texting** runs on per-tenant Twilio **subaccounts** under HoundStack's
  10DLC brand (Q-8, unchanged).
- **Accounting** stays a tenant-authorized OAuth connection — QuickBooks and
  Xero, more to follow. This is the one place a tenant still grants us a
  credential, and it is the one that matters most.

Worth knowing: **managed AI already functioned before this decision.**
`resolveOrgAiConfig` fell back to the platform's own `ANTHROPIC_API_KEY` whenever
an org had no key of its own, and no org ever set one — so the fallback was the
only path that ever ran. As of v1.3 there is no fallback: it reads the platform
key, full stop, and the product no longer asks for a key anywhere (IMP-9). What
is still missing is not the inference path but the METERING around it: usage
capture, allowances, overages, and the 80% alert. That is BUILD-2, blocked on
Stripe — and now the only control on AI spend.

**§10.5's review queue does not exist.** The guardrail refers to it as though it
were built. Repo search finds no such mechanism. Raised as BUILD-10.

---

# 2. STATUS LEDGER

## Bugs

| ID | Status | Pri | Summary | Changed in |
|---|---|---|---|---|
| BUG-1 | 🟢 Fixed | 🔴 | No-org accounts reach tenant surfaces | v1.1 |
| BUG-2 | 🟢 Fixed | 🔴 | Impersonation expires silently | v1.1 |
| BUG-3 | ✅ Verified | 🟠 | Tech progress counts skipped as done — already fixed | v1.1 |
| BUG-4 | 🟢 Fixed | 🟠 | Raw enum tokens leak to users (5 more surfaces) | v1.1 |
| BUG-5 | ✅ Verified | 🟠 | Stations button on residential cards — already gated | v1.1 |
| BUG-6 | ✅ Verified | 🟠 | Dispatcher hidden tab — already redirects to Summary | v1.1 |
| BUG-7 | ✅ Verified | 🟠 | Overdue card — dispatchers lack `view_financials`; server returns null | v1.1 |
| BUG-8 | ✅ Verified | 🟠 | Station "Last serviced" — closed by #62; reads the newest visit date across `station_service_logs`. Live data has 0 logs, so "not yet" on all 3 stations is correct, not the bug | v1.2 |
| BUG-9 | 🟢 Fixed | 🟠 | (a) closed by design · (b) **closed by BUILD-10** — both records are now filed as review items instead of being findable only by chance | v1.4 |
| BUG-10 | 🟢 Fixed | 🟠 | Station junk labels — schema was NOT NULL, see below | v1.1 |
| BUG-11 | 🟢 Fixed | 🟠 | Platform MRR excludes add-ons — annualized to a monthly equivalent; verified live at $449 + $78 = $527, one-time excluded | v1.2 |
| BUG-12 | 🟢 Fixed | 🟠 | Portal skips today's visit — UTC vs org-local date | v1.1 |
| BUG-13 | ✅ Verified | 🟡 | Onboarding tour in impersonation — already guarded at both ends: never auto-fires in an impersonation tab, and a manual re-run never stamps the impersonated user's `tour_seen_at` | v1.2 |
| BUG-14 | 🟢 Fixed | 🟡 | Impersonation audit — target was already recorded and displayed, but **not searchable**, and 21 of 22 sessions had no recorded end at all. See below | v1.2 |
| BUG-15 | ✅ Verified | 🟡 | Portal history — already moved to the Visits tab (G4) with signed before/after photos | v1.2 |
| BUG-16 | ✅ Verified | 🟡 | Dog info on residential cards — `DogsRow` renders name + temperament next to hazards; `dogs(name, temperament)` is in the My Day select | v1.2 |
| BUG-17 | 🟢 Fixed | 🟠 | **New.** In-progress visit lost on reload | v1.1 |
| BUG-18 | 🟢 Fixed | 🔴 | **New.** Accepting a second org invite hard-bricked the account. Invite now refused with a readable message; unique index as the safety net. Multi-org itself stays with BUILD-6 (owner decision) | v1.4 |
| BUG-19 | 🟢 Fixed | 🟠 | **New.** Three franchise columns were writable by tenants — including `franchise_royalty_percent`, i.e. a franchisee could zero out what they owed. All protected, verified against the real tenant path | v1.4 |
| BUG-24 | 🟢 Fixed | 🔴 | **New.** The settlement charged a location for refunds that left the location's OWN Stripe account — it credited only parent-collected revenue but debited the location's share of every reversal. All three chargeback policies out by the full refund, always in the franchise's favour; under `franchise` the software billed the franchisee for a loss the franchise had contractually agreed to absorb. The tell was `franchise_share_cents`: written since adjustments were built, read by nothing. Verified across all six collector × policy combinations | v1.5 |
| BUG-25 | 🟢 Fixed | 🟠 | **New.** Only the first partial refund of a payment was ever recorded. Stripe's `charge.refunded` carries the CUMULATIVE amount and the unique key was `(payment_id, kind)` with DO NOTHING, so $200-then-$800 recorded $200 and dropped the rest. Now records the delta, keyed on the cumulative so redelivery is still idempotent | v1.5 |
| BUG-26 | 🟢 Fixed | 🔴 | **New.** Winning a dispute after the statement was sent never gave the money back — the original adjustment was marked `reversed` and nothing repaid it, while the review-queue alert told the owner the deduction "has been reversed." Now raises a compensating adjustment so the next settlement returns it. Owner's rule was explicit: recovery is paid back | v1.5 |
| BUG-27 | 🟢 Fixed | 🟠 | **New.** Settlement periods were measured in UTC days while every other money surface uses the organization's calendar. Every payment after 19:00 local on a month's last day landed on the wrong statement — revenue understated, royalty billed a month late, and the tax pack disagreeing with the settlement about the same sale | v1.5 |
| BUG-23 | 🟢 Fixed | 🟠 | **New.** `/reports` selected every invoice in the organization with no range and no paging. PostgREST caps a response at 1000 rows silently — no error, no flag — so past a thousand invoices revenue, outstanding, aging and top clients were all quietly low, and got worse the longer the business ran. Paging is now a shared helper | v1.5 |
| BUG-22 | 🟢 Fixed | 🟠 | **New.** `chargeback_responsibility` was writable by tenants — BUG-19's exact shape. A location's own owner could set it to `franchise` and push every future chargeback onto their parent. Protected; verified blocked in an isolated transaction | v1.5 |
| BUG-21 | 🟢 Fixed | 🔴 | **New.** A refund in the SAME period as the sale was counted twice — the payment dropped out of revenue AND its adjustment was deducted. All three chargeback policies produced the wrong number, one of them paying a location $0 on a period where the franchise had explicitly agreed to eat the loss. Reproduced live, fixed, re-verified in six scenarios including composition across a period boundary | v1.5 |
| BUG-22 | 🟢 Fixed | 🟠 | **New.** `chargeback_responsibility` was writable by tenants — BUG-19's exact shape. A location's own owner could set it to `franchise` and push every future chargeback onto their parent. Protected; verified blocked in an isolated transaction | v1.5 |
| BUG-20 | 🟢 Fixed | 🔴 | **New.** Re-running a franchise settlement over the same period silently changed what was owed — a $0 settled statement went back to $900 owed, because the recalculation only looked for *pending* adjustments and the first run had already consumed them. Regeneration now counts what it applied to the same draft. Verified over three consecutive runs, plus a fourth after the statement was sent | v1.5 |

**BUG-10 detail:** `waste_stations.label` was `NOT NULL`, so the junk labels were
not merely left behind — they were *structurally impossible to clear*. Every
reader in the app already treated the column as optional
(`stationDisplayName(1, null)` → `"Station 1"`); only the schema disagreed. The
constraint was dropped so the column matches the design its own readers assume.
Creation still requires a real, non-placeholder label.

**BUG-17 detail:** worse than described. The lookup was
`find(v => v.status === "scheduled" || v.status === "in_progress")`, which
returns whichever comes *first in sequence* — so a tech who started #3 while #1
was still scheduled got pointed at #1, and their open job appeared nowhere.

**BUG-14 detail — the half that was actually broken.** The ticket said the audit
omitted the target user. It did not: every one of the 52 impersonation rows in
the live log carries `target_user_id` and `target_email`, and the row renders
them inline. Two real defects were underneath it.

*The filter could not find what the row displayed.* Searching by the
impersonated user's email returned nothing, against text visibly on screen —
the search covered action, org, and actor only. A filter that misses what it
renders is worse than none, because an empty result reads as a definitive "no,
that never happened." Filter and inline summary now come from one tested module
(`src/lib/platform-audit.ts`).

*Sessions ended by closing the tab were never recorded as ending.* Live counts:
29 `start_impersonation`, 22 `enter_impersonation`, **one**
`stop_impersonation`. The stop event only ever fired from the "Exit
impersonation" button. Twenty-one sessions had no end in the log and their
grants sat with `ended_at IS NULL` forever. The sessions were over regardless —
BUG-2's server gate refuses them — but the record was missing, which is the
whole point of an audit log. Two fixes:

- Reaching the deadline with the tab open is an *observed* end, so the banner
  now records the stop before signing out, and gets a real measured duration.
- Everything else is swept nightly by
  `close_abandoned_impersonation_grants()`, which stamps `ended_at` and writes
  one stop event carrying `session_ended_at` and a **null** duration.

That null is deliberate. We know when the window closed; we do not know when
the operator walked away. Reporting a full-window duration would be inventing a
fact — the same mistake BUG-9(a) was closed for refusing to make. The log says
"ended at the time limit, no exit recorded" instead. Backfilled the 21
historical sessions, dated at their real window-close time so the log reads in
event order; the sweep returns 0 on re-run.

**BUILD-1 detail.** The pricing page has always published a per-tier feature
matrix. The app enforced none of it. A $79 Launch organization could open
Advanced Analytics (sold at $199 Growth) and the whole Franchise Management
surface (sold at Enterprise only) — nine server functions' worth. This was
revenue leaking and, more to the point, the site saying something the product
contradicted.

The matrix was not invented for this item: `TIER_FEATURE_GROUPS` on the
marketing site is a commitment already made to customers, so it *is* the spec.
`src/lib/entitlements.ts` restates it machine-readably, `public.has_plan_entitlement()`
mirrors it in SQL, and `tests/entitlement-parity.test.ts` replays every
(tier, entitlement) pair against both — the guard IMP-3 put on permissions,
applied here from day one instead of after an incident. Both failure modes were
proven: a matrix that drifts fails, and a SQL restructure the parser can't read
fails rather than passing vacuously.

Entitlements are kept separate from permissions on purpose (Q-6 said gate the
existing roles, not add new ones). "Your role can't do this" and "your plan
doesn't include this" are different facts with different fixes; collapsing them
into one "Not authorized" tells a paying owner to go ask their admin for access
they already have.

Two honest limits, stated rather than papered over:

- **Only two of the six entitlements are enforced** — `advanced_analytics` and
  `franchise_structure`. The other four (regional reporting, custom permission
  sets, expanded automation capacity, API access) describe things the site sells
  that the product has not built. They are in the matrix because the matrix has
  to match what is sold, and `ENFORCED_ENTITLEMENTS` records which ones have a
  real check, because "gating" a feature that doesn't exist is coverage in
  appearance only.
- **Analytics is gated per tab, not per route.** Four tabs map exactly onto the
  four functions in `analytics.functions.ts` and onto the pricing copy
  ("cohort retention, zone profitability, churn drivers"). Win-back and the
  weekly digest come from different modules and are not part of that SKU, so
  they stay open on every plan. Gating the whole route was easier and would have
  taken away something never sold as paid.

**Q-9's grandfather clause has nothing to grandfather.** No organization in the
database has a parent or a child — the multi-entity tenants the answer protects
do not exist. Same shape as Q-10. The clause belongs in
`franchise.functions.ts` as a bypass keyed on an org already having children if
that changes before launch; it is deliberately not a hole in the matrix today.

**Unknown plan slugs resolve to the FLOOR, never the ceiling.** A missing org, a
null `plan_id`, or a slug added to the catalog without a mapping resolves to
Launch. Failing open would let a typo hand out Enterprise. A test asserts the
live catalog's eleven slugs are all mapped, so the quiet-downgrade risk is
caught in CI rather than by a customer.

**IMP-9 detail — v1.2 recorded the decision but sequenced it wrongly.**
v1.2 filed IMP-9 to retire the BYOK surfaces *after* BUILD-2/BUILD-3, reasoning
that nothing should be removed before its managed replacement exists. That
reasoning does not hold, and the consequence was that the **product kept asking
customers for API keys** while the ledger said BYOK was dead.

Settings → AI Tools read, verbatim: *"The AI features … run on your own provider
key. Bring an **Anthropic** or **OpenAI** API key. You're billed by them
directly."* Settings → SMS was a full bring-your-own-Twilio form — Account SID,
Auth Token, Messaging Service SID, instructions for wiring an inbound webhook in
the customer's own Twilio Console, and a warning to register their own 10DLC
brand. The Knowledge Center told customers two-way texting used *"your own Twilio
account."* All of that is now removed.

Why the ordering was wrong, per surface:

- **AI** — the managed replacement *already existed*. Every org was already
  served by the platform key; the BYO branch was dead code. Waiting on BUILD-2
  conflated "can we bill for this" with "can we serve this." We could serve it
  all along.
- **Twilio** — the managed replacement genuinely does not exist yet (BUILD-3,
  carrier compliance queue). But the BYO form was not a working fallback either:
  **no org had Twilio credentials and no org had a sender number**, verified
  live. So removing it took nothing from anyone, and the page now states the
  honest position — pending carrier registration, nothing for you to do — rather
  than offering a form that leads nowhere.

What was kept, and the asymmetry that matters:

| Table | Outcome |
|---|---|
| `org_ai_credentials` | **Dropped.** 0 rows, 0 inbound FKs, 0 views/functions/triggers, 0 code references — all verified immediately before applying. Reversal DDL is in the migration's comment; there is no data to restore. |
| `org_twilio_credentials` | **Kept, with its meaning changed.** A subaccount has its own SID and auth token, so the row is still real — HoundStack writes it during provisioning instead of the customer. Encryption there matters *more* now: one key protects a credential for every tenant rather than each tenant's own. |
| `accounting_connections` | **Kept.** QuickBooks/Xero OAuth is explicitly staying, with more applications to follow. |

Also removed: `updateOrgSmsFromNumber`. It let an owner type their own
conversational sender number, which only made sense while they supplied the
Twilio account. Leaving the server function after deleting its UI would have
kept a tenant-facing write path open behind a screen that no longer offered it.

**One thing this makes more urgent.** AI now runs on the platform key with no
metering and no cap. That was *already* the reality — every org was on the
platform key — so this change did not create the exposure, it removed the
fiction that a customer's own key might absorb it. BUILD-2 is the only control,
and it is blocked on Stripe. Worth weighing against "Stripe last."

**The marketing site needed no change.** It never advertised BYO AI keys, and
`/pricing` already said HoundStack supplies the number and handles carrier
registration. The two remaining "bring your own key" strings on the site are both
about **Stripe**, where it is correct — Connect pays into the customer's own
account, which is the opposite of the thing being retired.

**IMP-7 detail.** The generated types had drifted further than the item
described. They still declared `org_ai_credentials`, a table IMP-9 had just
dropped — so they were *wrong*, not merely incomplete — and they predated
`update_org_dispatch_settings`, a migration from before this cycle even started.
Regenerating added `confirm_open_visit`, `finalize_visit_completion`,
`has_plan_entitlement`, and `update_org_dispatch_settings`, and removed the dead
table. Typecheck and all 333 tests passed unchanged.

The payoff is the casts it unlocks. Four are gone — two structural stand-ins I
had written (`impersonation-session.server.ts`, `entitlements.server.ts`) and one
`as any` in `activity.server.ts` — each of which existed *only* because the
columns weren't in the types. The impersonation one matters most: that gate reads
`session_expires_at` and `consumed_at` to decide whether an impersonated session
is still valid, and a typo behind a cast would have silently stopped expiring
sessions.

Deliberately **not** removed: the four `as any` casts on `impersonation_grants`
in `platform.functions.ts`. That file is large, and it is the same
instantiation-budget hazard that produced TS2589 in `org.functions.ts` during
IMP-4 — where annotating one call site simply moved the error to another. Worth
doing, but as its own change with room to back out, not bundled here. Filed under
IMP-5.

Several comments elsewhere still read "isn't in the generated types yet"
(`invoices.functions.ts`, `clients.functions.ts`, `automation.functions.ts`,
`addons.functions.ts`). Every column they name is now present, so those comments
are false and could mislead someone into adding a cast that isn't needed. Also
IMP-5.

**BUILD-8 detail — the AI Business Advisor.** v1.0 said to retire it; the owner
reversed that. The analysis engine already existed (`digest.server.ts`) but was
reachable exactly one way: a weekly email. Advice on our schedule, over our
window, with no way to see what it was based on.

Now an Advisor tab on `/analytics`, with three deliberate choices:

- **The numbers load free; the AI commentary is a button.** A model call spends
  the org's AI allowance, and spending it as a side effect of opening a tab is
  someone else's money quietly leaving — particularly with no metering to observe
  it (BUILD-2). Split into `getAdvisorMetrics` (database only) and
  `getAdvisorInsights` (the model call, explicit action only). It reads better
  too: data first, interpretation on request.
- **Evidence sits beside the advice, never behind a toggle.** An advisor that
  emits three confident bullets with nothing to check them against is a
  horoscope. "Chase your overdue invoices" renders next to the actual A/R figure.
  The insight cards are keyed by window so 7-day commentary can never appear
  beside 30-day numbers.
- **It says when the AI didn't run.** `generateDigestInsights` silently falls
  back to deterministic arithmetic when the model is unreachable — correct for an
  email that must go out, wrong for a screen that would imply an AI read the
  business. `DigestInsights` now carries `aiGenerated`, and the UI labels the
  output "AI analysis" or "Direct calculation".

**Not plan-gated**, deliberately. It is not one of the four functions the pricing
page sells as Advanced Analytics, and MKT-1 removed "AI Business Advisor" from
the site as a phantom SKU rather than selling it. Gating it would invent a
commitment nobody made. Permission-gated on `view_financials` like the rest of
`/analytics` (Q-1: dispatchers and techs are ops-only).

**Two findings surfaced while building it:**

*The digest's window boundaries were UTC, not org-local* — the BUG-12 mistake
again, in a place nobody had looked. Demonstrated live while fixing it: UTC read
`2026-07-30` while the org's own Chicago date was `2026-07-29`, and **5 visits
that had not happened yet** were inside the window. Now org-local, using the same
`Intl.DateTimeFormat("en-CA")` pattern as My Day and the portal.

*There are TWO managed AI paths, not one*, and BUILD-2 has to meter both:

| Path | Key | Powers |
|---|---|---|
| Anthropic (`ai.server.ts`) | `ANTHROPIC_API_KEY` | marketing content, review replies, churn scoring, AI dispatch, zone pricing |
| Lovable gateway (`ai-gateway.server.ts`) | `LOVABLE_API_KEY` | AI receptionist, business advisor / weekly digest |

The Settings → AI Tools page shipped in IMP-9 checked only the first, so it would
have reported "AI is enabled" while the receptionist and advisor were dead. Fixed
in the same change — it now reports each path and names which features are
affected, because "AI is down" when half of it is down sends someone looking in
the wrong place. Consolidating the two providers is worth doing and belongs with
BUILD-2.

**BUILD-10 detail — the guardrail was pointing at nothing.** §10.5 reads
"Ambiguous records go to a **review queue** — never silently guessed." It was
written as though the queue existed. It did not, so every place that honored the
rule honored it by doing nothing:

- **BUG-9's visits** were detected *client-side, one row at a time*, only if a
  human happened to open that one client's Visits tab. There was no query
  anywhere that selected them. Nobody could ask how many existed. (Two.)
- **`admin_transition_missed_visits`** says, verbatim, "Ambiguous records are
  LEFT for human review (I5)". Nothing received them. A visit a tech started and
  never finished sat in `scheduled` indefinitely, visible only as a number on a
  platform-admin health tile. (One.)

Now `review_items` + `detect_review_items()`, run nightly, with three detectors.
Three real items filed on the first run — exactly the pending records §10.5
names.

Design decisions worth keeping:

- **It is an INDEX of ambiguity, not an editing surface.** Remediation happens
  through the flow that already owns the record (`correctVisitTimestamps`,
  `confirm_open_visit`). A second code path that can edit a visit is how the
  underlying bugs got written in the first place.
- **It blocks nothing** *(owner decision)*. Billing, reports, and analytics are
  untouched. An unresolved item is visible work, not a tripwire.
- **The org resolves; platform admins read across and cannot write**
  *(owner decision)*. Only the tenant knows whether a visit happened — resolving
  on their behalf would be the silent guess the guardrail forbids. Encoded in
  RLS, not just UI.
- **A resolution REQUIRES a note.** An item that vanishes with no account of
  what was decided leaves the next reader exactly as uninformed as the guess
  would have. The note also lands on the client's activity timeline.
- **A human's decision outlives the detector.** `ON CONFLICT DO NOTHING` means a
  resolved item is never resurrected — verified live: resolved an item, re-ran
  the sweep, and it stayed resolved even though its underlying condition is
  still true. Without that the queue would nag forever and be ignored.
- **Org-local dates.** The BUG-12 mistake has now appeared *four* times (portal,
  weekly digest, missed-visit sweep, and this detector before it was written
  correctly). The parity test asserts against a bare `CURRENT_DATE`.

TS↔SQL parity test, as with permissions (IMP-3) and entitlements (BUILD-1).

**BUG-18 / BUG-19 — found while scoping BUILD-6, unrelated to it, live today.**

*BUG-18 (P0).* `accept_org_invite_for_current_user` checks membership of the
*invited* org only before inserting into `user_roles`. A user already in org A
who accepts an invite to org B gets a second row — and `resolveCaller`'s
`.maybeSingle()` then throws on **every** subsequent request. That is **154
authz call sites across 48 files**, plus `getMyOrg`, which backs the entire
client-side role/nav layer. The account is unusable and nothing in the product
can fix it. No BUILD-6 required; it is reachable now.

*BUG-19.* `parent_organization_id` and `is_franchise_parent` are absent from
`tg_orgs_protect_platform_columns`, while the "Owners update own org" policy
permits owners to update their own row. So a tenant owner can
`UPDATE organizations SET parent_organization_id = '<any uuid>'` via direct
PostgREST and unilaterally declare themselves someone else's franchise child,
with no consent from the named parent. Today that only feeds the royalty cron;
under a working BUILD-6 it becomes self-enrollment into another tenant's books.

**BUILD-6 is ~15% built, and less than it looks.** The rollup page runs on the
caller's RLS-bound client and queries children by `parent_organization_id` — a
query that returns **zero rows for every possible caller**, because
`is_org_member` is strict org-id equality. The one piece of correct cross-org
authz in the repo, the `SECURITY DEFINER` `franchise_rollup()`, was written,
granted, typed — and never called. The TypeScript is a hand-rolled
reimplementation that dropped the only part that made it work. There is also no
way to create or link a child org through the product at all.

**BUILD-6 detail — what was salvageable, and a correction to my own last report.**

I reported `franchise_rollup()` as "the one correct piece of cross-org authz in
the repo — written, granted, typed, and never called," and recommended reusing
it as-is. **The authorization was right; the body was not.** Because it had never
executed once, three errors sat in it undetected until the first call raised
`42703: column cl.status does not exist`:

- `cl.status = 'active'` — `clients` has no `status` column, only `active
  boolean`. The same function gets `staff` right on the next line, so this was
  an authoring slip, not schema drift.
- `i.amount_paid_cents` — does not exist on `invoices`; that column is on
  `platform_invoices`, a different table.
- `i.status IN ('open','draft','past_due')` — `past_due` is not in the
  `invoice_status` enum.

The lesson worth keeping: **a SECURITY DEFINER function granted to
`authenticated` and never called is not a spare part, it is unverified surface
area.** "Never called" is why it looked clean.

Salvage outcome:

| Piece | Verdict |
|---|---|
| `franchise_rollup()` authorization | **Reused unchanged** — owner/office_manager of the parent. The only shape that can answer this question. |
| `franchise_rollup()` body | **Rewritten** against the real schema, canonical AR, org-local dates |
| `mark_franchise_parent()` | **Repaired.** Called a two-argument `has_role()` that does not exist and tested for an `'admin'` role absent from the enum, so it raised `42883` on every call. The "Mark as franchise parent" button had never worked once. |
| `computeRowForOrg` (TS) | **Deleted.** Returned zeros for every caller AND used invoice statuses that are not in the enum while ignoring applied credit. Dead code producing plausible-looking wrong numbers is worse than none. |
| `franchise_royalty_invoices` + arithmetic | **Kept** — sound and idempotent |

**Why the page always said "No child organizations linked yet."** Not an empty
database — `getFranchiseContext`, `getFranchiseRollup`, and `getFranchiseTrend`
all listed children with `.eq("parent_organization_id", orgId)` on the caller's
own RLS-bound client. A parent is not a member of its children, so
"Members read own org" filtered every child out for every possible caller. All
three now go through SECURITY DEFINER helpers.

**Linking, which did not exist at all.** `parent_organization_id` was never
written anywhere in TypeScript; the page's own empty state described editing the
column by hand, and BUG-19 then closed that off. So linking became mandatory,
and it is built consent-first: the PARENT issues a single-use 14-day code, the
CHILD's owner redeems it. Consent is the redemption — which is exactly what
BUG-19 was missing. A bearer code rather than "parent enters the child's email"
because the latter lets anyone probe which organizations exist and puts the
decision on the wrong side of the relationship.

Structure is **exactly two levels**, enforced at redemption rather than by
convention: a parent may not have a parent, a child may not have children, plus
a redundant cycle check. Deeper hierarchies would need recursive forms of the
rollup, the royalty math, and every RLS decision; leaving the door open is how a
cycle reaches production.

Either side's owner can unlink. Royalty invoices already raised are deliberately
preserved — unlinking is not a way to erase what was owed.

Verified live end to end, nine steps: owner issues → non-owner refused → child
redeems → code single-use → second franchise refused → three levels refused →
**rollup returns 2 rows where the TypeScript returned 0** → child cannot roll up
the parent → unlink clears both sides.

**IMP-10 — no canonical revenue definition.** Unlike AR, which has `ar.ts` and a
documented "B1" canon every surface routes through, revenue is computed six
ways across three incompatible families. The franchise rollup deliberately
matches the **royalty generators** (`payments.created_at`, `succeeded`) rather
than the weekly digest (`paid_at`), because a parent will compare the rollup's
revenue against a royalty invoice for the same period and those two must
reconcile. Two numbers that agree beat one that is arguably more correct alone.

**IMP-5 detail — and the technique that made it worth doing.**

Removing a cast is only safe if you know what flows in its place. `as any`
removed carelessly can leave a value still typed `any` through some other
route, in which case nothing is checked and the build stays green — the change
looks done and achieves nothing.

So each removal was verified by temporarily inserting a bogus property access
and confirming `tsc` named the *concrete* row type in the error. That probe is
what found a live bug: `StaffInvoicePayForm` computed amounts paid with

    .filter((p) => p.status === "succeeded" || p.status === "paid")

and the structural cast on `getInvoiceDetail` had been typing `status` as
`string`, so the comparison read as plausible. With the real type it fails:
`payment_status` is exactly `pending, succeeded, failed, refunded`, verified
against the live enum. Postgres could never have stored `"paid"`, so that
branch has been unreachable for as long as it has existed.

Harmless here — the surviving `succeeded` test is the correct one. But it is a
good illustration of what a stale cast costs: it does not just fail to catch
mistakes, it makes wrong code read as careful.

**Deliberately left:** `null as any` on two `post_credit_entry` RPC arguments
(the generator declares nullable RPC params as required non-nullable — a
generator limitation, not stale types), and roughly forty `(supabase as any)`
sites that carry no stale-types comment and belong to the pre-existing
`no-explicit-any` baseline CI already treats as non-blocking.

**BUILD-12 detail — the dispute queue, and the bug it nearly introduced.**

Owner: "If the invoice is disputed, it should end-up in a dispute queue; then
that can either be toggled into the analytics or toggled out, it should
definitely show as an issue/lost."

*A lost dispute was never recorded as lost.* The webhook records
`charge.dispute.created` (money withdrawn) and `charge.dispute.closed` only when
the outcome is **won** — deliberately, because the money already left when the
dispute opened and recording it again would deduct it twice. That is right about
the money and wrong about the STATE: a dispute we lost stayed "open" forever, so
an owner could not tell "still fighting this" from "lost it in March". Hence
`payment_chargeback_lost`, a review kind that moves no money and records only
the outcome. The alternative — inferring a loss from age — is a guess, which is
what the review queue exists to prevent.

*The bug that nearly shipped with it.* `record_franchise_adjustment` handles
`chargeback_won` explicitly and treats everything else as a new deduction to
apportion. Feeding it the new kind would have billed a franchise location the
full disputed amount a **second** time when the dispute closed — one event,
charged twice, and only for franchise locations, which is the hardest kind to
notice because it looks fine for every ordinary business. Caught before shipping;
guarded in the SQL and again at the call site.

*The toggle is a lens, not a fact.* `disputes_in_analytics` defaults to false —
the money has genuinely left. It changes only the management surfaces
(Dashboard, the Invoices card) and only for **open** disputes: a won one never
deducted, a lost one always does, so the toggle can only touch the genuinely
undecided middle. **It is never consulted by the tax reports**, which read the
reversal ledger directly. A figure on a return cannot depend on a display
preference.

*One coupling worth knowing about.* `payment_chargeback_lost` is deliberately
NOT in `REVERSAL_KINDS`. `reducesIncome()` returns false for anything that is
not a refund or an open chargeback, so adding it there would classify a lost
dispute as a **recovery** and add the money back — turning a lost dispute into a
refund of itself. A test pins both halves so nobody "completes" the list.

**BUILD-8b — the weekly digest is scheduled, and why that alone was not the
fix.** The Analytics panel has promised "Every Monday morning, we email a
plain-language summary of the past week" since it shipped, and it had never once
run. Two independent causes, each sufficient on its own:

1. **Nothing scheduled it.** pg_cron had jobs for the nightly automation and the
   email queue; the digest endpoint existed, was reachable, was correct, and no
   caller had ever been created.
2. **No organization has a recipient.** `digest_recipient_email` is null for
   every org, and the endpoint filters those out — correctly, since it has
   nowhere to send. `notify_email_weekly_digest` defaults to TRUE, so the seven
   orgs that looked opted-in are simply orgs that never touched the setting.

Fixing only the first would have produced a job running every Monday forever and
delivering nothing — the same failure, now with a cron entry making it look
handled. So the settings panel now says plainly when a digest cannot send,
instead of showing "Enabled" beside a promise it cannot keep. That is the part
that made this invisible for months: the owner believes it is on, and the
absence of an email is indistinguishable from a quiet week.

**No fallback recipient was invented.** Defaulting to the owner's login address
would start emailing seven real people a weekly AI summary they never asked for,
on the strength of a checkbox that was on by default. The recipient stays the
org's decision; this change makes that decision have an effect. It also makes
the migration safe to apply immediately — with no recipients set, the first run
sends nothing.

**Still unscheduled and deliberately left so:** `announcement-emails`. Same
shape — a platform admin can mark an announcement `send_email = true` and
nothing will ever send it — but scheduling platform-wide outbound email is an
owner's call, not a cleanup task.

**BUG-28 — the public key authorized three cron endpoints.** The project's
anon/publishable key ships in the browser bundle: anyone who has loaded the app
once can read it out of their network tab. It identifies the project and
authenticates nobody. It was accepted by `nightly`, `weekly-digest` and
`announcement-emails`, and the three had already drifted into three different
strengths — `weekly-digest` had the anon key and *nothing else*.

Money movement was already fenced off. What was not is that these endpoints send
real messages to real people: overdue SMS dunning and invoice emails for **every
organization on the platform**, an AI-generated digest to every opted-in owner
(spending AI allowance per call), and platform-wide announcement email. Every
step is idempotent, which is why it was tolerated — but idempotent is not
harmless. Re-firing the dunning run texts every tenant's overdue customers
again, and no amount of re-running undoes a message somebody received. There is
no rate limit in front of any of it.

Now one shared check (`cron-auth.server.ts`) taking a private credential only.

*Verified before tightening, because a silently dead cron is worse than the
hole.* The live pg_cron job already sends both an anon `apikey` **and**
`Authorization: Bearer <service role key>` from Vault; `autopay_last_attempt_at`
carries `09:00:05Z` against a `0 9 * * *` schedule, and that stamp is written
inside the charge path, which only ran when a private credential had authorized
the request. So the Bearer token was already doing the work. The other two
endpoints have no cron job and have never run at all, so nothing could break.

*Found on the way:* the weekly digest has **never once run** despite 7 orgs
opting in — no scheduler targets it. That is a promised feature silently not
delivering, and it is a scheduling gap rather than a security one, so it is
logged here rather than quietly fixed alongside an auth change.

**IMP-10 closed — the last three cash cards.** "How much did we take this month"
had three implementations left, disagreeing on four axes at once:

| surface | dated by | month boundary from |
|---|---|---|
| Dashboard | `issued_at` | the **server's** clock |
| Invoices index | `paid_at` | the **browser's** UTC |
| Reports | `issued_at` | an explicit range |

So an invoice issued in March and paid in May counted in March on two of them
and in May on the third; none subtracted applied credit; none could see a
refund; and both month boundaries were computed in whichever timezone happened
to be running the code, putting the first five hours of every month in the
previous one for a Chicago org.

All three now call `collectedInPeriod` in `revenue.server.ts`, which counts
**payments** rather than invoices. An invoice is a claim; a payment is the
money — and asking the payment ledger makes partial payments, credit
application and manually recorded cash fall out correctly instead of each
needing a special case.

Checked against live data before and after. The Demo org's July figure moved
from **$3,200.00 to $3,185.00**, and the $15.00 is a real error the old cards
had been showing for months: invoice `65efa3b5` was settled entirely with
account credit, so **no money moved at all**. The invoice-based figure counted
it as cash collected. Nothing about the old number looked wrong.

The two remaining invoice-derived figures — Zone profitability and the
per-tech number on /routes — are deliberately NOT routed through this. They sum
subscription **list price** and have never tracked payment, discount or refund,
so they are relabelled "booked value" and given no refunds line. Deducting money
from a figure that never followed money would make it look more trustworthy than
it is.

**BUILD-6 phase 3 — wiring it up, and the same mistake nearly repeated.**

Phases 1–2 left three SECURITY DEFINER functions granted to `authenticated`
that **nothing called** — exactly the `franchise_rollup` failure documented one
section above, committed by me, one hour later. Phase 3 is the wiring.

**Five more instances of the same RLS wall were found and fixed.** The rollup was
not the only casualty: `getFranchiseContext`, `getFranchiseTrend`,
`getFranchiseRoyaltySettings`, and `generateRoyaltyInvoices` all listed children
or read their payments on the caller's own client. Every one returned empty for
every possible caller, so:

- the location list was always empty,
- the 8-week revenue chart was always blank,
- the royalty settings page had nothing to configure,
- and "generate royalty invoices" looped zero times and silently produced
  **nothing**, for everyone, always.

None of these would have surfaced as errors. They returned empty successfully.

**The gating split that makes the feature usable.** Everything in
`franchise.functions.ts` requires the `franchise_structure` entitlement, which is
right for the PARENT — rollup and royalty billing are what Enterprise sells. It
is wrong for the child. A franchisee is a location somebody else recruited,
most likely on Launch or Growth; gating redemption behind Enterprise would mean
linking only works if **every location independently buys the most expensive
plan**. So the child side lives in `franchise-membership.functions.ts`, ungated:

| Capability | Gate |
|---|---|
| Issue a code, rollup, trend, set royalty | Enterprise (parent capability) |
| Redeem a code, see my parent + my rate | Ungated, owner-only |
| Leave the franchise | Ungated — a relationship you can enter and cannot exit is a trap, and it must not become one because a plan lapsed |

The franchisee can **see** their royalty rate even though only the parent can set
it. Billing someone a percentage they cannot look up would be indefensible.

**Verified live through the whole round trip**, then production restored exactly
as found: children visible `0 → 1`, `set_child_royalty_percent` writes `6.50`
(that function had never once succeeded), the child is **blocked** from changing
it back (BUG-19 holds), rollup returns 2 named rows where the TypeScript returned
0. Cleanup confirmed `linked=0 codes=0 royalty=0.00`.

## Verify-then-fix

| ID | Status | Summary | Changed in |
|---|---|---|---|
| VER-4 | ✅ Verified | Non-field roles in tech lists — both surfaces filter `is_field_tech`; confirmed in live data | v1.1 |
| VER-8 | 🟠 Near-closed | `annual_plan_prices` **is** applied live, so annual billing exists in the app. The gap is the marketing site. Unblocks MKT-9. | v1.1 |
| VER-1, 2, 3, 5, 6, 7, 9, 10, 11 | 🔵 Open | Need a live session with real fixtures (Jobber CSV, a prepaid client, the DNA wizard) — not answerable by reading code | v1.1 |

## Improvements · Builds · Responsiveness · Marketing

| ID | Status | Pri | Summary | Changed in |
|---|---|---|---|---|
| IMP-1 | 🟢 Fixed | 🟠 | Encrypt credentials at rest — see note below | v1.2 |
| IMP-2 | 🟢 Fixed | 🟠 | Migration drift check + the repo's first CI | v1.1 |
| IMP-3 | 🟢 Fixed | 🟡 | TS↔SQL permission parity test — proven to fail on a TS-only grant, a SQL-only grant, and unparseable SQL | v1.2 |
| IMP-4 | 🟢 Fixed | 🟡 | Type the authz boundary — `any` removed from `resolveCaller` | v1.2 |
| IMP-5 | 🟢 Fixed | ⚪ | Repo housekeeping — ~20 stale `as any` casts removed across 14 files, each verified against the regenerated types first and probed to confirm a REAL type flowed rather than degrading to `any`. That probe found a live dead branch: `StaffInvoicePayForm` tested `payment.status === "paid"`, a value the `payment_status` enum has never had. See below | v1.5 |
| IMP-6 | ❓ Blocked | 🟡 | Payment test coverage — needs Stripe authorized | v1.1 |
| IMP-7 | 🟢 Fixed | 🟡 | Supabase types regenerated. They had been stale since before this cycle and IMP-9's table drop made them wrong, not just incomplete. Four `any`/structural casts removed as a result | v1.3 |
| IMP-10 | 🟢 Fixed | 🔴 | **Closed in v1.5, and it was worse than logged.** `src/lib/revenue.ts` is now the one definition — money that ARRIVED (`succeeded` or `refunded`), reversals deducted in their own period — mirrored in SQL with a parity test that fails on drift. Fixing it turned up BUG-21 (a real money error), a third copy of the royalty calculation in the nightly cron, and an AI-tools query with no status filter at all that counted declined cards as revenue. Invoice-based revenue stays separate and is reconciled by BUILD-13's bridge rather than conflated | v1.4 |
| IMP-9 | 🟢 Fixed | 🟠 | Retire the BYOK surfaces — **done, and the "wait for BUILD-2/BUILD-3" ordering in v1.2 was wrong.** See below | v1.3 |
| IMP-8 | 🟢 Fixed | 🟡 | **New.** Org timezone was built but buried in Routes; moved to Settings | v1.1 |
| BUILD-1 | 🟢 Fixed | 🔴 | Per-feature entitlements — plan tiers now enforced server-side; the published pricing matrix was being ignored by the app. See below | v1.2 |
| BUILD-2 | ❓ Blocked | 🔴 | Usage metering — Q-7 answered (soft caps + overage); needs Stripe. **Now the only thing between us and unmetered AI spend** — see IMP-9 below | v1.3 |
| BUILD-3 | ⏳ Waiting | 🟠 | Managed texting — Q-8 = per-tenant subaccount + own brand. In the 10DLC compliance queue; nothing to accelerate | v1.1 |
| BUILD-4 | 🟢 Fixed | 🟠 | Managed AI — BYO deleted, inference runs on the platform key, and the product no longer asks for a key. The remaining gap is metering, which is BUILD-2, not BUILD-4 | v1.3 |
| BUILD-5 | 🔵 Open | 🟠 | White label (real build) | v1.0 |
| BUILD-6 | 🟠 Part-built | 🟠 | Enterprise tier — **phases 1–3 shipped**: consent-based linking end to end, repaired rollup, both sides' UI. The franchise feature works for the first time. Remaining: multi-org membership, drill-down, royalty *delivery*. See below | v1.4 |
| BUILD-7 | 🔵 Open | 🟡 | Trial → Growth + AI sandbox | v1.0 |
| BUILD-8 | 🟢 Fixed | 🟡 | AI Business Advisor **built out** (owner reversed the retire instruction). On-demand, 7/30/90-day windows, evidence shown beside the advice. See below | v1.3 |
| BUILD-9 | 🔵 Open | 🟠 | Mobile Phase 2/3 — Q-2 = dedicated tablet tier, Q-3 = bundled assets | v1.1 |
| BUILD-10 | 🟢 Fixed | 🟠 | Review queue built. §10.5's rule pointed at a mechanism nobody had made, so every place that "honored" it honored it by doing nothing. See below | v1.4 |
| BUILD-11 | 🟢 Fixed | 🟠 | **New.** End-of-day close-out for visits left open | v1.1 |
| BUILD-13 | 🟢 Fixed | 🟠 | **New.** CPA / tax report pack — ten reports, each declaring its basis and carrying its caveats into the CSV. Cash and accrual income, the bridge between them, point-in-time AR aging, refunds, write-offs, 1099-K reconciliation, franchise settlements, referral rewards. Also the 1099-K explanation the owner asked for, keyed to how payments are actually routed. See below | v1.5 |
| BUILD-12 | 🟢 Fixed | 🟠 | Invoice dispute queue — own page under Billing, an analytics toggle that never touches the tax reports, and `payment_chargeback_lost` so a lost dispute stops reading as "open" forever. See below | v1.5 |
| RESP-1…5 | 🔵 Open | 🟠 | All five still need real hardware | v1.0 |
| MKT-1 | 🟢 Fixed | 🔴 | Catalog truth — Q-13 answered (every add-on at launch). Site now lists the 6 real add-ons with prices; the 3 phantom SKUs are gone | v1.2 |
| MKT-2 | 🟢 Fixed | 🔴 | Broken AI features no longer described as live | v1.1 |
| MKT-3 | 🟢 Fixed | 🟠 | The four tier cards did not line up — 117px of drift on the divider at 1280px, because each card sized itself independently and the price/allowance/blurb wrap to different line counts per tier. Cards are now subgrids sharing the outer grid's row tracks, so alignment holds by construction with no magic heights to go stale. Feature matrix itself was already correct at every width | v1.5 |
| MKT-4 | 🟢 Fixed | 🔴 | Contact form wired to the real Formspree endpoint, with `_subject` and a `form` field so the two forms are distinguishable in one inbox | v1.2 |
| MKT-5 | 🔵 Open | 🟠 | Legal drafts pending review | v1.0 |
| MKT-6 | 🟠 Part-built | 🟡 | SEO gaps closed: a double-escaped title, TWO identical FAQPage blocks on two pages, four separate Organization nodes and two contradicting SoftwareApplication entities, all now single-`@id`. Offers say PreOrder, not InStock — nothing is buyable yet. **Analytics needs you:** Plausible is already installed and firing events; registering the domain and creating goals needs your account | v1.5 |
| MKT-7 | 🔵 Open | 🟡 | Real product screenshots | v1.0 |
| MKT-8 | ⚪ Deferred | ⚪ | `/customers` stub | v1.0 |
| MKT-9 | 🔵 Open | 🟡 | Annual billing on site — see VER-8 | v1.1 |

**BUG-24 detail — the term nobody was reading, found by an adversarial pass.**

After BUG-21 was fixed and verified, a dedicated review of the same code found a
second, larger error underneath it. The settlement netted
`collected_by_parent − royalty − location_share`: it credited only revenue the
FRANCHISE collected, but debited the location's share of every reversal —
including reversals whose money had left the LOCATION's own Stripe account. A
self-collecting location paid for its refunds twice.

Reproduced live, $1,000 refunded on a $1,000 sale at 10%, location collecting:

| policy | produced | actually owed |
|---|---|---|
| location | location owes $1,100 | location owes $100 |
| split | location owes $1,000 | settled, $0 |
| franchise | location owes $100 | **franchise owes them $900** |

Out by the full refund in every case, in the franchise's favour in every case.
The `franchise` row is the one that should worry us most: the franchise had
contractually agreed to absorb the chargeback and the software billed the
franchisee for it.

The tell was sitting in the schema. `franchise_share_cents` had been written by
`record_franchise_adjustment` since adjustments were built and read by **nothing**
— a column with a writer and no reader is a formula with a missing term:

```
balance = collected_by_parent
        − royalty
        − Σ location_share   where the PARENT paid the refund out
        + Σ franchise_share  where the LOCATION paid the refund out
```

Read plainly: settle the half the other party is carrying. Verified across all
six collector × policy combinations plus the no-reversal case.

Worth recording how this was found. BUG-21 was caught by deliberately running
the generator twice and reading the output; BUG-24 was caught by a review whose
brief was to construct concrete failing scenarios and to drop any finding it
could not. Neither would have surfaced from reading the code for plausibility —
both versions read perfectly well.

**One thing that looks inconsistent and is not.** A settlement statement's
`revenue_cents` is GROSS while the franchise dashboard's "Revenue MTD" is now
net. That is deliberate: royalty is charged on gross, and the reversal is
apportioned separately by policy, so netting revenue first would take the loss
twice — which is BUG-21 again. The statement itemises revenue, royalty and
adjustments precisely so the arithmetic is visible; the dashboard shows gross,
refunds and net for the same reason.

**BUG-21 detail — the same-period refund, and why nobody would have caught it.**

Reproduced live before it was fixed. $1,000 collected by the franchise, 10%
royalty, refunded inside the same settlement period:

| policy | produced | actually owed |
|---|---|---|
| location | location owes **$1,000** | location owes $100 |
| split | location owes **$900** | settled, $0 |
| franchise | **settled, $0** | franchise owes location $900 |

Every mode wrong, each in the direction favouring whoever ran the generator. The
`franchise` row is the worst: the franchise had explicitly agreed to absorb the
chargeback, and the statement paid the location nothing at all.

The cause is one filter. `status = 'succeeded'` drops a refunded payment out of
revenue, while the adjustment separately deducts the location's share — so the
same loss lands twice. It also printed `revenue: $0` on a statement covering a
$1,000 sale, which a franchisee cannot tell apart from a month with no business.

Fixed by counting money that ARRIVED (`succeeded` or `refunded`) and letting the
adjustment be the only deduction. Re-verified in six scenarios, including the one
that matters most: a refund settled a period LATE composes to the same net −$100
for the location as the same-period case. Two different paths, one answer.

**BUILD-6 detail — payment routing setup.**

All three writers already existed (`set_child_royalty_percent`,
`set_location_payment_routing`, `set_chargeback_responsibility`), written
alongside the money plumbing and never reachable from the product. What was
missing was a READ — a parent is not a member of its locations, so every
RLS-bound query for them comes back empty, the same wall that made the whole
franchise surface silently blank. So the migration adds one reader and no
writers, and the screen is thin.

Turning collection ON is refused unless the franchise's Stripe account can
actually accept charges, because the charge path deliberately has no fallback:
flip it with a half-onboarded account and nobody can pay that location until
someone works out why. Turning it OFF is never blocked — a franchise whose
Stripe has broken needs that exit exactly when things are going wrong.

Not built: attaching an arbitrary Stripe account to a location. Routing is "their
account" or "the franchise's account" because those are the two Connect can
verify. Letting a parent type in any `acct_…` would let one tenant direct another
tenant's customer payments to a third party, and no UI copy makes that safe.

**BUILD-13 detail — the accountant's pack.**

The ask was about removing strain: "we don't have to put a strain on them to try
to find numbers that are needed and are not available or hard to calculate."
Two things follow, and they mattered more than the report list.

*Basis is stated on every sheet.* The existing `/reports` page counts invoices
marked paid, dated by when they were **issued** — neither cash nor accrual. That
is fine for "how are we doing" and unusable on a return. So cash income comes
from `payments.paid_at`, accrual income from `invoices.issued_at`, and
`cash_accrual_bridge` reconciles the two so the first question an accountant
asks — "why doesn't this tie to the bank?" — is answered before it is asked.

*Refunds no longer restate closed periods.* When a refund lands the webhook sets
`payments.status = 'refunded'`. Anything filtering on `'succeeded'` therefore
erases the original receipt retroactively: a refund in October silently removes
income recorded in March, possibly after March was filed, and nothing shows that
it happened. Cash income now counts every payment that actually arrived and
deducts the refund in the month it occurred. **This same flaw is live today in
`/reports` and `/analytics`** — it is the sharpest edge of IMP-10 and is why
that item stays open rather than being closed by this build.

Two smaller definitions were corrected on the way. Aging now runs from the
**due** date rather than the issue date, so an invoice on 30-day terms is not
reported as a month overdue on the day it is sent. And every date is converted
to the organization's own timezone before it is bucketed — a payment taken at
7pm on 31 December in Chicago is a 1 January UTC timestamp, so a naive
`slice(0,10)` files it in the **wrong tax year**.

What the pack deliberately cannot produce is stated on the page: no sales tax
(the schema holds no rate or taxable flag), no expenses, and no Stripe
processing fees (netted out before payout, never recorded here). An accountant
who learns that in thirty seconds stops looking.

The 1099-K explanation the owner asked for lives in one shared function and is
keyed to how payments are actually routed, because the consequence is not
obvious and cannot be undone after the fact: whoever's Stripe account takes the
charge receives the 1099-K for the **full gross**, including what they pass
straight through. A collecting franchise should expect a 1099-K several times
larger than its own revenue, and should know that before it picks the setting
rather than the following January.

## Questions

| ID | Status | Answer | Answered in |
|---|---|---|---|
| Q-1 | ✅ | Dispatchers ops-only, no billing | v1.1 |
| Q-2 | ✅ | Dedicated tablet tier (768–1024px) | v1.1 |
| Q-3 | ✅ | Bundled Capacitor assets | v1.1 |
| Q-4 | 🔵 Open | Create (+) sheet contents — non-blocking | — |
| Q-5 | 🔵 Open | Tech "More" ceiling — non-blocking | — |
| Q-6 | ✅ | Plan-gated existing roles | v1.1 |
| Q-7 | ✅ | Soft caps + overage billing | v1.1 |
| Q-8 | ✅ | Per-tenant subaccount + own 10DLC brand | v1.1 |
| Q-9 | ✅ | Grandfather existing multi-entity tenants indefinitely | v1.1 |
| Q-10 | 🔄 | Cancel with credit/refund — **moot**, no external subscribers exist | v1.1 |
| Q-11 | 🔵 Open | Offline money (add-on charges) — non-blocking | — |
| Q-12 | 🔵 Open | Mobile dispatch depth — non-blocking | — |
| Q-13 | ✅ | Every add-on available at launch, after QA. Site updated; the app's `platform_addons` are still `coming_soon`/inactive and stay that way until live Stripe (owner: Stripe last) | v1.2 |

---

# 3. OPEN DECISIONS & EXTERNAL BLOCKERS

**Needs your action, not engineering:**

0. **Which hostname actually serves the marketing site?** `SITE.url` is
   `www.houndstack.com`, so every canonical URL published is the www form —
   while `robots.txt`, Plausible's `data-domain` and the README's deploy note
   all say the apex `houndstack.com`. Canonicals pointing at a host that
   redirects, or analytics keyed to a domain that never loads, are both silent
   failures. One line to fix once you say which is authoritative.


1. **Authorize Stripe** — OAuth can't run in a headless session. Blocks BUILD-2, BUILD-8, IMP-6.
2. ~~**Formspree contact form ID**~~ — ✅ supplied and wired (MKT-4 closed).
3. **`SUPABASE_DB_URL` secret** — ✅ added, and verified working end-to-end in CI.
4. ~~**Q-13**~~ — ✅ answered: every add-on available at launch, after QA.
5. **10DLC registration** — compliance queue; paced by the registrar.

**Accepted trade-offs, recorded so they aren't rediscovered as bugs:**

- **Late confirmations don't require a completion photo** (BUILD-11). A tech who left the site has no photo to take; requiring one would strand the visit open or push someone to fake it. Marked in provenance and on the activity timeline instead. *Owner-approved 2026-07-29.*
- **`completion_source` is not backfilled.** Existing rows stay NULL. Stamping them `tech_live` would assert provenance nobody recorded.
- **eslint is non-blocking in CI.** The repo carries pre-existing formatting drift (164 errors in `platform.tenants.$id.tsx` alone) that is not this workflow's job to gate on. Typecheck and tests are hard gates.

---

# 4. WHAT IMP-2 LEARNED (worth keeping)

A naive name comparison between `supabase/migrations/` and the live database
reports **~80 false positives**: much of this repo's history was applied under
different names and timestamps than the filenames — the 2026-07-09 consolidated
bootstrap dump, plus renames like `20260716180000_prepaid-invoice-period-fix.sql`
landing as `prepaid_invoice_period_not_null_fix`.

A check that cries wolf eighty times gets ignored, which is worse than no check.
So `supabase/migrations-baseline.json` records those files, **each verified** by
confirming the objects it creates exist in the live database — not assumed.

**Result: the live schema is in sync with the repo.** The drift IMP-2 guards
against was not present. Going forward the check is a hard gate on `main` and
advisory on pull requests, and it fails rather than skipping when
`SUPABASE_DB_URL` is missing — a check that silently passes without checking is
the exact failure mode it exists to remove.

---

# 5. IMP-1 AFTER THE BYOK DECISION

IMP-1 encrypted four credential columns. The BYOK retirement lands on them
unevenly, so, plainly:

| Column | Standing |
|---|---|
| `accounting_connections.access_token` / `refresh_token` | **Fully live and load-bearing.** QuickBooks/Xero OAuth is explicitly staying. These are tokens into a customer's books; encrypting them was the most valuable part of the item and the brief did not name them. |
| `org_twilio_credentials.auth_token` | **Still needed, arguably more.** Subaccounts do not remove stored credentials — each subaccount has its own SID and auth token. The difference is they are now credentials WE are responsible for across every tenant, so a leak is worse, not better. |
| `org_ai_credentials.api_key` | **Gone.** The table was dropped in IMP-9 — 0 rows, 0 references. The encryption work on it was ~15 lines of the module; the module itself is generic and still protects the other three columns. |

So two thirds of the item got more important, one third became dead code. The
encryption module itself is generic — it is not BYOK-specific and serves any
credential the product stores.

`CREDENTIAL_ENCRYPTION_KEY` is still required in production before any
accounting connection or Twilio subaccount is saved.

