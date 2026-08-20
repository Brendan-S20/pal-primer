# Security-advisor triage

**Dated 2026-08-20.** The Supabase security advisor returns 107 findings for
this project. One was a real hole and is fixed. The other 106 are the shape this
application is built in, and this document is why they can be dismissed — so the
next person reads a page instead of repeating an afternoon.

The correct way to re-check any section is to re-run the queries it quotes.
Re-reading the advisor tells you nothing new; it will report the same 106.

| category | count | verdict |
| --- | --- | --- |
| `authenticated_security_definer_function_executable` | 92 | 91 by design, **1 was a hole** — fixed 2026-08-20 |
| `anon_security_definer_function_executable` | 6 | by design — the deliberate public allowlist |
| `rls_enabled_no_policy` | 8 | by design — deny-all, pinned by a test |
| `extension_in_public` (pg_net) | 1 | false positive, and the remediation is unavailable |

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

Verified on production by attempting the call as the `authenticated` role:

```sql
set local role authenticated;
select * from public.staff_start_point('<org>', gen_random_uuid(), current_date);
-- ERROR: permission denied for function staff_start_point
```

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

## 2. The 91 by-design definer functions

A `SECURITY DEFINER` function callable by a signed-in user is how most of this
app works. The advisor is saying such a function runs past RLS and must do its
own authorization — not that it is broken. All 91 do, in one of seven shapes:

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
select p.oid::regprocedure, p.prokind
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prosecdef
   and has_function_privilege('authenticated', p.oid, 'EXECUTE');
```

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
`cast_roadmap_vote` takes a client-supplied `p_voter`, so it is spoofable — that
is ballot-stuffing on a roadmap poll, not money and not auth, and its migration
reasons about the exposure explicitly.

Worth knowing: `public_get_org_for_lead_form` is the org-uuid disclosure that
made §1 reachable without guesswork. It is deliberate, but anything newly keyed
on an org id should be read with it in mind.

## 4. The 8 deny-all tables

`portal_otps`, `portal_sessions`, `portal_code_attempts`, `email_verifications`,
`impersonation_grants`, `oauth_states`, `org_twilio_credentials`, `roadmap_votes`.

RLS enabled, zero policies — deny-all to `anon` and `authenticated`, evaluated
after the blanket table grants, so those grants buy nothing.
`relforcerowsecurity` is false, so the postgres-owned definer functions and the
service-role client pass through, and those are the only callers. Every access in
`src/` goes through `supabaseAdmin`.

For two of them a policy would be a regression, not a loosening: a readable
`impersonation_grants` row tells a tenant it is being impersonated, and a
readable `oauth_states` row defeats the callback check it exists to make.

Pinned by `tests/eight-tables-that-are-deny-all-on-purpose.test.ts`, which fails
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
