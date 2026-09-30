# Security-advisor triage

**Audited 2026-08-20. Counts re-measured 2026-09-13.** The Supabase security
advisor returns a hundred-odd findings for this project. One was a real hole and
is fixed. The rest are the shape this application is built in, and this document
is why they can be dismissed — so the next person reads a page instead of
repeating an afternoon.

The correct way to re-check any section is to re-run the queries it quotes.
Re-reading the advisor tells you nothing new.

| category | 2026-08-20 | 2026-09-13 | verdict |
| --- | --- | --- | --- |
| `authenticated_security_definer_function_executable` | 92 | 90 | by design, **1 was a hole** — fixed 2026-08-20 |
| `anon_security_definer_function_executable` | 6 | 6 | by design — the deliberate public allowlist |
| `rls_enabled_no_policy` | 8 | 9 | by design — deny-all, pinned by a test |
| `extension_in_public` (pg_net) | 1 | 1 | false positive, and the remediation is unavailable |

### The count moves. Do not read a moved count as a finding.

Both numbers that changed above changed for reasons written down elsewhere in
this repo, and neither is a regression:

- **9 deny-all tables, not 8.** `roadmap_vote_throttle` arrived with
  20260913100000. §4.
- **90 definer functions, not 92.** `staff_start_point` lost its grant on
  2026-08-20 (§1), and `accept_org_invite_for_current_user()` — the no-argument
  overload — was dropped by 20260825160000 in favour of the one that takes a
  token. Functions have also been added and replaced since; the net is 90.

Which is the point: **the number is a measurement of a database on a day, and
the claim this document actually makes is a property.** Chasing the count
teaches you nothing. Re-check the property instead, with one query:

```sql
-- Every definer function reachable by `authenticated` names one of the guard
-- shapes in §2. The only rows this should EVER return are the six deliberately
-- public functions in §3, which have no caller to authorize.
select p.oid::regprocedure::text as fn
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prosecdef
   and has_function_privilege('authenticated', p.oid, 'EXECUTE')
   and p.prosrc !~* ('(can_write_org|has_permission|has_role|is_visit_tech'
                     || '|is_org_member|is_platform_admin|auth\.uid\(\))')
 order by 1;
```

The parentheses around the concatenation are load-bearing and the first draft of
this block did not have them: `!~*` binds tighter than `||`, so without them
Postgres parses `(prosrc !~* 'a') || 'b'` and refuses the statement with
`argument of AND must be type boolean, not type text`. Every query in this
document has been pasted into the live database and run, because a triage page
whose re-check instructions do not execute is worse than no page.

Run 2026-09-13: six rows, and all six are the §3 list — `cast_roadmap_vote`,
`org_accepts_public_leads`, `public_get_org_by_slug`,
`public_get_org_for_lead_form`, `public_quote`, `roadmap_vote_counts`. A
seventh name appearing there is a function that forgot its gate, and that is a
finding whatever the totals say.

`prosrc` and not `pg_get_functiondef`, deliberately — see the migrations rule in
CLAUDE.md for why the latter raises on a set it has not been narrowed by name.

---

## 1. The one that was real: `staff_start_point(uuid, uuid, date)`

`SECURITY DEFINER`, granted to `authenticated`, and containing no `auth.uid()`
anywhere. Every tier filtered on the **caller-supplied** `_org_id`, so any
signed-in user of any tenant could point it at any other tenant and read back an
employee's home coordinates, the business location, or the exact latitude and
longitude of one of that tenant's customer properties. Returning `'none'` was
itself a scheduling oracle. The victim's org uuid needs no guessing:
`public_get_org_for_lead_form(_slug)` is granted to `anon` and returns `id` for
any non-deleted org.

Fixed by `20260820060000_a-signed-in-tech-could-ask-any-tenant-where-its-customers-live.sql`,
a single `REVOKE EXECUTE … FROM authenticated`. Nothing calls it by RPC; its only
in-database callers are `plan_route` and `plan_visits`, both `SECURITY DEFINER`
and owned by `postgres`, so they run it as the owner. `service_role` keeps
EXECUTE, so the nightly cron path is untouched.

Verified on production. Ask the catalog rather than attempting the call, so the
check needs no org uuid and covers **every overload** — which matters here more
than anywhere else in this document, because an overload is exactly how a revoke
gets quietly undone, and there are two of these now:

```sql
select p.oid::regprocedure::text as fn,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_can_execute,
       has_function_privilege('anon',          p.oid, 'EXECUTE') as anon_can_execute
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'staff_start_point'
 order by 1;
```

Run 2026-09-13 — two rows, `staff_start_point(uuid,uuid,date)` and
`staff_start_point(uuid,uuid,date,uuid[])`, both false for both roles. The
four-argument overload arrived after the revoke and came out closed; a `true` in
either column is the hole reopening.

**The rule that should have caught it, and why it did not.**
`tests/six-helpers-that-answered-questions-about-other-peoples-tenants.test.ts`
already encoded the right rule. Its `closedToTheWeb` helper accepted a revoke
from *either* `authenticated` or `public`, and the defining migration writes
`REVOKE ALL … FROM public, anon;` immediately followed by
`GRANT EXECUTE … TO authenticated, service_role;`. The `public` arm matched the
first line and the second was never read — the exact collapse that helper's own
neighbouring docstring forbids. It is now an ordered walk that starts pessimistic
and matches **per overload**; the first rewrite keyed on the function name, and a
revoke of the four-argument overload silently cleared the three-argument one.

## 2. The by-design definer functions

A `SECURITY DEFINER` function callable by a signed-in user is how most of this
app works. The advisor is saying such a function runs past RLS and must do its
own authorization — not that it is broken. All of them do, in one of seven
shapes, and the query at the top of this page is how you confirm that without
counting anything:

| shape | example guard |
| --- | --- |
| self-only predicate | `auth.uid() IS NULL OR _user_id IS NOT DISTINCT FROM auth.uid()` |
| write gate | `IF NOT public.can_write_org(auth.uid(), _org) THEN RAISE EXCEPTION` |
| permission gate | `IF NOT public.has_permission(auth.uid(), _org, '…') THEN RAISE EXCEPTION` |
| role gate | `IF NOT public.has_role(auth.uid(), _org_id, 'owner') THEN RAISE EXCEPTION` |
| field-app gate | `IF NOT public.is_visit_tech(auth.uid(), _visit_id) THEN RAISE EXCEPTION` |
| membership, raise or silent-empty | `… AND public.is_org_member(auth.uid(), _org_id)` |
| platform-admin / self-bootstrap | `IF NOT public.is_platform_admin(auth.uid()) THEN RAISE EXCEPTION` |

No `trigger`-returning function is reachable by `authenticated` — the 2026-08-10
pass has held. Confirm with:

```sql
select count(*) as total,
       count(*) filter (where p.prokind <> 'f') as not_plain_functions,
       count(*) filter (where p.prorettype = 'trigger'::regtype) as trigger_returning
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prosecdef
   and has_function_privilege('authenticated', p.oid, 'EXECUTE');
```

Run 2026-09-13: `90, 0, 0`. The answer wanted here is the two zeroes; an earlier
version of this block listed all ninety names instead, which is ninety lines to
read before learning the one thing the paragraph above claims.

**Do not turn this into an allowlist.** That was built, measured against the live
catalog, and deliberately thrown away; the reasoning is in the header of the
six-helpers test. A replay cannot model a grant nobody wrote, so it reported zero
when the truth was one. The per-migration rule in that file is the form that works.

## 3. The 6 anon-executable functions

`public_get_org_by_slug` (branding only, filtered on `public_signup_enabled`),
`public_get_org_for_lead_form` (id + name, deliberately not filtered on signup —
a lead form embedded on a tenant's own site is not the signup page),
`public_quote`, `org_accepts_public_leads` (a boolean the `leads` anon INSERT
policy itself calls), `roadmap_vote_counts` (aggregates), and `cast_roadmap_vote`.

These are the public surface of the product and are meant to be reachable.
`cast_roadmap_vote` takes a client-supplied `p_voter`, so the vote is spoofable
— that is ballot-stuffing on a roadmap poll, not money and not auth. What it was
not, and was described here as if it were, is bounded: `UNIQUE (feature,
voter_id)` reads like a guard but the caller picks both halves of the pair, so
until 2026-09-13 the grant to `anon` was an unmetered INSERT into a production
table by anybody who could read the page source. 20260913100000 added a limit of
60 votes per client address per hour, keyed on `cf-connecting-ip` because
Cloudflare overwrites it and the caller therefore cannot choose it, and gave
`roadmap_vote_counts` a LIMIT so junk slugs could not turn the public poll's own
payload into the second symptom. Stuffing the vote remains possible at 60/hour
and is still not worth an account system; writing without end is not.

Worth knowing: `public_get_org_for_lead_form` is the org-uuid disclosure that
made §1 reachable without guesswork. It is deliberate, but anything newly keyed
on an org id should be read with it in mind.

## 4. The 9 deny-all tables

`portal_otps`, `portal_sessions`, `portal_code_attempts`, `email_verifications`,
`impersonation_grants`, `oauth_states`, `org_twilio_credentials`, `roadmap_votes`,
`roadmap_vote_throttle`.

A tenth arrived with 20260929080000: `webhook_endpoint_secrets`, the encrypted
HMAC keys outbound webhooks are signed with. Deny-all for the same reason as
`org_twilio_credentials` — the owner sees a secret once, in the response that
created or rotated it, and only the delivery worker on the service role reads
it afterwards. The advisor count above will read 10 once it is applied.

RLS enabled, zero policies — deny-all to `anon` and `authenticated`, evaluated
after the blanket table grants, so those grants buy nothing.
`relforcerowsecurity` is false, so the postgres-owned definer functions and the
service-role client pass through, and those are the only callers. Every access in
`src/` goes through `supabaseAdmin`.

For three of them a policy would be a regression, not a loosening: a readable
`impersonation_grants` row tells a tenant it is being impersonated, a readable
`oauth_states` row defeats the callback check it exists to make, and a readable
`roadmap_vote_throttle` row is the list of who-voted-from-where that the poll
promises not to keep. That last one holds salted SHA-256 of the client address
rather than the address, and rows are dropped an hour after the window opens, so
it is a short-lived counter and not a log — but the salt is in the migration, so
with both this repo and table read access the IPv4 space is enumerable. Deny-all
is what makes that a hypothetical.

Pinned by `tests/nine-tables-that-are-deny-all-on-purpose.test.ts`, which fails
if any migration ever gives one of them a policy.

## 5. `extension_in_public` — pg_net

**False positive in substance, and the remediation does not exist.**

- **No pg_net object is in `public`.** All of its members live in schema `net`;
  only `pg_extension.extnamespace` points at `public`. The advisor reads the
  catalog registration, not an object location.
- **`net` is not exposed over the API.** Probed live as `anon`:
  `GET /rest/v1/http_request_queue` → `PGRST205`; with `Accept-Profile: net` →
  `PGRST106 Only the following schemas are exposed: public, graphql_public`;
  `POST /rest/v1/rpc/http_post` → 404. No function in `public` wraps `net.http_*`.
- `anon` and `authenticated` do hold EXECUTE (proacl is NULL, the PostgreSQL
  default of EXECUTE TO PUBLIC) and USAGE on the schema. That is worth knowing as
  defence-in-depth — an SSRF sits behind that property — but there is no route to
  it from the publishable key without a separate arbitrary-SQL bug.
- **`pg_extension.extrelocatable = false` for pg_net**, so
  `ALTER EXTENSION pg_net SET SCHEMA extensions` errors. The only way to change
  the recorded schema is `DROP EXTENSION … CASCADE` and recreate, which takes
  `net.http_post` out from under three live cron jobs (`nightly-automation`,
  `process-email-queue`, `weekly-digest`) and discards anything queued, for zero
  security benefit.

A further trap for anyone tempted to assert this away: `email_infra.sql` already
says `CREATE EXTENSION … SCHEMA extensions`, so a fresh `supabase db reset` does
not reproduce production's `public` registration. A migration asserting "pg_net
is not in public" would pass vacuously on a fresh build and prove nothing about
production.

**Leave it.**

---

## Two things noted during the audit that are owner decisions, not findings

- **`post_credit_entry`** gates on `is_org_member` only, while its billing
  siblings gate on `has_permission(…, 'manage_client_billing')`. So any `tech`
  can post a credit-ledger adjustment against a client **in their own org**.
  Same-tenant privilege breadth, not a cross-tenant leak.
- **`TrialState.restricted`** has no consumer anywhere in `src/`. Enforcement is
  computed and discarded; `aiAvailableFor` gates on `phase === "paid"` whether
  the flag is true or false. `TRIAL_ENFORCEMENT` is `true` and pinned by a test,
  but flipping it today would change no observable behaviour.

---

# Re-run 2026-09-16, and what the PERFORMANCE advisor says

The security advisor was re-run against production through the Supabase MCP
tools. **Nothing regressed**, and the check was done by NAME rather than by
count, because this file's own opening warns that the count moves:

| lint | level | count | state |
|---|---|---|---|
| `anon_security_definer_function_executable` | WARN | 6 | **the same 6**, §3 — none added, none removed |
| `authenticated_security_definer_function_executable` | WARN | 90 | §2, by design |
| `rls_enabled_no_policy` | INFO | 9 | **the same 9**, §4, `roadmap_vote_throttle` included |
| `extension_in_public` | WARN | 1 | §5, `pg_net` |

No ERROR-level findings. §1's real one (`staff_start_point`) does not reappear.

## The performance advisor had never been run, and found one thing that matters

Three of its four findings are noise or known:

- **`unindexed_foreign_keys`, 78.** CLAUDE.md quotes this as its example of a
  number that "describes a database, not this change" — it says 93 there, and it
  is 78 now, which is the same point making itself.
- **`no_primary_key`, 1.** `backup.demo_geo_20260830`, a backup table from the
  Detroit relocation. Correct as it is.
- **`unused_index`, 23.** Unused since the last statistics reset, which on a
  product with one demo tenant means "not exercised yet" far more than it means
  "not needed". Not actionable before real traffic.

**The fourth is a launch item and is recorded nowhere else:**

> Your project's Auth server is configured to use at most **10 connections**.
> Increasing the instance size without manually adjusting this number will not
> improve the performance of the Auth server. Switch to a percentage based
> connection allocation strategy instead.

Supabase's own remediation link for it is the *going into production* guide,
which is exactly the transition this product is making. It is inert while one
demo tenant signs in and becomes the ceiling on concurrent sign-ins the moment
real ones do — and the trap named in the text is the expensive one: paying for a
larger instance and getting no more Auth throughput, because the cap is absolute
rather than proportional.

It is a project setting in the Supabase dashboard, so it is an owner action. See
`docs/owner-actions-before-submission.md`.

## Re-running these

Both advisors are one call each through the Supabase MCP tools, and worth
running after any DDL change — the security one catches a table that gained RLS
without a policy, which is the failure this file exists to triage. Compare by
NAME against the sections above, never by count.
