# Proofs

Runnable evidence for migrations whose whole point is a behaviour, not a
schema. A migration's own `DO $verify$` block can assert what the file
ESTABLISHES from any starting state — that a trigger attached, that a function
body still consults the permission matrix. It cannot act out an exploit, because
that needs a tenant, a technician and a visit, and a replay into an empty
database has none of those.

These build the tenant themselves, in a transaction that always ends in
`ROLLBACK`.

```bash
supabase db reset
psql "postgresql://postgres:postgres@127.0.0.1:54422/postgres" \
  -v ON_ERROR_STOP=1 -f supabase/proofs/20260825060000-tech-column-write.sql
```

## Every file here ends with a mutation test, and that is the point

A proof that only shows the fix working cannot tell you the fix is what did it.
So each one disables or reverts the thing under test, shows the fault
reproducing, and puts it back. If that step does NOT reproduce the fault, the
script raises INCONCLUSIVE rather than passing — a green run where the mutation
silently stopped reproducing is worth less than a red one.

## Two traps these already hit, so you do not have to

**Creating an organization fires `tg_orgs_protect_platform_columns`,** via
`trg_reassign_billing_tier`, and it refuses the write. Do not reach for
`session_replication_role = 'replica'` — `postgres` is not superuser on a local
Supabase and cannot set it, and if it could, it would also disable the trigger
the file exists to test and every assertion would pass for the wrong reason.
Use the guard's own hatch, `app.allow_protected_org_write`, and close it before
the first assertion. Both files then assert it is closed.

**Act as the `authenticated` ROLE, not just as a uid.** Setting
`request.jwt.claims` alone leaves you as `postgres`, which bypasses RLS — so a
policy-shaped fault would not reproduce. Temp tables need
`GRANT SELECT ... TO authenticated` once you do this.
