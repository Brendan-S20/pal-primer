# Backups and restore

Production is Supabase Pro (project `vsxzrbxublqrcfnxfwcu`) **without
point-in-time recovery**. This page says what is backed up, where, for how
long, how much can be lost, and exactly how to get it back — the whole project,
or one tenant's rows without touching anyone else's.

There are two independent copies:

| | Supabase daily backup | Our nightly backup (`.github/workflows/backup.yml`) |
|---|---|---|
| Taken | Daily, by Supabase | Daily at 07:30 UTC |
| Kept | 7 days (Pro plan) | 30 days (encrypted archive), 90 days (summary) |
| Where | Supabase's storage, same company as production | GitHub Actions artifacts on this repo |
| Restores | The **whole project**, in place, from the dashboard, with downtime | Into a **new** project or a local database; one tenant at a time |
| Proven restorable | Not by us | Every Sunday, automatically (the restore drill) |
| Downloadable | No (physical backups; see Supabase's docs) | Yes |

Use the Supabase backup when the whole database is lost or wrecked and
everyone can go back to the same morning. Use ours for everything else: one
tenant's mistake, anything older than 7 days, or a copy that does not depend
on Supabase.

## How much can be lost (RPO) and how long it takes (RTO)

Stated plainly, because "we have backups" tends to be heard as "nothing can be
lost".

- **Up to 24 hours of data can be lost.** Both copies are once a day. A
  mistake at 06:00 UTC loses almost a full day of everything written since
  the previous backup — visits completed, payments recorded, notes typed.
  Only point-in-time recovery (a paid Supabase add-on) narrows that, to about
  two minutes.
- **Whole project from Supabase's backup:** minutes to an hour of downtime,
  growing with database size. Nobody can use the app while it runs.
- **Whole project from our backup into a new project:** realistically **half
  a day**: the restore itself is quick, but pointing the app at a new project
  (keys, custom domain, auth settings, storage files) is a checklist, below.
- **One tenant's rows from our backup:** an hour or two of careful work, no
  downtime for anyone else.

## What is in our backup

`scripts/backup/dump.sh` uses the Supabase CLI the way Supabase documents for
moving a project ([Backup and Restore using the CLI][cli-doc]): three files,
plus a row count of each table.

| File | What it holds |
|---|---|
| `roles.sql` | Custom database roles (no passwords; Supabase's own roles are left out because every project has them) |
| `schema.sql` | Every schema the app owns — `public`, `reference`, anything a migration created — with functions, policies, triggers, grants. Not `auth`/`storage`/`cron`/`vault`: the platform creates those itself |
| `data.sql` | Every row in every schema the platform does not manage, **including `auth.users` and the rest of `auth`** — logins, password hashes, identities — plus `storage.buckets`/`storage.objects` (file *metadata*) and `reference.zip_centroids` |
| `extension-state.sql` | The pg_cron schedule and the email queues, as statements that recreate them. `pg_dump` skips both, because their tables belong to extensions — found by dumping a database built from the migrations and getting neither back. Two of the cron jobs exist in no migration, so this is their only copy. Queue *contents* (emails waiting at 07:30 UTC) are not kept |
| `counts.json` | Rows per table, counted from `data.sql` itself, plus the number of cron jobs and queues |

**Why auth is in the data and not the schema.** `auth`'s *structure* belongs to
Supabase and is created by the new project's own auth service; its *rows* are
ours. A restore without `auth.users` would bring back every invoice with nobody
able to sign in to see it. After a restore every account still works with the
same email and password; everyone has to sign in again, because a new project
signs sessions with different keys.

**Deliberately left out of `data.sql`:** pg_net's outbox
(`net.http_request_queue`) and response log (`net._http_response`) — a
restored outbox would re-send requests to customers' webhook endpoints — and
pg_cron's run history (`cron.job_run_details`).

**Not in either backup, and worth knowing before you need it:**

- **Files in Storage** — job photos, waste receipts, expense receipts,
  avatars. The database holds only their metadata. Supabase says the same of
  its own backups: "Database backups do not include objects you store via the
  Storage API". A file deleted from Storage is gone. Supabase's docs have a
  script for copying buckets between projects; nothing copies them on a
  schedule today.
- **Vault secrets** (`cron_service_role_key` and the like). Encrypted with a
  key that belongs to the project, so they are recreated, not restored.
- **Project settings that are not rows**: auth providers (Google/Apple),
  redirect URLs, SMTP, the auth hook, API keys, the custom domain
  `api.houndstack.com`.
- **App secrets** in Lovable, and anything held by Stripe, Twilio or Resend,
  which keep their own records.

The encrypted archive is a gzip'd tar of those five files, encrypted with
OpenPGP (AES-256) under the `BACKUP_PASSPHRASE` secret. Any GnuPG opens it.

The **summary** artifact (`summary.json`) is not encrypted and holds no
customer data: table names, row counts, sizes, the archive's sha256, versions.
It is there so somebody can see at a glance that last night's backup was the
size it should be. Each run's page also shows the key tables in its job
summary, beside a count taken from production a moment after the dump; a large
gap between the two shows up as a warning.

## The restore drill

Every Sunday (and on any manual run with the box ticked) a second job takes
the backup that run just made and, on a fresh GitHub-hosted machine:

1. checks the archive's sha256 is the one the backup recorded,
2. decrypts it with `BACKUP_PASSPHRASE`,
3. starts a brand-new local Supabase from an **empty** directory (Postgres
   plus the auth and storage services, whose own migrations create the
   schemas the data loads into),
4. runs Supabase's documented restore in one transaction, with triggers off,
   and **switches every restored cron job off before it commits**, so the
   copy never calls production or a customer's webhook,
5. then fails unless every table holds **exactly** the rows the dump holds,
   `organizations` and `auth.users` are not empty, and every foreign key in
   `public`/`reference` still holds.

What it proves: last night's file decrypts with the passphrase we have, and
restores into a new Supabase project with every row and every reference
intact. What it does not prove: that the app works against the restored copy
(nothing signs in to it), or anything about Storage files.

## Owner steps (one time)

1. **Create the passphrase and keep it in two places.** Run
   `openssl rand -base64 32`. Save the result in your password manager
   **first**, as "HoundStack backup passphrase". Then add it on GitHub:
   **Settings → Secrets and variables → Actions → New repository secret**,
   name `BACKUP_PASSPHRASE`. GitHub never shows a secret again; the password
   manager is the only copy a person can read. **Lose it and every backup is
   unreadable** — by you as much as anyone. At least 20 characters, or the job
   refuses it.
2. **Run it once by hand** after this merges: **Actions → Backup → Run
   workflow** (leave "Also restore" ticked). This is also the answer to the
   open question below about hosted runners. Both jobs green means a backup
   exists and has been restored.
3. **Optional: look at Supabase's own backups** at **Database → Backups →
   Scheduled backups** in the dashboard, and confirm seven daily backups are
   listed. Nothing in this repo can see them.
4. **Watch for failure emails.** GitHub emails a failed scheduled run to
   whoever last edited the schedule in `backup.yml`. A failure here means
   there was no off-site backup that night.

**Open question this answers on its first run.** GitHub stopped allocating its
hosted runners to this repository on 2026-08-10 (see
`docs/self-hosted-runner.md`), and no recent run in this repo has used one.
Both backup jobs run on hosted runners on purpose — they hold every customer's
data in plaintext for a few minutes, and a hosted machine is destroyed after
the job, where the Mac keeps a work directory. If hosted runners are still
unavailable, the run fails in seconds with no steps. The fix is restoring
hosted-runner allocation (Settings → Billing and plans, spending limit or
included minutes), not moving this onto the Mac.

The SUPABASE_DB_URL secret must be a **session-pooler** or direct connection
string (port 5432). Hosted runners have no IPv6, so a direct
`db.<ref>.supabase.co` string only works with the IPv4 add-on; the session
pooler (`aws-0-<region>.pooler.supabase.com:5432`) always does. The
transaction pooler (port 6543) is not suitable for `pg_dump`.

## Restore (a): the whole project, from Supabase's daily backup

For: the whole database is lost or wrecked, and losing everything since that
morning's snapshot is acceptable for every tenant.

1. Dashboard → project `vsxzrbxublqrcfnxfwcu` → **Database → Backups →
   Scheduled backups**.
2. Pick the newest backup taken **before** the damage. Each one back is
   another day lost.
3. **Restore** and confirm. The project is unavailable until the dashboard
   says it is done; the larger the database, the longer.
4. Afterwards: everything written after that snapshot is gone, for every
   tenant. Storage files are **not** rolled back (files uploaded since still
   exist, with no database row pointing at them; files deleted since are not
   brought back). Tell tenants what window was lost; payments taken in that
   window still exist in Stripe and need re-recording.
5. Run **Actions → CI → Run workflow** on main: the migrations job checks the
   database's schema against the repo, which matters if a migration was
   applied after that snapshot was taken.

Supabase also offers restoring a backup into a **new** project ("Duplicate
project" in their docs) on some plans. If the dashboard offers it, that is the
safest way to get at yesterday's rows **without** rolling production back —
then follow (c) with the duplicate as the source.

## Restore (b): from our encrypted backup

Needs: Docker, the Supabase CLI, `psql` 17 and GnuPG. On a Mac:
`brew install supabase/tap/supabase postgresql@17 gnupg` and Docker Desktop.

**Get the backup.** **Actions → Backup** → the run for the night you want →
**Artifacts → db-backup** (and `db-backup-summary`). Unzip both downloads; you
have `houndstack-db-<timestamp>.tar.gz.gpg` and `summary.json`.

### Into a local database, to look at it

The same script the drill runs. It asks for the passphrase if
`BACKUP_PASSPHRASE` is not set, restores into a fresh local stack on 547xx
(543xx and 544xx are taken on the dev machine), verifies it, and leaves it
running:

```bash
KEEP_STACK=1 DRILL_PORT_PREFIX=547 \
  scripts/backup/drill.sh ~/Downloads/houndstack-db-<timestamp>.tar.gz.gpg ~/Downloads/summary.json

psql postgresql://postgres:postgres@127.0.0.1:54722/postgres
```

It prints the command to stop the stack when you are done. The decrypted dump
is deleted when the script exits **unless** `KEEP_STACK=1`; with it, delete the
temp directory it names once you have finished — it is every customer's data
in plaintext.

### Into a new Supabase project, to replace production

1. Create a new project in the same region, Postgres 17
   ([database.new](https://database.new)). Copy its **session pooler**
   connection string (Connect → Session pooler) with the database password.
2. Decrypt:
   ```bash
   scripts/backup/crypt.sh open houndstack-db-<timestamp>.tar.gz.gpg ./restore
   ```
   (prompts for the passphrase; or `gpg --decrypt <file> | tar -xzf -`).
3. Restore — Supabase's documented command, which `restore.sh` wraps, adding
   the cron schedule and email queues `pg_dump` leaves out, the cron
   switch-off, and error messages with no customer data in them:
   ```bash
   scripts/backup/restore.sh ./restore "postgresql://postgres.<new-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres"
   ```
   or by hand:
   ```bash
   psql --single-transaction --variable ON_ERROR_STOP=1 \
     --file restore/roles.sql \
     --file restore/schema.sql \
     --command 'SET session_replication_role = replica' \
     --file restore/data.sql \
     --file restore/extension-state.sql \
     --file scripts/backup/disable-restored-cron-jobs.sql \
     --dbname "<new project connection string>"
   ```
   It refuses a database that already has `public.organizations`, so it
   cannot be pointed at production by mistake.
4. Verify, exactly as the drill does:
   ```bash
   node scripts/backup/verify-restore.mjs ./restore "<new project connection string>"
   ```
5. **Cut over** — the part that takes the time:
   - Vault: recreate `cron_service_role_key` (the new project's service-role
     key) and any other secret the cron jobs read.
   - Auth: providers (Google, Apple), Site URL and redirect URLs, SMTP, the
     auth hook (`AUTH_HOOK_SECRET`), MFA settings.
   - Storage: create the buckets and copy the files from the old project if it
     still exists (Supabase's migration doc has a script). If it does not, the
     files are lost; the rows pointing at them will show broken images.
   - The custom domain `api.houndstack.com` → the new project, and the app's
     Lovable secrets (`SUPABASE_URL`, anon and service-role keys).
   - **Last**, once the old project is no longer running them, turn the cron
     jobs back on: `select cron.alter_job(jobid, active := true) from cron.job;`
     (`postgres` cannot UPDATE `cron.job` directly on Supabase).
   - Run CI's migrations job against the new project (update the
     `SUPABASE_DB_URL` secret) to confirm the schema matches the repo.
6. Delete the decrypted `./restore` directory.

## Restore (c): one tenant's rows, without touching anyone else

For: one organization lost or mangled data; every other tenant must keep
everything they did since the backup. Do it in a quiet hour, and read it
through first.

Rehearsed on 2026-10-04 against a database built from `supabase/migrations`
with two seeded tenants: one tenant's 10 properties and 149 visits deleted,
then brought back by exactly the steps below, with the other tenant's rows
untouched and all 232 foreign keys holding.

**1. Bring the backup up locally** (as in (b), `KEEP_STACK=1`). Call that
database `scratch` (`postgresql://postgres:postgres@127.0.0.1:54722/postgres`).

**2. Find the tenant** in scratch:

```sql
select id, name, created_at from public.organizations where name ilike '%yard%';
```

**3. Copy that tenant's rows into a staging schema** in scratch. Every table
carrying `organization_id`:

```sql
\set org '00000000-0000-0000-0000-000000000000'
create schema tenant_restore;
select format('create table tenant_restore.%I as select * from public.%I where organization_id = %L;',
              c.table_name, c.table_name, :'org')
  from information_schema.columns c
  join information_schema.tables t using (table_schema, table_name)
 where c.table_schema = 'public' and c.column_name = 'organization_id' and t.table_type = 'BASE TABLE'
 order by 1 \gexec
```

Then list the tables with **no** `organization_id` and decide each one by hand
— child tables (line items, visit photos and the like) are reached through
their parent:

```sql
select table_name from information_schema.tables t
 where table_schema = 'public' and table_type = 'BASE TABLE'
   and not exists (select 1 from information_schema.columns c
                    where c.table_schema = 'public' and c.table_name = t.table_name
                      and c.column_name = 'organization_id')
 order by 1;
-- e.g.
-- create table tenant_restore.invoice_line_items as
--   select li.* from public.invoice_line_items li
--   join tenant_restore.invoices i on i.id = li.invoice_id;
```

If the tenant's **accounts** were deleted too, copy their `auth.users` and
`auth.identities` rows the same way (join through `public.user_roles`).

**4. Copy the staging schema to production**, and only the staging schema:

```bash
pg_dump "<scratch url>" --schema=tenant_restore --no-owner --no-privileges -f tenant_restore.sql
psql "<production url>" -v ON_ERROR_STOP=1 -f tenant_restore.sql
```

**5. Put the rows back, in one transaction, in production.** For each staged
table, generate an `insert … select` with an explicit column list — the
columns both sides have, so a migration applied since the backup does not
break it — that skips any row whose primary key production already has. Run
it in the same psql session as step 6, with `\set org` set again:

```sql
\set org '00000000-0000-0000-0000-000000000000'
begin;
-- Triggers off for this transaction only: no "visit completed" webhook, no
-- invoice email, no automation re-run for rows that already happened once.
set local session_replication_role = replica;

select format(
  'insert into public.%I (%s) overriding system value select %s from tenant_restore.%I s where not exists (select 1 from public.%I p where %s);',
  s.table_name, s.cols, s.cols, s.table_name, s.table_name, k.pk)
from (
  select st.table_name,
         string_agg(quote_ident(st.column_name), ', ' order by st.ordinal_position) as cols
    from information_schema.columns st
    join information_schema.columns pr
      on pr.table_schema = 'public' and pr.table_name = st.table_name and pr.column_name = st.column_name
   where st.table_schema = 'tenant_restore' and pr.is_generated = 'NEVER'
   group by st.table_name
) s
join (
  select c.relname as table_name,
         string_agg(format('p.%I = s.%I', a.attname, a.attname), ' and ') as pk
    from pg_index i
    join pg_class c on c.oid = i.indrelid
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    join pg_attribute a on a.attrelid = c.oid and a.attnum = any(i.indkey)
   where i.indisprimary
   group by c.relname
) k using (table_name)
order by 1 \gexec
```

Why it is shaped like this: the first two versions were run and refused —
`on conflict (id)` fails on a table whose key is not `id`
(`ai_usage_periods`), and a bare `on conflict do nothing` is refused by a table
with a deferrable unique constraint. Keying on each table's own primary key
avoids both; generated columns are left out because Postgres computes them. (A staged table with no primary key is silently left out by the join;
every table with `organization_id` had one when this was written.)

This brings back rows that were **deleted** and leaves every row that still
exists exactly as it is now. If rows were **changed** rather than deleted and
you want the backup's values back, delete the tenant's current rows of that
table inside the same transaction first, then insert — which also throws away
anything the tenant changed in those rows since the backup.

**6. Check, then commit.** Triggers off means foreign keys were not checked,
so check them, and check the tenant's counts:

```sql
\i scripts/backup/no-orphans-after-restore.sql
select count(*) from public.clients where organization_id = :'org';
commit;   -- or rollback; and nothing happened
drop schema tenant_restore cascade;
```

Drop it the same day: CI's migrations job reports any schema in production
that no migration declares, and `tenant_restore` is one.

Values that triggers normally maintain (balances, denormalised totals) were not
recomputed for the restored rows; open the tenant's invoices and clients in the
app and check them. Then drop `tenant_restore` in scratch too, stop the local
stack, and delete the decrypted files.

## Where things live

- `.github/workflows/backup.yml` — the schedule, both jobs, and why each runs
  where it does.
- `scripts/backup/` — `dump.sh`, `crypt.sh`, `summarize.mjs`, `restore.sh`,
  `verify-restore.mjs`, `drill.sh`, and the two SQL files they run.
- `tests/a-backup-nobody-has-restored-is-a-hope.test.ts` — pins the parts of
  this design that are easy to undo by accident: hosted runners, encrypt
  before upload, the drill comparing counts.

[cli-doc]: https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore
