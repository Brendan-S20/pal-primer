# HoundStack — Master Work Brief

> **Brief version: v1.4** · Released 2026-07-30 · Supersedes: v1.3, v1.2, v1.1, v1.0
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
| BUG-18 | 🔵 Open | 🔴 | **New.** Accepting a second org invite hard-bricks the account — `resolveCaller` throws, taking 154 server functions with it. Reachable today | v1.4 |
| BUG-19 | 🔵 Open | 🟠 | **New.** `parent_organization_id` is not in the protected-columns trigger, so a tenant owner can declare themselves someone else's child via direct PostgREST | v1.4 |

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
| IMP-5 | 🔵 Open | ⚪ | Repo housekeeping — now also: the 4 `as any` casts on `impersonation_grants` in `platform.functions.ts`, and ~6 now-false "not in the generated types yet" comments. See IMP-7 below | v1.3 |
| IMP-6 | ❓ Blocked | 🟡 | Payment test coverage — needs Stripe authorized | v1.1 |
| IMP-7 | 🟢 Fixed | 🟡 | Supabase types regenerated. They had been stale since before this cycle and IMP-9's table drop made them wrong, not just incomplete. Four `any`/structural casts removed as a result | v1.3 |
| IMP-9 | 🟢 Fixed | 🟠 | Retire the BYOK surfaces — **done, and the "wait for BUILD-2/BUILD-3" ordering in v1.2 was wrong.** See below | v1.3 |
| IMP-8 | 🟢 Fixed | 🟡 | **New.** Org timezone was built but buried in Routes; moved to Settings | v1.1 |
| BUILD-1 | 🟢 Fixed | 🔴 | Per-feature entitlements — plan tiers now enforced server-side; the published pricing matrix was being ignored by the app. See below | v1.2 |
| BUILD-2 | ❓ Blocked | 🔴 | Usage metering — Q-7 answered (soft caps + overage); needs Stripe. **Now the only thing between us and unmetered AI spend** — see IMP-9 below | v1.3 |
| BUILD-3 | ⏳ Waiting | 🟠 | Managed texting — Q-8 = per-tenant subaccount + own brand. In the 10DLC compliance queue; nothing to accelerate | v1.1 |
| BUILD-4 | 🟢 Fixed | 🟠 | Managed AI — BYO deleted, inference runs on the platform key, and the product no longer asks for a key. The remaining gap is metering, which is BUILD-2, not BUILD-4 | v1.3 |
| BUILD-5 | 🔵 Open | 🟠 | White label (real build) | v1.0 |
| BUILD-6 | 🔵 Open | 🟠 | Enterprise tier — Q-9 = grandfather existing multi-entity tenants indefinitely | v1.1 |
| BUILD-7 | 🔵 Open | 🟡 | Trial → Growth + AI sandbox | v1.0 |
| BUILD-8 | 🟢 Fixed | 🟡 | AI Business Advisor **built out** (owner reversed the retire instruction). On-demand, 7/30/90-day windows, evidence shown beside the advice. See below | v1.3 |
| BUILD-9 | 🔵 Open | 🟠 | Mobile Phase 2/3 — Q-2 = dedicated tablet tier, Q-3 = bundled assets | v1.1 |
| BUILD-10 | 🟢 Fixed | 🟠 | Review queue built. §10.5's rule pointed at a mechanism nobody had made, so every place that "honored" it honored it by doing nothing. See below | v1.4 |
| BUILD-11 | 🟢 Fixed | 🟠 | **New.** End-of-day close-out for visits left open | v1.1 |
| BUILD-12 | 🔵 Open | 🟠 | **New.** Invoice dispute queue — owner decision: disputes get their own queue, analytics inclusion is a toggle, and they always render as issue/lost rather than being absorbed silently | v1.4 |
| RESP-1…5 | 🔵 Open | 🟠 | All five still need real hardware | v1.0 |
| MKT-1 | 🟢 Fixed | 🔴 | Catalog truth — Q-13 answered (every add-on at launch). Site now lists the 6 real add-ons with prices; the 3 phantom SKUs are gone | v1.2 |
| MKT-2 | 🟢 Fixed | 🔴 | Broken AI features no longer described as live | v1.1 |
| MKT-3 | 🔵 Open | 🟠 | Pricing table rendering | v1.0 |
| MKT-4 | 🟢 Fixed | 🔴 | Contact form wired to the real Formspree endpoint, with `_subject` and a `form` field so the two forms are distinguishable in one inbox | v1.2 |
| MKT-5 | 🔵 Open | 🟠 | Legal drafts pending review | v1.0 |
| MKT-6 | 🔵 Open | 🟡 | Analytics + SEO setup | v1.0 |
| MKT-7 | 🔵 Open | 🟡 | Real product screenshots | v1.0 |
| MKT-8 | ⚪ Deferred | ⚪ | `/customers` stub | v1.0 |
| MKT-9 | 🔵 Open | 🟡 | Annual billing on site — see VER-8 | v1.1 |

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

