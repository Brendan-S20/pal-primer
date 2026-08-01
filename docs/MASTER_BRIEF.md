# HoundStack — Master Work Brief

> **Brief version: v1.14** · Released 2026-08-01 · Supersedes: v1.13, v1.12, v1.11, v1.10, v1.9, v1.8, v1.7, v1.6, v1.5, v1.4, v1.3, v1.2, v1.1, v1.0
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

### v1.14 — 2026-08-01

**A director-level QA pass over everything this ledger calls done, and the
close-out of what it calls open. Four QA agents, every finding re-proven
before it was acted on, and two of their claims discarded because they did not
survive that.**

**Nine tables where the server function was the only gate** (BUG-80). A full
RLS sweep of `public`. Proven live: a field TECH could mint a $5,000 gift card
and a 100%-off promo code; a DISPATCHER could read and overwrite the tenant's
live QuickBooks/Xero OAuth tokens, and reprice all 24 of an org's
subscriptions to $0.01. In every case the correct predicate was already
written in the TypeScript — `promotions.functions.ts` says in so many words
that "RLS alone only tenant-scopes the write — it does not check role". True
about the function, false about the system. Each policy is now the permission
its own writer requires.

**The credit balance and its ledger disagreed, and the product spends the
balance** (BUG-81). $210 of live drift. Three of the five ledger writers never
touched `clients.credit_balance_cents`, so on a prepaid client an add-on
debited the ledger, left the balance alone, and stamped the charge
`paid_from_credit` — then the same dollars were spent again by
`apply_credit_to_invoice`. $445 out of a $500 top-up, twice over. Fixed with
the pattern that already works here: a trigger that RECOUNTS from the ledger,
the same reason the seat counters audit at zero drift. Found alongside it:
`portal_redeem_promo` inserts a `kind` the check constraint has never allowed,
so **every promo code redeemed from the client portal has thrown** for the
life of the feature.

**Nine surfaces decided what day it was using the server's clock** (BUG-82).
Seventh occurrence. Every invoice raised after 7pm local was due a day late —
and `due_on` is the only input to overdue status, dunning, aging and the
reminder emails. The QuickBooks/Xero posting date was the expensive one: an
invoice issued 2025-12-31 21:00 Chicago posted as 2026-01-01, the wrong TAX
YEAR, in books this product does not own. There were THREE hand-rolled copies
of the same formatter; `src/lib/org-day.ts` is the one definition now and a
test fails if a fourth appears.

**Eight protections could be switched off with the suite green** (IMP-13). The
most important finding of the pass, because it means the rest of this ledger
was less verified than it read. With `vitest run` at 752 passed, a mutation
could unregister CSRF entirely, stop the nightly cron enforcing its auth,
return OAuth tokens to plaintext, detach the platform-column trigger, disable
RLS on `payments`, multiply every royalty by ten, invert the settlement
balance, and redefine `is_org_member` into an oracle. Several were tests I had
written the same day. A new `the-wiring-is-connected` suite asserts only that
guards are PLUGGED IN; the weak tests are repaired in place.

**/reports and the CPA pack gave an owner two different answers** (BUG-83).
$3,200 vs $3,185 on July revenue — an invoice settled entirely from account
credit counted as cash received — and $2,655 vs $2,550 outstanding, because
receivables were never bounded by the period. `outstandingAsOf` and
`billedDay` moved out of the pack into `ar.ts` and both surfaces import them,
so the header's long-standing claim that the two "cannot disagree" is finally
true by construction rather than by assertion.

**Q-2 closed: the tablet tier is built.** Driven by ROLE, not width — that is
why a breakpoint move never worked. A tech keeps the tab bar through
768–1024px; an office user does not, because the dispatch board is there. The
bar's reach and the main content's bottom padding are one decision and read
one hook, or the bar lands on top of My Day's Complete button.

**The offline queue can no longer be blocked by one bad action** (BUG-84).
Deferred in v1.11 and closed here: five refusals *while online* dead-letters an
action so the queue behind it moves, and the tech is told loudly. Failures in
a dead zone do not count — losing a tech's work because the yard has no signal
is the opposite of the point.

**Also closed:** `platform_org_stats` selected a column that does not exist and
had thrown on every call it ever received, with no caller — dropped rather
than repaired, because fixing it meant inventing a third definition of
revenue. The marketing site's hostname is settled on `www` across canonicals,
Plausible and the deploy notes.

**What the QA agents got wrong, recorded because a false finding costs more
than a missed one.** One reported `record_franchise_adjustment` as an
unguarded SECURITY DEFINER routine; it is not granted to `authenticated` and a
tech calling it is refused. One reported the `stripe_connect` trigger as
bypassable, having tested it with values identical to the current ones so
`IS DISTINCT FROM` never fired. And the reconciliation agent shipped its
change with **no tests at all** — fifteen were added afterwards, and one of
them initially passed a real mutation because no invoice in its fixture landed
in the bucket being tested.

**My own errors this cycle, in order:** a drift check that counted a GRANT as a
definition, which is the exact hole it was written to close and which had been
hiding three undeclared functions; a credential scan that flagged a zod schema
as a plaintext token write; a comment-blind checker that failed on its own
prose; a `portal_redeem_promo` replacement declared with `text` where the live
signature is `uuid`, which would have created a dead overload rather than
replacing the function; and a tablet-tier assertion that missed a hard-coded
class because it only matched double-quoted attributes and the fix uses
template literals.


### v1.13 — 2026-08-01

**The seven settlement-math claims v1.12 left unprobed. Four reproduce, three
do not, and one of my own fixes was wrong on its first probe.**

This closes the BUILD-6 pass. Every claim was taken one at a time against the
live database; nothing below is a reading of the code.

**Voiding a statement stranded its adjustments forever** (BUG-76). A swept
adjustment is marked `applied` and linked to the statement, and the generator
only reconsiders one whose statement is still a DRAFT for the period being
settled. A voided statement is neither, so a $200 chargeback the location owed
simply ceased to exist — counted on nothing, ever again. Voiding is the one
action whose entire purpose is *undo this statement*, and it undid everything
except the part that moves money.

**A reversed deduction stayed on the draft it was applied to** (BUG-77).
Winning a chargeback whose statement is still a draft correctly marks the
deduction reversed and stops — a draft has not been sent, so there is nothing
to repay. But the draft ROW keeps its old numbers, and nothing requires anyone
to regenerate. Generate on the 1st, win on the 5th, issue on the 10th, and the
location is billed for a chargeback it won.

**An adjustment landed on whichever statement was cut first** (BUG-78). The
sweep filtered on status and nothing else — no period at all. **Stated
precisely, because the after-probe shows both halves:** a statement can no
longer carry an event that happened after its period closed, which is the
property that makes it reconcilable against a franchisee's own books. Settling
August before July still carries July's outstanding chargeback onto August —
that is carry-forward, and it is correct.

**Changing a royalty rate restated closed periods** (BUG-79). Issued statements
were already protected; drafts are exactly what sits there in the days between
generating and issuing. A period now settles at the rate it was FIRST settled
at — there is no rate-history table, so the existing statement is the history.

**Three claims dismissed on evidence.** Royalty on refunded gross is intended,
and the product states the exact arithmetic for all three responsibility modes
("On a $100 refund they lose the full $100 and still owe you the royalty"); all
three were measured and each matches its own explainer, so the refund/chargeback
conflation I expected to find is not one — the setting is named "Refunds &
chargebacks" throughout. Cross-period double-billing does not happen
(`july_adj=5000 aug_adj=0`); a race between two SIMULTANEOUS generate calls
remains possible and is **not** claimed here, because it was not demonstrated.
Rounding runs once on the period total, so nothing accumulates. Also checked
and correct: `period_end` is exclusive and every caller agrees, and the parent's
timezone is used deliberately, matching `franchise_rollup`.

**My own fix was wrong first, and the probe of the fix is what caught it.** The
stale-statement block originally asked "is any adjustment on this statement
reversed" — a one-way door, since a reversed adjustment keeps its link, so the
statement could NEVER be issued, including after the regeneration the error
message instructs. Replaced with the invariant itself: the adjustment total
printed on a statement must equal the adjustments actually on it. That clears
the moment the numbers agree again. It is filed as its own migration so the
repo and the applied ledger say the same thing — the drift BUG-75 was about.

Eight mutations run, all caught.

### v1.12 — 2026-08-01

**An adversarial pass over the BUILD-6 franchise money paths. Six defects,
three claims dismissed after probing, one correction to v1.11.**

Every finding below was demonstrated as the actual role, against the live
database, inside a transaction that rolled itself back — then re-probed after
the fix to show both that the hole closed and that the legitimate path still
works. Nothing here is a reading of the code alone.

**Three ways to take or rewrite money, all in the RLS layer** (BUG-70, 71, 72).
A franchise **dispatcher** could zero a $1,000 royalty invoice and then delete
it outright. An **office manager** could re-point `stripe_connect_account_id`
— the account that receives every customer charge — and, separately, rewrite
`payments.status`, which is the revenue base `generate_franchise_settlements`
sums, taking a location's royalty to zero. In all three the server function
above was correct and the table underneath was open, so PostgREST was reachable
directly. **That shape has now appeared five times** (BUG-33, 36, 42, 61, and
these), and it is worth naming as the single most productive question to ask of
this codebase: *not "is the routine guarded" but "what does the policy say".*

**A field tech could read the franchise's money ledger and its live invite
codes** (BUG-73). Both tables gated SELECT on `is_org_member`, the one
membership helper that includes techs. The adjustment ledger is every refund
and chargeback with its dispute notes; a link code is a bearer credential.
`franchise_adjustment_ledger()` authorizes `view_financials` properly — and the
table it reads did not, so the routine could simply be skipped.

**Winning the second of two equal disputes repaid nothing** (BUG-74) — the
first settlement-math finding to survive being probed. One payment, two
separate Stripe disputes of $400, both lost, both settled, then both won: the
location was charged $800 and repaid $400, silently. A repayment row wrote
`cumulative_cents` as the amount coming back rather than a running total, so
two disputes of the same size collided on the cumulative unique index and the
second hit `ON CONFLICT DO NOTHING` — the clause written to make webhook
redelivery harmless. It could not tell a redelivery from a second dispute
because the key it arbitrated on cannot. Equal amounts are not a corner case: a
location on a flat monthly rate disputes the same figure every time.

**Three functions were live in production and defined in no migration**
(BUG-75). A comment said `set_chargeback_responsibility` came from
20260730200000; that migration defines one function and it is not this one. So
rather than trust the correction either, the sweep ran against the whole schema:
of 158 functions in `public`, three appeared in no migration file — including
that one, which is SECURITY DEFINER, decides who absorbs every chargeback, and
is called by a shipped screen. A rebuilt environment would not have had it.
The third, `email_queue_wake`, was a Lovable scaffold leftover that POSTed a
vaulted service_role key to a `lovable.app` host; it is dropped. It was inert,
and all three reasons were checked rather than assumed.

**The check that would have caught it** (IMP-12). `check-migrations.mjs` asks
"did production run everything the repo has". Nothing asked the reverse, and
that is the direction that stays invisible until an environment is rebuilt.
`check-schema-declared.mjs` now asks it, in CI beside its counterpart. A GRANT
mentioning a name does not count as a declaration — which is exactly how
`email_queue_wake` hid, since a migration granted EXECUTE on a function no
migration created.

**A correction to v1.11's own commit.** I reported `setRoyaltyInvoiceStatus` as
having no permission check, "only `resolveOrgId`". Wrong: in that file
`resolveOrgId` is not the bare org lookup the same name means elsewhere in the
repo — it is `requirePermission('manage_franchise')` plus the Enterprise
entitlement, so the function was gated to the franchise owner all along. I read
the name and not the definition, and the same misreading briefly produced three
more "ungated function" findings that were all false. The RLS half of BUG-70
stands and was proven live; only the server-function half of the story was
wrong. The redundant check is removed and the test now pins what is actually
true.

**Three claims dismissed rather than fixed, each after being probed.**
`record_franchise_adjustment` has no authorization check at all — true, and not
a defect: it is not granted to `authenticated`, and a tech calling it got
`DENIED`. The EXECUTE grant is the gate. A chargeback won and then lost again
under the same dispute id files no deduction — that reproduces, but Stripe
closes a dispute once and a second dispute on a charge gets a new id, so the
scenario is unreachable while the redelivery the guard prevents is routine;
loosening it would trade a bug that cannot happen for double-billing that can,
and a test now pins that decision so it can only be reversed deliberately. And
the live body of `record_franchise_adjustment` differs from the last migration
that defines it — by one sentence of comment, so not drift worth reporting.

**Exposure on everything franchise-related is latent.** There is not one
franchise in the database: zero rows in `franchise_adjustments`,
`franchise_link_codes` and `franchise_royalty_invoices`, and no organization
with `is_franchise_parent` or a parent set. Every probe had to build a franchise
before it had anything to attack. Said plainly rather than dressed up, as with
BUG-53 and BUG-61.

**Still unprobed from this pass:** seven settlement-math claims — cross-period
double-billing, draft-settled reversals leaving deductions, period-blind
adjustments, void stranding adjustments, royalty on refunded gross, live-rate
vs frozen-share mismatch, parent-vs-child timezone boundaries, and rounding
drift. None is treated as established.

Fourteen mutations run across the new suites, all caught — including one
against my own first receiver-scan, which passed a genuine violation because it
looked for `supabaseAdmin` within 600 characters and an unrelated import
upstream satisfied it. Proximity is not a receiver.

### v1.11 — 2026-08-01

**An adversarial pass over the v1.7 offline work. Eight defects, all mine.**
The ledger had no non-blocking engineering work left, so this went at the
largest thing shipped recently that had never been attacked.

**The native app would have received every reply and decoded all of them wrong**
(BUG-62). CORS set no `Access-Control-Expose-Headers`. A cross-origin `fetch()`
exposes only the safelisted response headers; everything else is filtered out
of the Headers object — not blocked, simply absent. TanStack tags every
server-function reply with `x-tss-serialized` and the client *dispatches on
reading it back*, so an authorized HTTP 200 took the wrong decode branch and
returned `undefined`. A thrown server error, also serialized, came back as a
resolved value.

**Why v1.7's proof could not have caught it, stated plainly.** That release
claimed the native app "boots and runs with no network", proven by serving the
bundle as static files with every off-origin request BLOCKED. The claim is true
and the proof stands — and it never makes a single cross-origin server-function
call, so the RPC path it was taken to validate was never exercised. The CORS
tests assert what `corsDecision` RETURNS, not what a browser can read off the
wire. A proof of one property was read as a proof of the feature.

**Three defects in the offline queue, which had no tests at all** (BUG-63, 64,
65): a photo destroyed before its upload succeeded and then reported as synced;
"Complete" unlocking on any queued action and wedging the whole queue behind a
non-network error; and the queue neither user-scoped nor cleared on sign-out —
BUG-43 relocated from localStorage to IndexedDB, with the added twist that
replay runs as whoever is signed in now, so one tech's work is replayed under
another's identity.

**Three ways the device could lie about how old its copy was** (BUG-67, 68, 69),
and all of them failed OPEN — the stale copy looked current, which is the exact
outcome the freshness banner exists to prevent. The 3-day age limit measured
time since the app was last opened rather than the age of the data. A backward
clock made a three-day-old route read as "saved just now" and, in one branch,
suppressed the banner entirely. And revoking a session server-side never
reached the device.

**CI never built the app** (BUG-66) — which is why a whole class of this was
invisible. `tsc --noEmit` does not run Vite, and `check-pwa-output.mjs`, written
to stop `/sw.js` regressing, is wired into `npm run build` and had never run
automatically once. It also skips silently when there is no output, so it could
not complain about its own absence. That is the seventh check this cycle found
green while measuring nothing, and the third I wrote myself.

**A hypothesis of mine that was wrong, recorded because it nearly went in here.**
I believed `isImpersonationTab()` was fragile because browsers clear
`window.name` on cross-origin navigation — which would matter, since that value
also decides whether the auth session lives in sessionStorage or localStorage,
and the app has two same-tab OAuth round-trips. Three Chromium probes —
cross-origin, cross-site, and a faithful script-initiated round trip with a 302
back — all show `window.name` surviving. No defect. Dropped rather than
reported, after the first probe was itself mis-designed (two ports on one host
are the same *site*), which I caught before drawing a conclusion from it.

**Still open from this pass, verified but not fixed:** the queue has no retry
cap or dead-letter, so a permanently-failing action still blocks everything
behind it — though all three causes found here are now gone — and photo storage
is unbounded with no quota handling.

### v1.10 — 2026-08-01

**A tech could rewrite any DNA violation in their organization** (BUG-61). Every
RLS policy on `dna_matches` — read, insert, update and delete — was
`is_org_member`, which techs pass. Two BEFORE triggers were doing the real
authorization, and they are good triggers: they guard `fine_cents`, the move to
status `billed`, and deleting a sample past `new`/`sent_to_lab`, all behind
`manage_dna_billing`.

What they guard is the **money column**. What they do not guard is **who a
violation blames** and **whether it is still open**. Proven live as a real tech
user, rolled back: re-pointed a $250 violation onto another client's dog, closed
it, and deleted a sample still with the lab. `fine_cents` was never touched in
any of the three, so the billing trigger never fired once.

That is the fourth time this cycle the same lesson has arrived: a server
function or a trigger was the only real gate, and the table underneath was open
to anyone who went around it (BUG-33, BUG-36, BUG-42, now this). The tech is
also the one party with a motive — a DNA violation is evidence about a property
they service.

*Latent.* `dna_matches` holds zero rows; no tenant has used DNA compliance and
nothing was tampered with. Recorded that way rather than dressed up.

**Q-5 closes, and it was never about a ceiling.** The question was filed as the
tech "More" menu's item limit. There is no limit — the sheet is a scroll
container, and a tech's holds six rows. The only real divergence from
`docs/mobile-ux-audit.md` was one entry: **DNA sample logging, specified and
never built**, while a comment in `useMyRole.ts` asserted for months that techs
"are scoped to sample logging". Chasing that false comment is what found BUG-61.

**Field DNA sample logging is now built**, and shaped so the hole beside it
stays closed. `log_dna_sample_from_field` takes a VISIT, not a property: it is
guarded by `is_visit_tech`, and organization, property, client and collecting
staff are all derived from that row. The parameter list is the entire
allowlist — no fine, no matched dog, no status, no staff id — so a field sample
always lands `new`, unmatched, unpriced, attributed to whoever collected it.
Matching and pricing stay office actions. An RLS policy was the obvious
alternative and was rejected: reopening INSERT to techs org-wide would hand back
part of what BUG-61's fix had just taken away.

**A third untrue comment.** `useMyRole.ts` claiming a capability that did not
exist joins `CreateSheet.tsx` claiming no one-off visit could be created (v1.9)
and `routes.tsx` claiming the visit drawer had reassign and reschedule controls
(v1.8). Two of the three sent an investigation down a wrong path before being
caught, and one was quoted back to me as evidence by a research pass. Comments
in this codebase are load-bearing, and a wrong one is not inert.

**The engineering ledger is now empty of non-blocking work.** BUILD-9's tail is
a real device in a real dead zone. Everything else open needs the owner: Stripe,
Resend and per-tenant DNS, 10DLC, legal review, the Plausible account,
screenshots, hardware — plus the Q-2 tablet decision and the one curl that
proves a CORS preflight crosses the real edge.

### v1.9 — 2026-08-01

**A one-off visit can be booked, and it bills.** An emergency call-out, a
make-up after a skip, a one-time clean — from `/routes`, the mobile ➕ sheet, or
the client's Visits tab. Verified live end to end and rolled back: booking
generates exactly one visit on that date; the same booking on a blackout day
generates zero and says which of blackout / work days / client hold to check;
completed, it invoices one line at exactly the price set — 7500 cents in, 7500
cents out.

**The claim that made this a task was mine, and it was false.** I reported that
there was *no way to create a one-off visit anywhere in the product*. Client →
Services → Add service → "One time" has existed all along, `service_frequency`
carries a `one_time` value, and `generate_visits_core` has a complete branch for
it honouring blackouts, work days and client holds. I had repeated a code
comment's phrasing without checking whether another route created one.

That comment did not stay contained. A later research pass over the codebase
**quoted my own comment back as its evidence** for the same claim, and reasoned
from there to two designs that both required making `visits.subscription_id`
nullable — which would have made a visit that no invoicing query can see. The
corrected comment stays in `CreateSheet.tsx` with that story attached. A wrong
comment becomes a source.

*What was actually broken* was narrower and worse: saving a service has never
generated its visits (the nightly run does), and the per-service "Generate
schedule" button was explicitly withheld from `one_time`. So booking for TODAY
produced a service with no visit, no button, and a banner reading "Its one-time
visit is in the past" — about a visit booked for today.

**Then an adversarial pass over that feature returned twelve findings, and nine
were real** (BUG-52 … BUG-60). Five were mine, one was pre-existing and billed
money, and three more were the same defect wearing different clothes.

**One rule, wrong in four places.** This schema does not record ending as a
status: `endSubscription` writes `ends_on` and *leaves* `status = 'active'`. So
`status = 'active'` answers a different question from "is this service still
running" — and four separate places asked the first while meaning the second:
the client list (BUG-54), the seasonal deep-clean generator in SQL where it
**billed** (BUG-53), the property service-time estimate that drives routing
(BUG-58), and the customer-facing portal plan (BUG-59). Every one was invisible
until one-off bookings started creating that state deliberately. There is one
shared rule now, and a test that each site applies it.

**Severity corrected downward, deliberately.** The review called the deep-clean
and weekend-booking findings CRITICAL and billing "$89 forever". Checked before
repeating it: **zero organizations have `seasonal_deepclean_enabled`** and every
org currently works all seven days, so both were latent and nobody has been
billed. Real bugs waiting on a setting change — not money going out the door.
This is the third time this cycle that repeating an agent's framing unchecked
would have put a wrong number in this ledger.

**Corrections to my own work this release**, continuing the practice:

*A fix of mine that did nothing.* The first cadence repair called
`client_default_billing_cadence` over RPC. It is not granted to `authenticated`,
so the call fails, the result is neither literal, and the fallback quietly
restores the exact `'postpaid'` the fix existed to prevent. Granting it would
have been wrong — SECURITY DEFINER, so it would then answer about any client id
in any tenant, the BUG-42 shape. The ordering is mirrored under RLS instead,
checked against all 267 clients with 0 disagreements, and a parity test parses
the shipped SQL to keep the copies honest.

*A guard of mine that measured nothing.* `tests/live-service-filter-applied`
asserted `toContain("liveServiceOrFilter")` against the whole FILE — which the
import line alone satisfies — so it passed a mutation that deleted the filter
from the query. That is the dead-machinery rule counting comments as callers,
committed by me, inside the test written to stop exactly that class of thing.
Caught only by mutation-testing it. This is the sixth check this cycle found
green while measuring nothing, and the second one I wrote myself.

*A probe of mine that measured the wrong thing.* The first check that scoped
generation worked counted absolute visits beyond 60 days rather than the delta,
and 77 already existed. Re-run as a before/after it gave the real answer: scoped
inserts 1 with 0 collateral, org-wide still inserts 14.

**Transcribing live SQL is now checked, not trusted.** Scoping the generator
meant reproducing 140 lines of plpgsql. Earlier in this cycle I broke
`run_billing_cycles` in production by rebuilding a body from a fragment. So the
new body, with the one intended predicate removed, was hashed and compared
against the body captured before the migration — identical
(`d0bd3f4b5b424adf9d2bee4eb56cc3f7`). The technique is worth keeping.

**Q-4 closes**, and BUILD-9's tail is down to Q-5 and a real device.

### v1.8 — 2026-07-31

**CI had never run four of its test files, and one of them was failing.**
`npm test` was a hand-typed list of 48 filenames in `package.json`; the repo
has 52 test files. The four that were never added had never run, and
`tests/stripe-connect.server.test.ts` had been failing since BUILD-6 changed
the return shape it asserts on. CI was green the whole time, because a test
file CI does not name is a test file CI cannot fail on. `npm test` is now
`vitest run` (BUG-47).

That makes **five** checks this cycle that were green while measuring nothing —
and this is the one that undermines the other four, because every "verified by
tests" claim in this ledger was made against a runner that was skipping files.
Nothing else turned out to be broken; the point is that nothing else was being
watched either.

**Fixing that test found the BUILD-6 branch had no coverage at all** — the half
that decides *whose bank account* a customer's money lands in. Added, including
the case where the franchise has no connected account and the resolver must
refuse rather than quietly bill into the franchisee's. Mutation-tested: removing
the no-fallback guard fails a test, disabling franchise routing fails two.

**Every button in the visit drawer was guaranteed to fail** (BUG-48). It opens
only from `/routes` and `/dashboard`, which techs cannot reach, and it called
the tech RPCs, which authorize on `is_visit_tech()`. Proven live on a real
scheduled visit: the org's own owner returns false for that guard. The desktop
board had this right and said so in a comment; the drawer never got the same
treatment, and the comment claiming otherwise had been copied into two more
places (BUG-49).

**A second `skip_visit` had been granted to every signed-in user since July**
(BUG-50), and the dead-machinery detector could not have found it — rule 1 keys
on the NAME, so two signatures collapse into one entry and the live overload's
callers vouch for the dead one. Dropping it made things briefly worse: a single
`DROP` marked the whole name dropped, so the live three-argument `skip_visit`
fell out of coverage entirely. Both fixed, and a fourth rule now flags any name
with more than one live signature (IMP-11).

**Rule 4's first run reported five findings and all five were wrong** — it read
`public.addon_frequency` and `addon_frequency` as different types. Zero were
real. That is now written into the detector's header as a rule of its own: a new
check's first output is evidence about the check, not about the codebase.

**Q-4 and Q-12 answered by building the small half.** A dispatcher can now
reassign a visit from a phone, which is the one dispatch action a phone is
actually for. The ➕ sheet had three rows and one of them created anything;
the other two are relabelled as the shortcuts they are.

**Q-2 is reopened, not closed.** The v1.1 answer was a dedicated tablet tier at
768–1024px. It was never built — there is one breakpoint in this app — and it
cannot be fixed by moving the breakpoint, because the tech nav and the dispatch
board want opposite answers on an iPad. Recorded rather than guessed at.

**Still not built, and it is bigger than the ledger implied:** there is no way
to create a one-off visit anywhere in the product, on any device. Visits exist
only as output of `generate_visits_through` from a subscription, so an emergency
call-out, a make-up visit after a skip, and a one-time deep clean cannot be put
on the schedule at all.

### v1.7 — 2026-07-31

**The native app boots and runs with no network, for real.** Not a claim from a
config file — the bundle was served as dumb static files with every off-origin
request blocked, loaded in headless Chromium, and it hydrated, client-routed
and rendered from 36 files on disk with zero off-origin requests. Getting there
was not the config change the ledger implied: this is a server-rendered app,
`.output/public` had no index.html, and Q-3's answer ("bundled assets") could
not be implemented as written. It needed a client-bootable shell, an absolute
server-function origin, CORS, CSRF, and an offline read cache — plus two
defects that had to be fixed before "offline" could mean anything at all
(BUG-43, BUG-44).

**Two security holes that had been open since the code was written.** Server
functions had NO CSRF protection, because supplying any `requestMiddleware`
silently replaces TanStack's default — and the customer portal authenticates
with a cookie (BUG-40). And the six authorization primitives would answer about
any user, to anyone who asked (BUG-42). Both are closed and both were verified
live in both directions rather than by reading.

**`/sw.js` has 404'd in production since the PWA was built** (BUG-41), through
three independent defects, so every offline claim on the web was decorative.
The config read correctly the whole time. That is the theme of this release:

**Four separate checks in this codebase were green while measuring nothing.**
The dead-machinery rule that counted TypeScript comments as callers. The IMP-3
parity test pinned to a superseded migration, which would have started checking
history the moment anything replaced the function. A CSRF drift-guard I wrote
today that tripped over its own warning comment. And the service-worker config,
which no test could see because the defect existed only in the build output.
Every one was written by someone confident it worked, and every one was caught
by making it fail on purpose rather than by reading it. Mutation-testing a new
check is now the cheapest thing in this repo that keeps paying.

**Corrections to my own reporting this cycle**, recorded because a ledger that
only records other people's mistakes is not a ledger. I reported the service
worker's precache manifest as empty; it held 324 entries, and I had grepped for
`"url":` against a minified file that writes `url:`. I reported the membership
oracle as needing a signature change across every RLS policy; it needed six
small guards, and I had repeated an agent's framing without checking it. And I
shipped a broken `run_billing_cycles` while fixing `run_billing_cycles`, by
rebuilding its body from a fragment instead of its source — caught by testing,
not by reading.

**Annual billing was already built on both sides and priced differently on each**
(BUG-45, closing MKT-9 and VER-8). The site sold 15% off and the app charged
16.7% off; nobody could have noticed from either side alone, because each was
internally consistent.

**The dead-machinery detector is back to green and now earns it** (IMP-11).
v1.6 left it part-built because an adversarial pass found one rule that could
not fire, one that counted comments as callers, and one that would have failed
CI on correct code. All three are rewritten and each is mutation-proven against
the case it was written for. The known-gap ledger went 2 → 10 on the fix — that
was measurement, not a new outbreak — and is now at 0, with 17 baseline
exceptions each carrying a reason. One residual is named in its own header
rather than left implied: the pg_cron schedules rule 2 asserts were checked by
hand once and are re-checked by nothing.

**`franchise_signals` paired the wrong organization with the wrong domain**
(BUG-46). Two parallel arrays were built by separate queries and zipped by
index; the screen shipped in v1.6 was showing plausible, wrong sales leads.

**Twelve migrations went out live** — the provisioning RPC, three superseded RPCs
retired, the fifteen-day postpaid outage, the tenant read/write hole, the
publishable-key leak, the membership oracle, and the deep-clean and repayment
money fixes. The security ones were each proved to fail before and pass after,
in the live database, inside a transaction that rolls itself back — reading a
policy is not evidence that it holds.

### v1.6 — 2026-07-31

**The publishable key could read the client list.** Chasing the last unexplained
dead-machinery gap — a superseded route optimizer — turned up that its
migration's `REVOKE ... FROM public` had not held, and then that this was true
of the whole schema. The anon key that ships in the browser bundle could execute
**128 of 159** functions, including ones that return customer names and revenue
for any organization, write invoices into it, or add account credit. Proven live
with no token at all, then closed: 128 → 5, with default privileges reset so the
next blanket grant cannot silently reopen it. BUG-33, and it is the second time
this key has turned out to authorize more than anyone assumed — BUG-28 was the
first, and the lesson not taken then was to ask what *else* it could reach.

**A franchise can open a location.** Name it, name who works there, and they get
invites and sign themselves in — the franchisee performs no setup step at all.
This is the flow the owner described on 2026-07-30. The SQL for it was written
that day, was correct, and **nothing ever called it**, so for a day and a half
the only way to add a location was the invitation code, which assumes the
location already runs on HoundStack. That covers acquisitions, not openings.
Both paths now sit next to each other saying which is which, because picking
wrong is the difference between a fresh location and an acquisition whose client
history has to survive.

Building the caller exposed two defects in the SQL that no amount of reading it
would have found (BUG-31). A provisioned location was **free forever** — it
INSERTs the organization directly, bypassing the only code that starts a trial —
and it could be created with **no owner**, producing an organization nobody in
the product could reach, including the franchise that made it.

**An adversarial review of the last four builds found eleven issues; three of
them ended in the same place.** A cancelled subscription, a tenant suspended for
fraud, and an organization on an admin-granted grace period all reached the
`paid` phase and kept HoundStack's AI keys running unmetered (BUG-29). Each
arrived by a different route — a subscription id that survives cancellation, a
suspension that writes only one of two status columns, and a status label that
exists in the other enum — and all three went *through* the gate rather than
around it. One of my own tests asserted the grace case worked by passing a value
the column cannot hold.

**Two more from the same review, both about the product lying quietly rather
than failing.** Every settings change an office manager made reported success
and did nothing, because the RLS policy said owner-only while both permission
matrices say `manage_settings` — and a zero-row UPDATE is a successful UPDATE
(BUG-30). And "is AI on" had three contradictory answers, none of them the
correct sentence that had been written for it (BUG-32).

**Two money errors in dispute handling, neither of which had happened yet.** A
bank inquiry — which withdraws nothing — was billed to the location and booked
as a permanent revenue reduction, and a second dispute on the same payment was
silently dropped, so two real disputes of $400 and $600 on a $1,000 charge
billed $600 and the franchise ate the difference (BUG-34, BUG-35). No backfill
was needed: both were caught before any organization had a dispute. Still open
and now sized: `charge.dispute.updated` is not subscribed, and Stripe can
promote an inquiry to a chargeback in place on that event.

**Every known gap is closed — 10 → 0 — and clearing them found two things
bigger than the gaps.** Chasing the last one turned up that any *signed-in*
user could read customer names and revenue from any other tenant, and write
account credit into it (BUG-36). And the deep-clean gap led to the discovery
that **postpaid invoicing had produced nothing for fifteen days while reporting
a clean run** (BUG-37) — a column renamed long ago, reintroduced by a July
migration, hidden by an exception handler that logs where nobody looks.

The pattern is worth stating plainly, because it is now the third time: the
gaps themselves were mostly small, and every serious defect this cycle was
found by *going and looking* at something adjacent, not by the thing being
reported. Two of the ten were revenue leaks nobody had noticed
(BUG-38, BUG-39).

**The dead-machinery detector is itself under review.** It found four real gaps
on its first run and has cleared two of them, but the same adversarial pass
found that one of its three rules cannot fire at all and another counts
TypeScript *comments* as callers. A check that reports green by construction is
worse than no check, because it is trusted. Being fixed now; IMP-11 moves back
to part-built until it can prove each rule catches the case it was written for.

**Platform-side franchise sales signals now render.** `franchise_signals` —
clusters of organizations sharing a custom email domain, i.e. one multi-location
operator signing up piecemeal — was the sixth instance of built-and-uncalled in
a single cycle. `/platform/signals` shows them as leads worth a call, with
already-linked clusters sunk to the bottom.

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
| BUG-20 | 🟢 Fixed | 🔴 | **New.** Re-running a franchise settlement over the same period silently changed what was owed — a $0 settled statement went back to $900 owed, because the recalculation only looked for *pending* adjustments and the first run had already consumed them. Regeneration now counts what it applied to the same draft. Verified over three consecutive runs, plus a fourth after the statement was sent | v1.5 |
| BUG-40 | 🟢 Fixed | 🔴🔴 | **New.** Server functions had **no CSRF protection at all**, for the life of the app. `createStartHandler` installs its default CSRF middleware only when no start instance supplies `requestMiddleware` — `src/start.ts` always has, so the default was replaced silently, with no error and no warning. Tenant auth is a bearer token, which limited the exposure there; the **customer portal authenticates with a cookie**, and its server functions reschedule visits, cancel add-ons and toggle autopay. A page a customer happened to be visiting could have done any of those on their behalf. Configuring it had a trap of its own: `Sec-Fetch-Site` short-circuits the check, so the obvious fix admits every site on the internet while looking configured | v1.7 |
| BUG-41 | 🟢 Fixed | 🟠 | **New.** `/sw.js` has **404'd in production since the PWA was built**, and it took three independent defects: the worker was emitted to `dist/` while deployment ships `.output/public`; its precache manifest globbed a directory with no app assets; and the CacheFirst rule matched `/_build/`, a path this build has never produced. Every offline claim on the web was decorative — config that read correctly, was reviewed as if it worked, and never once executed. All three lived in the build OUTPUT, invisible from source, so `scripts/check-pwa-output.mjs` now asserts against the output and runs as part of `npm run build` | v1.7 |
| BUG-42 | 🟢 Fixed | 🟡 | **New.** The six authorization primitives (`has_role`, `is_org_member`, `has_permission`, `can_write_org`, `is_platform_admin`, `is_visit_tech`) took *whose* permissions to check as an argument and answered about anybody. Any signed-in account could ask whether a given user belonged to a given organization, and in what role — a membership oracle. Low severity (one bit, no data, both ids required) but real. Fixed with six small guards after checking all 182 call sites pass the caller's own identity; I had first reported this as needing a signature change across every RLS policy, which was wrong | v1.7 |
| BUG-43 | 🟢 Fixed | 🟠 | **New.** `myDayCache.ts` wrote a tech's route — addresses, gate codes, access notes — to `localStorage` keyed only by date and staff id. Not user-scoped, referenced by nothing but my-day, and therefore **cleared by no sign-out path**: on a shared crew tablet it sat there indefinitely, survived sign-out, and was written during impersonation. Removed and subsumed by a store that is scoped per user, erased before `signOut()` is called, and never written while impersonating | v1.7 |
| BUG-44 | 🟢 Fixed | 🟠 | **New.** The app could not open offline at its own front door. `_authenticated.beforeLoad` called `supabase.auth.getUser()` — a **network call** — and read any failure as "not signed in", redirecting to `/auth`. No amount of caching could have helped. Now falls back to the local session, but only when the failure looks like lost network; a 4xx from the auth server is still a real rejection, and that distinction is tested, because getting it backwards would let an expired account in | v1.7 |
| BUG-45 | 🟢 Fixed | 🟡 | **New.** The marketing site quoted an annual price the app does not charge. The app bills annual as ten months — `annual_price_cents` is exactly 10× monthly on every live tier, "two months free", 16.7% — while the site applied a flat 15% and said so in the FAQ. `/pricing` quoted Launch at $67.15/mo against an actual $65.83. Under-promising, so harmless in direction, but a published price that is not the price. Now derived from months-paid so the two cannot drift | v1.7 |
| BUG-46 | 🟢 Fixed | 🟡 | **New.** `franchise_signals` returned organization names and ids as two parallel arrays that were not in the same order, so per-organization links would have pointed at the wrong tenant about half the time. Never mispaired anyone only because the screen noticed and rendered no links. Not fixed by adding `ORDER BY name` — that is not a total order (three organizations here are literally named "Test Test") and two aggregates sort independently. Replaced with one jsonb array of self-contained `{id, name, linked}` objects: nothing left to zip | v1.7 |
| BUG-80 | 🟢 Fixed | 🔴🔴 | **New, security.** **Nine tables where the server function was the only gate.** A full RLS sweep of `public`. Proven live in rolled-back transactions: `TECH mint_$5000_giftcard=ALLOWED`, `DISPATCHER reads_quickbooks_token=TOKEN_SECRET`, `DISPATCHER repriced_subscriptions=24`. gift_cards, gift_card_redemptions and promo_codes were `FOR ALL` on bare membership — a field tech could mint a $5,000 gift card, post a redemption against an invoice, issue a 100%-off code for the whole customer base, or delete cards customers had paid for, with `redeem_gift_card` bypassed entirely. accounting_connections was `can_write_org` for READ and WRITE, so a dispatcher could exfiltrate and overwrite live QuickBooks/Xero OAuth access and refresh tokens — control of the company's books outside this app and outside its audit log, and refresh tokens survive a password change. subscriptions was `can_write_org`, so a dispatcher could set a recurring price to $0.01. skip_billing_rules, ai_receptionist_logs, signup_requests, neighbor_leads and the org-wide push_subscriptions read were the same shape. In every case the correct predicate was already written in the TypeScript. After: `TECH mint=BLOCKED reads_giftcards=0 reads_promos=0 \|\| DISP qb_token=BLOCKED repriced=0 \|\| OM qb_token=readable(ok) can_still_price=24 can_still_issue=OK`. Tenant isolation was never broken — all of it is intra-org escalation | v1.14 |
| BUG-81 | 🟢 Fixed | 🔴 | **New, money.** **A client's credit balance and the ledger behind it disagreed, and the product spends the balance.** $210 of live drift (Emily Rodriguez cached −18000 / ledger −30000; Chris Williams −6000 / −15000). Five routines write `credit_ledger` and only two maintained `clients.credit_balance_cents`, so on a PREPAID client an add-on debited the ledger, left the balance untouched, and stamped the charge `paid_from_credit` — then `apply_credit_to_invoice`, which reads the cached balance, spent the same dollars again. Proven: $445 out of a $500 top-up, twice over. Fixed with the pattern that already works here rather than by patching three more writers — a trigger that RECOUNTS from the ledger on insert, update and delete, the same reason `refresh_active_client_count` and `refresh_active_seat_count` audit at exactly zero drift. Balances backfilled to the ledger (safe: `clients_with_balance_but_no_ledger = 0`). **Found while reading it:** `portal_redeem_promo` inserts `kind = 'promo'`, which the check constraint has never allowed — so every promo code redeemed from the client portal has thrown for the life of the feature | v1.14 |
| BUG-82 | 🟢 Fixed | 🔴 | **New, money.** **Nine surfaces decided what day it was using the server's clock** — the seventh occurrence of this in the codebase. For an org in America/Chicago, UTC is a day ahead from 19:00 local: five hours of every day, 21% of the clock. `tg_set_invoice_due_on` cast `issued_at::date` in the SESSION timezone, so every invoice raised in the evening was due a day late (`due_on WRITTEN=2026-08-16 SHOULD BE=2026-08-15`) — and `due_on` is the only input to overdue status, the dunning ladder, the aging buckets and the reminder emails. The nightly batch runs at 01:10 Chicago so ITS invoices were fine; the wrong ones are the ones a human typed, which is the worst shape for a bug. `run_billing_cycles` took `current_date` four times. Seven TypeScript surfaces followed, including the QuickBooks TxnDate and Xero Date — an invoice issued 2025-12-31 21:00 Chicago posted as 2026-01-01, the wrong TAX YEAR, permanently, in books this product does not own. `ar.ts` was the root: both overdue helpers fell back to the server day when no `today` was passed. THREE hand-rolled copies of the same formatter existed; `src/lib/org-day.ts` is the one definition and a test fails if a fourth appears. Not backfilled — zero live invoices fall inside the disagreement window | v1.14 |
| BUG-83 | 🟢 Fixed | 🟠 | **New, money.** **/reports and the CPA pack gave an owner two different answers**, and an owner hands one to their accountant and reads the other over coffee. July revenue $3,200.00 vs $3,185.00 — the $15.00 was one invoice settled entirely from account credit, counted as revenue received though no money arrived; the same expression never subtracted `credit_applied_cents` and then subtracted refunds, a CASH contra, from an issue-dated ACCRUAL base. July outstanding $2,655.00 vs $2,550.00 — receivables were never bounded by the period, so three invoices issued 1 August sat in a July figure. `outstandingAsOf` and `billedDay` moved OUT of the pack into `ar.ts` and both surfaces import them, making the file header's long-standing claim that the two "cannot disagree" true by construction rather than by assertion. Verified live: the shared rule at 2026-07-31 returns 255000, the pack's figure, against the old rule's 265500. The aging SPLIT still differs deliberately (due date vs issue date); the TOTAL no longer can | v1.14 |
| BUG-84 | 🟢 Fixed | 🟠 | **Verified in v1.11, deferred, closed here.** **One permanently-failing action blocked the offline queue for the rest of a tech's day.** The sync loop `break`s at the first failure so it does not hammer a broken network, and there was no retry cap — so a single action the server would never accept stopped everything queued behind it, with nothing on screen to explain why. Five refusals **while online** now dead-letter the action so the queue moves, and the tech is told in a long-lived error toast naming what was discarded. Failures in a dead zone do not count against the cap: losing a tech's work because the yard has no signal is the opposite of the point. The photo blob is freed with the action, or it would outlive the only thing pointing at it. Residual risk stated rather than hidden — `navigator.onLine` reports reachability, not server health, so five cycles against a reachable-but-refusing server would still discard work | v1.14 |
| BUG-76 | 🟢 Fixed | 🔴 | **New, money.** **Voiding a settlement statement stranded its adjustments forever.** A swept adjustment is marked `applied` and linked to the statement; the generator only reconsiders one whose statement is still a DRAFT for the period being settled, and a voided statement is neither. Proven live, rolled back: `JULY: adj=20000` then `AFTER VOID: aug_adj=0 \| july_status=void \| adj_now=applied linked_void=true` — a $200 chargeback the location owed counted on nothing, ever again. Voiding is the one action whose entire purpose is *undo this statement*, and it undid everything except the part that moves money. Fixed with a trigger on the table rather than in the void call site, because the table takes UPDATEs directly from anyone holding `manage_franchise`; reversed adjustments are deliberately left alone, since a reversed deduction is finished, not owed. After: `after_void=pending/unlinked -> aug_adj=20000` | v1.13 |
| BUG-77 | 🟢 Fixed | 🔴 | **New, money.** **A reversed deduction stayed on the draft it was applied to.** Winning a chargeback whose statement is still a draft correctly marks the deduction `reversed` and stops — a draft has not been sent, so there is nothing to repay — but the draft ROW keeps the numbers it was generated with. Proven live: `draft after settle: adj=20000 net=70000`, then `after winning: adj_now=reversed`, and `DRAFT STILL SAYS: adj=20000 net=70000`. Regenerating corrects it (`adj=0 net=90000`) and nothing requires anyone to regenerate: generate on the 1st, win the dispute on the 5th, issue on the 10th, and the location is billed $200 for a chargeback it won. Fixed by refusing to ISSUE a statement that disagrees with the adjustments underneath it, rather than silently recomputing on the way out — the numbers on a statement should change only when someone regenerates it; what must not happen is sending one already known to be stale. After: `stale_issue=BLOCKED after_regen adj=0 then_issue=OK/issued` | v1.13 |
| BUG-78 | 🟢 Fixed | 🟠 | **New, money.** **An adjustment landed on whichever statement was cut first.** The sweep filtered on `status = 'pending'` and nothing else — no period at all — so a chargeback on a July payment went onto an August statement if August happened to be settled first, and July's own statement showed none: `aug_adj=20000 july_adj=0`. The nightly cron settles last month, so the natural order usually hides it; re-running an old period, or backfilling after onboarding a location, does not. **Precisely what the fix guarantees, since the after-probe shows both halves:** a statement can no longer carry an event that happened after its period closed — the property that makes it reconcilable against a franchisee's own books. Settling August before July still carries July's outstanding chargeback onto August (`aug_first: aug_adj=50000`), which is carry-forward and is correct. In the normal order the periods separate cleanly: `july_adj=20000 aug_adj=30000`. The consume step got the same filter, without which an adjustment would be marked applied while being counted by nothing — BUG-76 by another route | v1.13 |
| BUG-79 | 🟢 Fixed | 🟠 | **New, money.** **Changing a royalty rate restated closed periods.** The generator read `franchise_royalty_percent` live, so regenerating any draft applied today's rate to a month that had already ended: `july_royalty_at_10pct=10000 -> after_rate_change=25000 pct_on_row=25.00`. Issued statements were already safe (the upsert only updates drafts), and a draft is exactly what sits there in the days between generating and issuing — while the payment-routing screen promises "a statement you have already sent cannot change underneath you". There is no rate-history table, so a period now settles at the rate it was FIRST settled at; the existing statement IS the history, and a period never generated before still picks up the current rate. After: `after_rate_change=10000 pct=10.00`, and a new period picks up `25.00` | v1.13 |
| BUG-70 | 🟢 Fixed | 🔴 | **New, security.** A franchise **dispatcher could zero and then delete a royalty invoice** — the table that decides what a location owes, eight money columns and a status, with no trigger behind it unlike every other money surface here. One policy covered ALL commands on `can_write_org`, which includes dispatchers, though Q-1 answered this explicitly ("dispatchers ops-only, no billing") and the three routing setters already require the parent's owner. Proven live as a dispatcher, rolled back: `can_read=1 \| zeroed_a_$1000_royalty=1 \| DELETED_the_invoice=1`. Split by command — SELECT stays `can_write_org`, UPDATE narrows to `manage_franchise` (owner-only), INSERT and DELETE get no policy at all, since a settlement is produced by a SECURITY DEFINER generator and a statement you can delete after issuing is not evidence of anything. After: `DISPATCHER upd=0 del=0 ins=blocked \|\| OWNER read=1 upd=1 del=0`. **Latent** — zero rows | v1.12 |
| BUG-71 | 🟢 Fixed | 🔴🔴 | **New, security.** An **office manager could redirect the organization's card payments.** `tg_orgs_protect_platform_columns` guarded nineteen columns including every franchise one, and not the four `stripe_connect_*` columns — while the `organizations` UPDATE policy is `manage_settings`, which office managers hold. `resolveOrgStripeAccount` reads `stripe_connect_account_id` to decide which Connect account receives every customer charge; an arbitrary `acct_` id only fails at Stripe, but a REAL connected account on this platform does not, and that is the embezzlement case. It also defeated the franchise routing guard: `set_location_payment_routing` refuses parent collection unless the parent's account can accept charges, and the parent could satisfy that by writing `stripe_connect_charges_enabled = true` on its own row. Proven live, rolled back: `rewrite_stripe_connect=ALLOWED (acct now acct_ATTACKER)`. After: all four columns BLOCKED, benign settings write still OK, and `service_role writes all four = OK` so Connect onboarding, refresh and disconnect are untouched | v1.12 |
| BUG-72 | 🟢 Fixed | 🔴 | **New, security.** An **office manager could rewrite the revenue a royalty is computed from.** `payments` was writable FOR ALL by `manage_client_billing`, and `generate_franchise_settlements` sums that table for the period — so a franchise location's own office manager could flip its payments to a non-counted status and take the royalty base, and therefore the royalty, to zero. The settlement function is correct and SECURITY DEFINER; it reads a table the counterparty owns. Blast radius is wider than the franchise: payments feed AR, the revenue figures and the CPA pack. INSERT keeps its permission (manual cash/cheque/terminal payments are recorded from the app); UPDATE and DELETE lose theirs, since every status transition is written by the Stripe webhook through `supabaseAdmin` and nothing deletes a payment — a reversal is a new row. After: `pay_upd=0 pay_del=0 pay_ins=OK`, webhook path intact | v1.12 |
| BUG-73 | 🟢 Fixed | 🟠 | **New, security.** A **field tech could read the franchise money ledger and its live invite codes.** Both `franchise_adjustments` and `franchise_link_codes` gated SELECT on `is_org_member` — the one membership helper that includes techs. The ledger is every refund and chargeback moving between a franchise and its locations, with shares and free-text dispute notes; a link code is a bearer credential that attaches an organization to the franchise. `franchise_adjustment_ledger()` authorizes `view_financials` and `create_franchise_link_code` requires the owner, so in both cases the routine was the real gate and the table underneath was open. Proven live by building a franchise inside a rolled-back transaction: `TECH adj=1 codes=1` → after: `TECH adj=0 codes=0 \|\| OFFICE_MGR adj=1 codes=0 \|\| OWNER adj=1 codes=1 ledger_rpc=1`. **Latent** — the probe had to build the franchise | v1.12 |
| BUG-74 | 🟢 Fixed | 🔴 | **New, money.** **Winning the second of two equal disputes repaid nothing.** One payment, two separate Stripe disputes of $400 (dp_A, dp_B), both lost, both settled on an issued statement, then both won: `deducted=80000 repayments=1 repaid=40000`. The location was charged $800 and repaid $400 — no error, no row, nothing on the statement to reconcile against. A repayment writes `cumulative_cents = _orig.amount_cents`, not a running total, so two disputes of the same size produced the same key under the cumulative unique index and the second INSERT hit `ON CONFLICT DO NOTHING` — the clause written to make webhook redelivery harmless, unable to tell a redelivery from a second dispute because the key it arbitrates on cannot. Equal amounts are not a corner case: a location on a flat monthly rate disputes the same figure every time. The cumulative index is now partial on `dispute_ref IS NULL`, so refunds are identified by cumulative amount and disputes by dispute id, each row covered by exactly one rule. After: `repayments=2 repaid=80000 \|\| redelivered_dispute_deductions=2 \|\| refund_rows=1 refunded=30000 then=2 rows / 50000` — the two behaviours the old key protected both intact. **Latent** — zero rows | v1.12 |
| BUG-75 | 🟢 Fixed | 🟠 | **New.** **Three functions were live in production and defined in no migration.** A comment claimed `set_chargeback_responsibility` came from 20260730200000; that migration defines one function and it is not this one — the fourth untrue comment in two cycles to be treated as a source before being checked. So the sweep ran against the whole schema rather than the one function: of 158 in `public`, three appeared in no migration file. (1) `set_chargeback_responsibility` — SECURITY DEFINER, decides who absorbs every chargeback, called by a shipped screen; its authorization was checked and is correct, and it is filed verbatim. (2) `rls_auto_enable` + the `ensure_rls` event trigger — enables RLS on every new `public` table; a rebuilt environment without it would let the next table ship readable by every signed-in user, silently. (3) `email_queue_wake` — a Lovable scaffold leftover that POSTed a vaulted service_role key to a `lovable.app` host on every invocation; **dropped**, with its body preserved in the migration comment. Inert, and all three reasons were checked rather than assumed: no trigger references it, it RETURNS trigger so a direct call is refused regardless of its grant, and the vault secret it reads does not exist. Not an incident — a loaded gun | v1.12 |
| BUG-62 | 🟢 Fixed | 🔴🔴 | **New.** The native app would have received every server-function reply and **decoded all of them wrong**. CORS set no `Access-Control-Expose-Headers`, and a cross-origin `fetch()` exposes only the safelisted response headers — everything else is filtered out of the Headers object, not blocked. TanStack tags every reply `x-tss-serialized` (or `x-tss-raw`) and the client *dispatches on reading it back*, so an authorized HTTP 200 took the wrong decode branch and the caller got `undefined`; a thrown server error, also serialized, came back as a resolved value. Proven in a real browser: visible headers were `[content-length, content-type]` and the read was null. **v1.7's offline proof could not have caught it** — it blocked every off-origin request, so it never made a cross-origin RPC call at all | v1.11 |
| BUG-63 | 🟢 Fixed | 🔴 | **New.** A queued photo was **destroyed before its upload succeeded**, and the retry reported success. `popPhoto` deleted the blob then uploaded; any throw after that left the action queued with its bytes gone, and the next replay found no blob, treated it as nothing to do, and counted it a SUCCESS. The tech saw *"Synced 1 queued action"* for a photo that no longer existed anywhere, and the visit lost its completion evidence silently | v1.11 |
| BUG-64 | 🟢 Fixed | 🔴 | **New.** "Complete" unlocked on **any** queued action and then **wedged the whole queue**. The gate counted every pending action kind, not completion photos, so queueing a Start unlocked Complete offline. The server refuses (*"A completion photo is required"*), which is not a network error, so the sync loop breaks on it — and every action queued behind it stops for the rest of the day, with no UI to inspect or clear it | v1.11 |
| BUG-65 | 🟢 Fixed | 🔴 | **New. BUG-43 relocated.** The offline queue was **not user-scoped and survived sign-out** — `signOutAndClearDevice` swept localStorage only, while actions and photo blobs of customer property sat in IndexedDB unscoped, despite that function's own comment promising to "destroy the persisted day". Worse than data at rest: replay runs as whoever is signed in *now*, so tech B picking up the tablet replayed tech A's completions under B's identity — every one rejected by `is_visit_tech`, wedging B's queue from B's first minute | v1.11 |
| BUG-66 | 🟢 Fixed | 🟠 | **New.** **CI never built the app.** `tsc --noEmit` does not run Vite, so a build-breaking change reached deploy unseen — and `check-pwa-output.mjs`, which exists because `/sw.js` 404'd for the entire life of the PWA, is wired into `npm run build` and had therefore **never run automatically once**. It also skips silently with no output, so it could never complain about its own absence | v1.11 |
| BUG-67 | 🟢 Fixed | 🟠 | **New.** The offline cache's **3-day maximum age could never fire on a device that was used**. `savedAt` was the write time, and restoring immediately re-persists, so every launch re-stamped it — the quantity measured was "time since the app was last opened", always ~0 for a tech opening it each morning. The guarantee that a device left in a drawer comes back with nothing to show held only for a device nobody touched | v1.11 |
| BUG-68 | 🟢 Fixed | 🟠 | **New.** A **backward device clock made stale data read as current** — and every one of the three checks failed open: `ageMs` clamped to 0 so a three-day-old route rendered *"saved just now"*; `beyondTrustHorizon` went negative so the red escalation never fired; and `restoredFromDisk`, measured against the same skewed clock, could return `{status:"live"}` so **no banner rendered at all**. A test asserting `formatCacheAge(-5) === "just now"` had enshrined the misreport as intended | v1.11 |
| BUG-69 | 🟢 Fixed | 🟠 | **New.** **Revoking a session did not reach the device.** On a genuine auth rejection `beforeLoad` redirects before `ensureReadCachePersistence`, so the `SIGNED_OUT` backstop was never armed on that boot and nothing sweeps at launch. A terminated tech's route — addresses, gate codes, lock box codes, access notes — stayed readable in localStorage on the crew tablet until someone happened to sign out through the app | v1.11 |
| BUG-61 | 🟢 Fixed | 🔴 | **New, security.** A **tech could rewrite any DNA violation** in their organization. Every RLS policy on `dna_matches` was `is_org_member` — read, insert, update *and* delete — and techs pass it, while holding neither `can_write_org` nor `manage_dna_billing` and being unable to open `/dna` at all. Two triggers were doing the real authorization and they guard the **money column** precisely (`fine_cents`, the move to `billed`, deleting a *processed* sample). Neither covers **who a violation blames** or **whether it is still open**. Proven live as a real tech, rolled back: re-pointed a $250 violation onto another client's dog, closed it, and deleted a sample sitting at the lab — `fine_cents` untouched in all three, so the billing trigger never fired once. Baseline moved to `can_write_org`, both triggers kept on top. **Latent:** `dna_matches` holds zero rows | v1.10 |
| BUG-52 | 🟢 Fixed | 🔴 | **New.** Booking a one-off visit silently converted a **PREPAID client to postpaid**. The insert omitted `billing_cadence` and took the table default; `client_default_billing_cadence` answers with the newest-started *active* subscription's cadence, and a one-off booked for today or later **is** that row. The client's add-on charges then stop drawing down credit they have already paid and start landing on postpaid invoices — money funded once, billed twice. Proven live: `cadence_before=prepaid, cadence_after_one_off=postpaid`. Two prepaid clients exist today | v1.9 |
| BUG-53 | 🟢 Fixed | 🔴 | **New, and not about one-offs.** `admin_generate_seasonal_deepcleans` selected `status = 'active'` and nothing else — but **ending a service writes `ends_on` and LEAVES status active**. So every plan a tenant had ever cancelled stayed a deep-clean candidate, twice a year, for ever, billed as the subscription price **plus** the surcharge (default $49) against a client with no service, with a tech routed to them. Found only because a *finished one-off* received one. Fixed in SQL; verified three ways — finished one-off 0, ended weekly 0, live weekly still 1. **Latent:** zero orgs have the feature enabled, so nobody was billed | v1.9 |
| BUG-54 | 🟢 Fixed | 🟠 | **New.** "Active services" meant two different things. `listClients` counted `status = 'active'` while the client's own Services tab used `isServiceEnded` (canceled **or** `ends_on` passed). Every ended service therefore counted on the client list as one the tenant was running, and its frequency stayed in their chips. Latent — zero rows were in that state — until one-off bookings started creating one every time | v1.9 |
| BUG-55 | 🟢 Fixed | 🟠 | **New.** The one-off refusal path left an **orphan**. No transaction, so throwing after the subscription insert left a priced, `status='active'` service with no visit — and every failed attempt left another. Orphans are not inert: they are what the cadence lookup reads, what the portal shows as "your plan", and what the deep-clean generator bills. Now deleted before the throw | v1.9 |
| BUG-56 | 🟢 Fixed | 🟠 | **New.** Failing to assign a tech failed the **whole booking** — for a visit that already existed and was already billable. The dialog stayed open with every field filled, so pressing the button again (the natural response to an error) created a second subscription and a second visit for the same client, property and date. Nothing dedupes that: the unique index is `(subscription_id, scheduled_on)` and these are two different subscriptions. Assignment is best-effort now and says so | v1.9 |
| BUG-57 | 🟢 Fixed | 🟠 | **New.** A **past-dated** one-off became `missed` overnight and was never invoiced. `admin_transition_missed_visits` flips every past-dated `scheduled` visit, and neither invoicing path bills a missed visit — so "log the make-up we did yesterday" produced free work recorded on the client's history as a service failure. The date field has a `min` | v1.9 |
| BUG-58 | 🟢 Fixed | 🟠 | **New.** A one-off **poisoned the property's routing time**. `recomputePropertyEstimate` took the newest active subscription, so a finished call-out became the property's cadence — and `computeEstimatedMinutes` multiplies by `initialCleanupFactor` (**2**) for `one_time`. It did not move at booking time; it detonated on the next dog change or property edit that triggered a recompute, and `service_duration_min` drives routing, ETAs and capacity | v1.9 |
| BUG-59 | 🟢 Fixed | 🟠 | **New, customer-facing.** The **client portal showed a dead one-off as "your plan"** — same query shape. Worse than cosmetic: the `subscriptionId` handed to `portalChangeFrequency` was that finished call-out, so a client switching to biweekly would have rewritten a completed one-off, left their real weekly service untouched, and sent the office a review ticket about a service that does not exist | v1.9 |
| BUG-60 | 🟢 Fixed | 🟡 | **New.** Booking a one-off **regenerated the whole organization's schedule**. `generate_visits_through` is org-wide and was called with the booking date. Harmless inside the 60-day horizon; past it, one booking materialised visits for every active subscription across a window whose blackouts nobody had entered — and `addBlackout` only inserts a row, it does not remove visits already generated, so they stay routed on top of the holiday | v1.9 |
| BUG-47 | 🟢 Fixed | 🟠 | **New.** CI ran **48 of the 52 test files**. `npm test` was a hand-typed list of filenames in `package.json`; four files had never been added and so had never run, and `tests/stripe-connect.server.test.ts` had been **failing since BUILD-6** changed the return shape it asserts on. CI was green throughout — a test file CI does not name is a test file CI cannot fail on. `npm test` is now `vitest run`, and a drift guard (`tests/ci-runs-every-test.test.ts`) now fails if a list comes back — in `package.json`, in the workflow, or as a test file hidden outside `tests/`. Mutation-tested on all three. Fixing that test also revealed the BUILD-6 branch had **no coverage at all** — the half that decides whose bank account a customer's money lands in. Added, mutation-tested both ways | v1.8 |
| BUG-48 | 🟢 Fixed | 🟠 | **New.** Every button in `VisitDetailDrawer` was guaranteed to fail. It opens from `/routes` and `/dashboard`, and `ROUTE_ROLES` excludes techs from both — so nobody who could see it was ever the assigned tech, and it called the tech RPCs, which authorize on `is_visit_tech()`. Proven live on a real scheduled visit: the org's own owner returns **false** for that guard and **true** for `can_write_org`. Now uses the `office_*` variants like the desktop board, hides the controls from a dispatcher instead of showing buttons that throw, and drops Start entirely — there is no `office_start_visit`, because the office has no honest arrival time to stamp | v1.8 |
| BUG-49 | 🟢 Fixed | 🟡 | **New.** The mobile schedule told users to *"tap a visit to view details, reassign, or reschedule"*. The drawer has no staff picker and no date field and never did. The same wrong claim sat in three places — the component header, the user-facing footer, and the comment in `routes.tsx` that seeded both. Corrected, and a reassign control was actually built (Q-12) | v1.8 |
| BUG-50 | 🟢 Fixed | 🟡 | **New.** A **second `skip_visit`**, granted to `authenticated`, called by nothing since 2026-07-01. `skip_visit(uuid,text)` shipped first; the reason-code version arrived two days later as a *new signature*, so Postgres kept both, and the older body predates the org skip-billing rules. Dropped and verified live. The detector could not have found it — see IMP-11 | v1.8 |
| BUG-51 | 🟢 Fixed | 🟡 | **New.** Billing an add-on is the only visit action **not** queued offline — start, complete, skip and photos all go to IndexedDB. A tech offline saw either a wrong sentence (the price list is deliberately not persisted to the device, so an empty catalog read as *"the office never set add-ons up"*) or a live-looking Bill button that failed with a raw network error. Both now say what is actually happening. Whether the charge itself should queue is Q-11 | v1.8 |
| BUG-36 | 🟢 Fixed | 🔴🔴 | **New.** BUG-33's twin, one tier up. That closed the anon surface; nobody asked what a *signed-in* user could reach. ~35 SECURITY DEFINER functions took an org, client, visit or payment id as a **parameter** and trusted it, with no authorization check in the body — and signup is public, so anyone can hold an authenticated session. Reads included customer names and revenue for any organization; writes included account credit, franchise billing, visit completion and the email queue. Revoked where the app never calls from a browser, membership-checked where it does | v1.6 |
| BUG-37 | 🟢 Fixed | 🔴🔴 | **New.** Postpaid invoicing produced **nothing for fifteen days and reported success**. `20260716220000` reintroduced `p.address_line1` — a column renamed to `street` long before, and already fixed once — so every invoice raised. It stayed invisible because `run_billing_cycles` catches per-client failures with a `RAISE WARNING` into a log nobody reads and returns only the SUCCESS count: a night where every client failed returns 0, the same answer as a night with nothing due. Verified live — newest `invoice_line_items` row dated 2026-07-16, the day that migration landed. Failures now file to the review queue | v1.6 |
| BUG-38 | 🟢 Fixed | 🟠 | **New.** A $79 Launch org could mint franchise codes. The franchise RPCs checked role and never plan, and the TypeScript funnel was the only gate — which a browser skips by calling `supabase.rpc` directly. So a Launch owner could create a link code, recruit locations, and run the entire Enterprise franchise feature unpaid. `has_plan_entitlement`, the SQL mirror nothing had ever called, is now the check inside all six parent-side functions | v1.6 |
| BUG-39 | 🟢 Fixed | 🟠 | **New.** A seasonal deep clean was scheduled, shown as one, and **billed as an ordinary visit** — `deepclean_charge_cents` was stamped on every generated visit and read by nothing. $49 per client per configured month, silently, from the moment anyone enabled it | v1.6 |
| BUG-34 | 🟢 Fixed | 🔴 | **New.** A bank *inquiry* was recorded as a lost chargeback. Stripe's `warning_*` statuses withdraw no funds, but `charge.dispute.created` fires for them, so an inquiry marked the payment refunded and billed the location immediately; when it closed with nobody taking anything, the `else` branch filed `chargeback_lost` and /disputes said "decided in the customer's favour". A $600 inquiry on a $1,000 payment cost the location $600 it never lost and took $600 off net revenue in /reports, /analytics and the CPA pack, permanently. The inline comment asserting `warning_closed` means the customer kept the money was simply wrong | v1.6 |
| BUG-35 | 🟢 Fixed | 🔴 | **New.** A second dispute on the same payment was silently discarded. `review_items` is unique on `(org, kind, subject_id)` and the filer used DO NOTHING, so the second dispute — the one with the evidence deadline — never reached the queue, and `record_franchise_adjustment` computed a delta of zero. Two real disputes of $400 and $600 on a $1,000 charge billed the location **$600 against $1,000 actually clawed back, a $400 shortfall the franchise ate**. A later win then reversed the *first* adjustment and flipped the payment back to `succeeded`, restoring gross the bank still held. Both tables are now keyed per dispute. Verified live: inquiry bills $0, two disputes bill $1,000 across two rows, redelivery is a no-op, and a win reverses only its own dispute | v1.6 |
| BUG-33 | 🟢 Fixed | 🔴🔴 | **New, and the most serious thing found this cycle.** The publishable anon key — the one inside the browser bundle of every page we serve — could execute **128 of 159** database functions, 112 of them `SECURITY DEFINER` and 73 of those with no authorization check at all. Demonstrated live with no JWT whatsoever: `client_ltv` returned five real customer names with revenue, `churn_drivers` returned six rows, `enqueue_email` accepted a write. Also reachable: functions that generate invoices and visits into any organization by id, and `post_credit_entry`, which writes account credit. The org UUID those need is not secret — the public lead-form RPC hands it out by design. Individual migrations *had* revoked; a later blanket `GRANT … ON ALL FUNCTIONS` undid them. Now revoked in a loop over the live catalog with five functions granted back, default privileges reset so the next one cannot reopen it, and no regression for signed-in or server-side callers (both verified). anon-executable: **128 → 5** | v1.6 |
| BUG-29 | 🟢 Fixed | 🔴 | **New.** A cancelled subscription kept HoundStack's AI keys forever. `customer.subscription.deleted` re-writes `stripe_subscription_id` rather than clearing it, and BUILD-7's "a live subscription is a fact" shortcut read that stored id as proof of payment — so a cancelled org stayed `paid`, its AI receptionist kept answering on our unmetered keys, and no banner said otherwise. Two siblings in the same read: a tenant suspended **for fraud** kept `plan_status='active'` (suspension only writes `billing_status`), and an admin-granted grace period read as no-plan-at-all because `grace` exists only in the *other* enum. Now reads both columns and checks ended states first, so the failure direction is a denial we can hear about rather than a bill we cannot | v1.6 |
| BUG-30 | 🟢 Fixed | 🟠 | **New.** Every settings change an office manager made reported success and did nothing. `organizations` had one UPDATE policy — owner-only — while both permission matrices grant `manage_settings` to office_manager; PostgREST reports a zero-row UPDATE as a success. Worst case was `contact_email`, the reply-to address BUILD-5 had just made load-bearing: an office manager fixing it got a green toast while replies kept going to `noreply@`. Policy now keyed on `has_permission()` so the matrix has one definition, and `updateOwnOrg` refuses to claim success without the row back | v1.6 |
| BUG-31 | 🟢 Fixed | 🟠 | **New.** A franchise-provisioned location was free forever and could be created with nobody able to administer it. `provision_franchise_location` INSERTs the organization directly, bypassing the only code that starts a trial, so each one landed in the `none` phase with nothing for enforcement to act on — a button that minted permanently free accounts, available only to Enterprise franchises. It also accepted a member list with no owner, and the parent is not a member of its own child, so the result was an organization nobody in the product could reach and no product path could repair | v1.6 |
| BUG-32 | 🟢 Fixed | 🟡 | **New.** Three contradictory answers to "is AI on". Settings → AI read availability from environment variables alone, so a trial org was told AI was enabled; its health check blamed our deployment for their plan and sent them to support, who cannot change a plan; and the tools themselves said to add an API key in a field IMP-9 deleted with BYOK. The one correct sentence — `aiUnavailableReason` — was written and never reached. Related: BUILD-7 set `plan_status='trialing'` but left `billing_status`, and `/platform/tenants` reads the latter, so every trial showed as "Free" and the trialing filter returned nothing | v1.6 |

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

**IMP-11 detail — the detector, and what it caught immediately.**

Six times in one cycle the same defect appeared: machinery built, granted,
correct, and called by nothing. `franchise_rollup` (every franchise dashboard
blank, for everyone, always). The weekly-digest endpoint (never scheduled). The
`trialing` state (never entered). Three routing functions (unreachable). And
`franchise_share_cents` — written on every adjustment, read by nothing, and it
turned out to be the missing term in the settlement formula, so locations were
billed for refunds they had already paid.

None of those is catchable by tests or types. A test proves machinery works
*when called*; it says nothing about whether anything calls it. An uncalled
function is perfectly well-typed.

So the check looks only at the SEAMS where one system hands off to another —
SQL→app, cron→endpoint, writer→reader — and asks whether the other side exists.
Three rules: an RPC granted to the app and called from neither TypeScript nor
SQL; an external endpoint with no declared caller; a column written by a
migration and read by nothing.

*It starts green and it is a hard CI gate*, unlike lint. The precedent is
`check-migrations.mjs`, whose own header records that a naive diff reported ~80
false positives and would have been ignored — worse than no check. So every rule
is conservative, trigger functions and generated files are excluded, and every
existing exception is recorded with a reason.

*Mutation-tested*, like the permission parity test: adding a granted function
with no caller fails the check; giving it a caller passes; removing it returns
to green.

**On its first run it found four things nothing calls**, two of which this cycle
built:

| | |
|---|---|
| `provision_franchise_location` | The flow the owner described — a franchise creates a location, names the staff, they get invites. SQL built and verified live; **no UI calls it**, so a franchise still cannot open a location from the product. |
| `franchise_signals` | Platform-admin sales intelligence; no screen renders it. |
| `optimize_route_for_day` | Predates the in-app optimiser. Dead or unfinished — needs a decision. |
| `/hooks/announcement-emails` | No scheduler, so an announcement marked `send_email` is never sent. |

*Known gaps are reported on every run, green or not.* A baseline entry whose
reason starts `KNOWN GAP` is counted and named in the check's own output, so
recorded debt stays visible rather than vanishing the moment it is written down.
The baseline is a record of decisions, not a mute button — which is exactly the
trap a check like this invites.

**And then the check was turned on itself, and all three rules were wrong.**
This is the part worth remembering, because the check had been reporting green
the whole time.

*Rule 3 could never fire.* The write-only-column rule allowed `ON|AND|OR|,` plus
200 characters of anything before the column name, so a column matched its own
`CREATE TABLE` body and counted as read by itself. Run with the application text
forced empty — where every column in the repo should have been flagged — it
flagged 0 of 187, `franchise_share_cents` among them: the BUG-24 column the rule
was written for, matching `ON DELETE SET NULL,` two lines above its own
declaration. It now inverts the question — blank every declaration and every
write, and whatever text is still standing is a read — and is proven both ways:
with that column's two real readers deleted the new rule flags it and the old
one still does not.

*Rule 1 counted comments as callers.* SQL comments were stripped precisely
because prose headers name the functions they explain; TypeScript was scanned
raw. Six granted RPCs appeared in `src/` only inside comments.
`portal_resolve_contact` is the proof: retired, unreachable, and passing the
check because the sentence announcing its retirement mentions it by name. The
same defect existed in SQL and the review missed it on the first pass —
`detect_review_items` looked called from a string inside `COMMENT ON TABLE`.

*Rule 1's call pattern would have failed CI on correct code.* It enumerated
`PERFORM|SELECT|JOIN|FROM|=|,|(` and omitted `RETURN`, `IF`, `NOT`, `AND`, `OR`
and `WHERE` — so a function called only as `IF NOT public.x(...) THEN RAISE`,
this repo's dominant guard idiom at four existing sites, read as uncalled. The
enumeration was itself the bug, so it is gone: strip the DDL that names the
function, and any surviving `name(` is a call.

**Known gaps went 2 → 10, and that was the point.** The jump was measurement,
not a new outbreak — seven things had always been dead and invisible. Among them
`has_plan_entitlement`, the SQL mirror of `PLAN_ENTITLEMENTS`, which the IMP-3
parity test keeps honest by parsing the migration *as text* rather than calling
it: so plan gating was enforced in TypeScript only and the database enforced
none of it, which is the exact thing having a SQL mirror was supposed to fix.
Also `signup_utm`, captured since 2026-07-14 and read by nothing, and a reversal
audit trail nothing could answer a question from. Every one was verified against
the live database before being believed. All ten have since been closed — the
ledger is at zero, and the check is green with 17 exceptions, each carrying a
reason.

**One residual, and the header says so rather than implying otherwise.** Rule
2's baseline records a pg_cron schedule for each scheduled endpoint —
`nightly-automation`, `weekly-digest`, `process-email-queue`. Those strings were
verified by hand against `cron.job` once; nothing re-checks them. If a job is
dropped, the baseline still asserts it exists and the check still reports green.
Verifying only when database credentials happen to be present would be worse: it
would pass silently in exactly the environment everyone trusts.

**BUILD-5 detail — what white label already was, and the bug underneath it.**

Unlike the trial, branding was NOT dead machinery. `brand_color` and `logo_url`
are set from Settings → Preferences, applied to the app accent, and rendered on
the client portal; three organizations have a brand colour set. That part works.

The site sells the remaining two pieces as **add-ons, both marked "(coming
soon)"** — `white-label-portal` and `white-label-emails`, $19/mo each, both
`coming_soon` and `is_active = false`. So nothing is falsely promised, and
nothing is sellable either until Stripe lands.

*True white label is owner-blocked, not engineering-blocked.* "White-label
emails" means sending from the tenant's own domain, which needs the Resend
account and per-tenant SPF/DKIM verification. "White-label portal" means a
custom domain, which needs DNS and hosting config. Neither can be built —
let alone verified — without accounts I do not have. Building an unverifiable
half would be worse than saying so.

*What the survey found instead.* Client emails already carry the tenant's
business name as the `from` display name — so a customer sees "Detroit Doo
Disposal" on their invoice and reasonably hits Reply. There was **no `reply_to`
anywhere in the pipeline**: not set when enqueuing, not forwarded to Resend. So
every reply went to `noreply@notify.houndstack.com`, a mailbox nobody reads.
Questions about a bill, a missed visit, a wrong charge — silently discarded, and
because a no-reply address accepts mail rather than bouncing it, the customer
believed they had reached their provider.

Fixed end to end. And **completed rather than half-shipped**: `contact_email` is
settable in Preferences but **zero organizations had set one**, so the fix alone
would have helped nobody. The field now says plainly what an empty value costs,
because that cost is otherwise invisible from that screen. Deliberately no
fallback to the owner's login address — that is often personal, and putting it
in front of every customer without being asked is not a default to pick for
somebody.

**BUILD-7 detail — the trial nobody ever had.**

The ledger line was five words from v1.0 ("Trial → Growth + AI sandbox"), so
the first job was finding out what existed. The answer: nothing.

`bootstrap_organization` has never set `trial_ends_at` or
`plan_status = 'trialing'`. Verified live — seven organizations, zero with a
trial end date, none ever in `trialing`. And **nothing in the tenant app gates
on billing status**: every reference is a platform-admin view or a metrics
rollup. So every account that has ever signed up has unlimited free access,
forever, and always did. The `trialing` enum value, billing-state's branch for
it, and the announcement audience filter were all built around a state nothing
ever entered — the same shape as the weekly digest and the franchise rollup.

*Two owner decisions shaped the rest.*

**Day 15 does not lock.** Stripe is not authorized, so there is no way to
convert. A paywall whose only exit is a payment nobody can make is an outage: it
would brick every existing account fourteen days from deploy, the owner's
included. Expiry is a state and a banner; `TRIAL_ENFORCEMENT` in
`src/lib/trial.ts` is the single constant that makes it real when Stripe lands.

**AI is paid-only** — the owner chose this over a capped sandbox. AI runs on
HoundStack's keys with no metering (BUILD-2, Stripe-blocked), so a trial with AI
is unbounded spend with nothing to detect it. Gating it needed one new module
because there are THREE ways into the model and only one goes through
`resolveOrgAiConfig`: the weekly digest and the AI receptionist reach the
gateway directly, and those are the *unattended* paths — cron and inbound SMS —
so neither has a human to notice the bill. `ai-access.server.ts` is the one rule
all three consult. It fails CLOSED, unlike `PlanGate`, which fails open:
showing a feature to a non-payer costs nothing, calling the model does.

*Not backfilled, deliberately.* The six existing free organizations keep what
they have. Retro-fitting a fourteen-day clock onto an account somebody has used
for weeks is a surprise, not a migration.

*Consequence to be aware of:* six organizations are `free`, including the
owner's own, and none of them can use AI under this rule. Only Demo Pet Waste Co
is `active`. Any org that needs AI for testing should be given a paid status
from the platform tenant screen.

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
| VER-8 | ✅ Verified | Annual billing works in the app and is now correctly priced on the site. Two corrections to this entry's own wording: there is no `annual_plan_prices` table — the columns live on `platform_plans` — and the gap was never that the site lacked annual billing. It had it, at the wrong number. Closed with MKT-9 / BUG-45 | v1.7 |
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
| IMP-11 | 🟢 Fixed | 🟠 | Dead-machinery detector — a hard CI gate for the failure this project keeps producing: something built, granted and correct that nothing ever calls. Turned on itself in v1.6 and found one rule that could not fire, one counting comments as callers, and one that would have failed CI on correct code; all three rewritten and mutation-proven in v1.7. **v1.8 adds a fourth rule and fixes a blind spot the first three shared:** rule 1 keys on a function's NAME, so two signatures of one name collapse and a dead overload is vouched for by the live one's callers — which is how a second `skip_visit` stayed granted and uncalled for a month (BUG-50). Drops and creates are now tracked per signature, and rule 4 flags any name with more than one live signature. Its first run reported five findings, all five false, all caused by its own type normalization — recorded in the header as the general rule. Green with 17 exceptions, no open known gaps. One residual: the cron schedules in rule 2's baseline are asserted by a human and checked by nothing | v1.5 |
| IMP-13 | 🟢 Fixed | 🔴 | **New.** **Eight protections could be switched off with the full suite green** — the most consequential finding of the QA pass, because it means everything else in this ledger was less verified than it read. At `vitest run` 752 passed, a mutation could: delete the CSRF middleware from `requestMiddleware`, leaving the app with no CSRF protection at all; replace the nightly cron's `if (!auth.ok) return cronUnauthorized(...)` with `void auth`, opening autopay charges and invoice generation to anyone who can POST; swap `encryptSecret(token)` for `token` at the accounting write site, undoing IMP-1; comment out the `CREATE TRIGGER` for `tg_orgs_protect_platform_columns`, detaching the guard while leaving the body every test reads; `ALTER TABLE payments DISABLE ROW LEVEL SECURITY`, invisible to every policy-text scan; change the royalty divisor from 100.0 to 10.0 and invert the settlement balance signs; widen `generate_franchise_settlements` to `is_org_member`; and redefine `is_org_member` in a later migration without its caller guard, because `permission-parity.test.ts` read one hard-coded filename. Every one was a guard whose EXISTENCE was checked while nothing checked it was CONNECTED. New `tests/the-wiring-is-connected.test.ts` asserts only wiring; the weak tests are repaired in place. Also closed two discovery holes: vitest never ran `.test.tsx` files, and an `exclude:` entry could silently drop real ones. Twelve mutations, all now caught | v1.14 |
| IMP-12 | 🟢 Fixed | 🟠 | **New.** The other direction of schema drift. IMP-2's `check-migrations.mjs` compares migration files to Supabase's applied ledger — it answers "did production run everything the repo has", and cannot answer "does production have something the repo never wrote". That is the direction that stays invisible, because nothing fails until an environment is rebuilt and an object simply is not there; three functions had drifted that way undetected (BUG-75). `check-schema-declared.mjs` sweeps every function in `public` against every migration, wired into CI beside its counterpart. A GRANT mentioning a name does **not** count as a declaration — that is precisely how `email_queue_wake` hid, since a migration granted EXECUTE on a function no migration created. The allow-list is for platform-owned objects only and is currently empty; the check also fails on an allowance naming a function that no longer exists, so it cannot rot into a blanket exemption. Three mutations run, all caught. **Known gap:** it covers functions, not tables, policies, indexes or triggers | v1.12 |
| IMP-10 | 🟢 Fixed | 🔴 | **Closed in v1.5, and it was worse than logged.** `src/lib/revenue.ts` is now the one definition — money that ARRIVED (`succeeded` or `refunded`), reversals deducted in their own period — mirrored in SQL with a parity test that fails on drift. Fixing it turned up BUG-21 (a real money error), a third copy of the royalty calculation in the nightly cron, and an AI-tools query with no status filter at all that counted declined cards as revenue. Invoice-based revenue stays separate and is reconciled by BUILD-13's bridge rather than conflated | v1.4 |
| IMP-9 | 🟢 Fixed | 🟠 | Retire the BYOK surfaces — **done, and the "wait for BUILD-2/BUILD-3" ordering in v1.2 was wrong.** See below | v1.3 |
| IMP-8 | 🟢 Fixed | 🟡 | **New.** Org timezone was built but buried in Routes; moved to Settings | v1.1 |
| BUILD-1 | 🟢 Fixed | 🔴 | Per-feature entitlements — plan tiers now enforced server-side; the published pricing matrix was being ignored by the app. See below | v1.2 |
| BUILD-2 | ❓ Blocked | 🔴 | Usage metering — Q-7 answered (soft caps + overage); needs Stripe. **Now the only thing between us and unmetered AI spend** — see IMP-9 below | v1.3 |
| BUILD-3 | ⏳ Waiting | 🟠 | Managed texting — Q-8 = per-tenant subaccount + own brand. In the 10DLC compliance queue; nothing to accelerate | v1.1 |
| BUILD-4 | 🟢 Fixed | 🟠 | Managed AI — BYO deleted, inference runs on the platform key, and the product no longer asks for a key. The remaining gap is metering, which is BUILD-2, not BUILD-4 | v1.3 |
| BUILD-5 | 🟠 Part-built | 🟠 | White label — the surveyable half is done and it turned up a live customer-facing bug: **every reply to an invoice or reminder went to a no-reply address nobody reads**, with no bounce, so the customer believed they had been in touch. Reply-to now carries the tenant's office email end to end. True white label (own sending domain, own portal domain) needs the Resend account and per-tenant DNS — owner-blocked like Stripe. Both add-ons are `coming_soon` and unsellable until then | v1.5 |
| BUILD-6 | 🟠 Part-built | 🟠 | Enterprise tier — **phases 1–4 shipped**: consent-based linking, repaired rollup, both sides' UI, the money side, and now **a franchise can open a location from the product** — name it, name the staff, they get invites and sign themselves in. That was the flow the owner described, the SQL for it had existed unused since 2026-07-30, and it was the last piece the product could not do. Platform-side franchise sales signals now render too. **v1.12 attacked the money paths and found six defects** (BUG-70 through BUG-75) — three ways a non-owner could take or rewrite money, a tech reading the ledger and the invite codes, a repayment silently dropped, and three functions live in no migration. All fixed and re-probed; all latent, because no franchise exists yet. What held up under attack: the three routing setters correctly require the parent's owner, every `set_config('app.allow_protected_org_write')` call is transaction-local, `tg_orgs_protect_platform_columns` covers all franchise columns, and a child owner cannot cut its royalty, self-unlink or seize payments (proven live — royalty stayed 8.00). **v1.13 closed the settlement-math pass** (BUG-76 through BUG-79): four more defects, three claims dismissed on evidence, and one of my own fixes caught wrong by the probe of the fix. Remaining: multi-org membership, drill-down, and royalty *delivery* | v1.6 |
| BUILD-7 | 🟠 Part-built | 🟡 | Trial lifecycle built — and the finding was that **no organization had ever had a trial**, because `bootstrap_organization` never started one and nothing in the tenant app gated on billing status at all. New signups get the 14 days the site promises; expiry is a state and a banner, NOT a lock, because Stripe cannot take a payment yet. AI is paid-only (owner decision). Enforcement is one constant, flipped when Stripe lands. **v1.6:** an adversarial review found three ways a non-paying org still reached `paid` and kept the AI keys — see BUG-29. The state machine now reads both status columns and has a `lapsed` phase, because telling someone who cancelled a paid plan that their free trial ended reads as a product that lost track of what they bought | v1.6 |
| BUILD-8 | 🟢 Fixed | 🟡 | AI Business Advisor **built out** (owner reversed the retire instruction). On-demand, 7/30/90-day windows, evidence shown beside the advice. See below | v1.3 |
| BUILD-9 | 🟠 Part-built | 🟠 | Mobile Phase 2/3. **The native app now boots and runs with no network** — proven by serving the bundle as static files with every off-origin request blocked, loading it in headless Chromium, and watching it hydrate and render from 36 files on disk with zero off-origin requests. Getting there meant a client-bootable SPA shell (this is a server-rendered app; `.output/public` had no index.html, which is why the config pointed at a remote URL), an absolute server-function origin, CORS, CSRF, and an offline read cache — plus BUG-43 and BUG-44, both of which had to be fixed before "offline" could mean anything. Q-3's answer was NOT a config flag as the ledger implied. **v1.11 correction:** the offline half was proven and remains true, but the ONLINE half was never exercised by it — every cross-origin server-function reply would have decoded to `undefined` (BUG-62), because the proof blocked all off-origin requests. Fixed. Remaining: **a real device, in a real dead zone AND on real signal.** Q-4 closed in v1.9 (one-off visit built), Q-12 answered reassign-only in v1.8, Q-5 closed in v1.10 (field DNA sample logging) | v1.7 |
| BUILD-10 | 🟢 Fixed | 🟠 | Review queue built. §10.5's rule pointed at a mechanism nobody had made, so every place that "honored" it honored it by doing nothing. See below | v1.4 |
| BUILD-11 | 🟢 Fixed | 🟠 | **New.** End-of-day close-out for visits left open | v1.1 |
| BUILD-13 | 🟢 Fixed | 🟠 | **New.** CPA / tax report pack — ten reports, each declaring its basis and carrying its caveats into the CSV. Cash and accrual income, the bridge between them, point-in-time AR aging, refunds, write-offs, 1099-K reconciliation, franchise settlements, referral rewards. Also the 1099-K explanation the owner asked for, keyed to how payments are actually routed. See below | v1.5 |
| BUILD-12 | 🟢 Fixed | 🟠 | Invoice dispute queue — own page under Billing, an analytics toggle that never touches the tax reports, and `payment_chargeback_lost` so a lost dispute stops reading as "open" forever. See below | v1.5 |
| RESP-1…5 | 🔵 Open | 🟠 | All five still need real hardware | v1.0 |
| MKT-1 | 🟢 Fixed | 🔴 | Catalog truth — Q-13 answered (every add-on at launch). Site now lists the 6 real add-ons with prices; the 3 phantom SKUs are gone | v1.2 |
| MKT-2 | 🟢 Fixed | 🔴 | Broken AI features no longer described as live | v1.1 |
| MKT-3 | 🟢 Fixed | 🟠 | The four tier cards did not line up — 117px of drift on the divider at 1280px, because each card sized itself independently and the price/allowance/blurb wrap to different line counts per tier. Cards are now subgrids sharing the outer grid's row tracks, so alignment holds by construction with no magic heights to go stale. Feature matrix itself was already correct at every width | v1.5 |
| MKT-4 | 🟢 Fixed | 🔴 | Contact form wired to the real Formspree endpoint, with `_subject` and a `form` field so the two forms are distinguishable in one inbox | v1.2 |
| MKT-5 | 🟢 Closed | 🟠 | **The ledger was wrong, not the site.** This entry said `/privacy` and `/terms` were drafts pending review. Checked in v1.14 against both the source and the built HTML: neither page carries a draft notice and neither ever did. They are complete documents, dated, ported from the app's canonical copies at `/legal/privacy` and `/legal/terms`. Owner decision 2026-08-01: publish as they stand, continue formal review after payments begin. There was nothing to remove — the entry was the error, which is the third time this cycle a ledger line has been treated as a fact about the product | v1.14 |
| MKT-6 | 🟠 Part-built | 🟡 | SEO gaps closed: a double-escaped title, TWO identical FAQPage blocks on two pages, four separate Organization nodes and two contradicting SoftwareApplication entities, all now single-`@id`. Offers say PreOrder, not InStock — nothing is buyable yet. **Analytics needs you:** Plausible is already installed and firing events; registering the domain and creating goals needs your account | v1.5 |
| MKT-7 | 🔵 Open | 🟡 | Real product screenshots | v1.0 |
| MKT-8 | ⚪ Deferred | ⚪ | `/customers` stub | v1.0 |
| MKT-9 | 🟢 Fixed | 🟡 | Annual billing was already built on BOTH sides — the app has the interval toggle and switch confirmation, the site has the monthly/yearly switch. What no ledger entry caught is that they disagreed on the number; see BUG-45 | v1.7 |

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
| Q-2 | ✅ | **Built in v1.14, and the answer was righter than the question.** The tablet tier exists — but driven by ROLE rather than width, which is why every earlier attempt to move a breakpoint failed. A tech keeps the tab bar through 768–1024px; an office user does not, because the dispatch board renders there and a bottom bar would cover it. Width was standing in for role and it is the wrong proxy. The bar's reach and the main content's bottom padding read one hook, or the bar lands on My Day's Complete button. Original wording follows: The answer was a dedicated tablet tier at 768–1024px. **There is one breakpoint in this app (768px) and no tablet tier exists.** The mobile tab bar is `md:hidden`, so it vanishes at exactly 768 — a tech on a crew tablet gets the desktop sidebar and none of the tech nav, while the offline-cache code repeatedly assumes crew tablets. Not fixed by a blunt breakpoint move: pushing the bar to `lg` would also hide the dispatch board from an iPad, where it renders today and is arguably right. The two halves want different answers, which makes it a real tablet tier or nothing | v1.1, reopened v1.8 |
| Q-3 | ✅ | Bundled Capacitor assets | v1.1 |
| Q-4 | ✅ | Sheet relabelled, and **the one-off visit is built** — bookable from `/routes`, the mobile ➕ sheet, and the client's Visits tab. **The claim that made this a question was mine and it was wrong:** there was never "no way to create a one-off visit" — Client → Services → Add service → "One time" has existed all along. What did not work was booking one for TODAY. See the v1.9 changelog | v1.9 |
| Q-5 | ✅ | The ceiling was never the question. A tech's More sheet holds 6 rows and the only real divergence from the spec was **DNA sample logging — specified, never built**, while a comment asserted for months that it had been. Now built: `log_dna_sample_from_field`, guarded by `is_visit_tech`, on the my-day visit card. Chasing the false comment is what found BUG-61 | v1.10 |
| Q-6 | ✅ | Plan-gated existing roles | v1.1 |
| Q-7 | ✅ | Soft caps + overage billing | v1.1 |
| Q-8 | ✅ | Per-tenant subaccount + own 10DLC brand | v1.1 |
| Q-9 | ✅ | Grandfather existing multi-entity tenants indefinitely | v1.1 |
| Q-10 | 🔄 | Cancel with credit/refund — **moot**, no external subscribers exist | v1.1 |
| Q-11 | ✅ | The UI is honest now (BUG-51): an add-on charge is the one field action that is not queued, and it says so. Whether it *should* queue is still yours. **Owner answered v1.14: no, it stays online-only.** The other four queued actions record what already happened; this one moves money against a price the device cached earlier, and a replay hours later could bill a customer at a price that changed while the device was in a dead zone. The UI already says so | v1.8 |
| Q-12 | 🟠 Part-answered | **Reassign only, and it is built.** Below 768px the drag board is `display:none` and there was no other way to move a visit, so a dispatcher could not redistribute a sick tech's day from a phone. The drawer now has a tech picker. Reschedule and reorder stay desktop — reorder is meaningless without the board, and reschedule needs `manage_client_billing`, which a dispatcher does not hold | v1.8 |
| Q-13 | ✅ | Every add-on available at launch, after QA. Site updated; the app's `platform_addons` are still `coming_soon`/inactive and stay that way until live Stripe (owner: Stripe last) | v1.2 |

---

# 3. OPEN DECISIONS & EXTERNAL BLOCKERS

**Needs your action, not engineering:**

0a. **Should the site say the trial excludes AI?** BUILD-7 makes AI paid-only,
   which is a material limitation a prospect should know before signing up. No
   published copy currently claims the trial includes AI, so nothing is false
   today — but nothing says it doesn't either, and the pricing FAQ is where that
   belongs. How to frame a limitation that affects conversion is your call, not
   an engineering one.


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

**Two things only you can confirm, because this sandbox cannot:**

6. **Two curls against the real deployment**, once the CSRF and CORS work is
   live. The preflight:
   `curl -i -X OPTIONS https://app.houndstack.com/_serverFn/getMyDay -H
   'Origin: capacitor://localhost' -H 'Access-Control-Request-Method: POST'`
   should answer 204 with `access-control-allow-origin: capacitor://localhost`.
   And the ACTUAL response, which is the one BUG-62 was hiding in — the same
   URL as a POST must come back carrying
   `access-control-expose-headers: x-tss-serialized, x-tss-raw`. Without that
   header the app receives every reply successfully and decodes all of them
   wrongly, with nothing anywhere reporting a problem. The rules are unit-tested
   and the middleware is wired, but nothing here has seen a response cross a
   real edge.

7. **The native app on a real device with no signal.** Offline boot was proved
   in headless Chromium against static files with every off-origin request
   blocked, which is the strongest evidence available without hardware — it is
   not the same as airplane mode on a tech's phone in a yard.

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

