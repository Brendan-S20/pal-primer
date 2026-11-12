#!/usr/bin/env bash
# Dump the production database the way Supabase documents for a restore into a
# new project: three files, roles / schema / data.
#
#   SUPABASE_DB_URL=postgresql://... scripts/backup/dump.sh <out-dir>
#
# Writes <out-dir>/roles.sql, schema.sql, data.sql, extension-state.sql and
# counts.json. Needs the Supabase CLI (and Docker, which it runs pg_dump in),
# psql and node.
#
# ── WHY THE SUPABASE CLI AND NOT A BARE `pg_dump -Fc` ─────────────────────
#
# A whole-database pg_dump of a Supabase project carries the platform's own
# schemas (auth, storage, realtime, vault, ...) as DDL owned by
# supabase_admin, and restoring that into a new project fails on permissions
# before it reaches a single customer row. `supabase db dump` runs pg_dump in
# the Supabase Postgres image with the platform's own filtering:
#
#   roles.sql   pg_dumpall --roles-only, minus the reserved roles every
#               project already has, and with no passwords.
#   schema.sql  every schema we own -- public, reference, and anything else
#               a migration made -- and NOT auth/storage/cron/vault/..., whose
#               structure the platform creates and upgrades itself.
#   data.sql    rows from EVERY schema not on the platform's internal list,
#               auth INCLUDED. That is the point of the split: auth's tables
#               are the platform's to define but the rows are ours -- every
#               login, every password hash, every identity -- and a restore
#               without auth.users would bring back every invoice with nobody
#               able to sign in to see it. The data dump also carries
#               storage.objects (file METADATA, not the files), cron.job, the
#               pgmq email queues and reference.zip_centroids.
#
# This is the procedure in
#   https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore
# and the restore half is scripts/backup/restore.sh.
#
# ── WHAT IS LEFT OUT OF data.sql, AND WHY ─────────────────────────────────
#
#   storage.buckets_vectors, storage.vector_indexes
#       Supabase's own documented exclusions: newer storage tables a fresh
#       project's storage service owns.
#   net.http_request_queue
#       pg_net's OUTBOX. A row here is an HTTP request not yet sent. Restored,
#       pg_net sends it -- from the restored database, to wherever it was
#       addressed: a customer's webhook endpoint, or this app's own cron hook.
#       A backup is not a place to keep requests in flight.
#   net._http_response
#       pg_net's log of response bodies. Six hours of other servers' replies,
#       some of which echo what we sent them. Noise to a restore, and the
#       wrong place for a copy of whatever they contained.
#   cron.job_run_details
#       pg_cron's run log. Grows every minute (deliver-webhooks runs every
#       minute), restores nothing anyone needs.
#
# ── WHAT pg_dump SKIPS ON ITS OWN, AND extension-state.sql ────────────────
#
# Two things the app depends on live in tables an EXTENSION owns, and
# `pg_dump --data-only` does not write them, whatever the exclusion list says.
# Found by running this against a database built from supabase/migrations,
# not by reading: the data dump came back with no cron.job rows and no email
# queues.
#
#   cron.job   pg_cron's schedule. Its rows are only dumped with the extension
#              itself, and the CLI's `--schema '*'` means no extension is.
#              Two jobs here exist in no migration (process-email-queue and
#              nightly-automation are scheduled by hand), so without this they
#              would be lost for good.
#   pgmq       the email queues. On a database built from the migrations
#              each queue's table is a member of the pgmq extension, so it is
#              skipped the same way. On PRODUCTION it is not (measured
#              2026-10-04, pgmq 1.5.1: only pgmq.meta is a member), so the
#              data dump wrote COPY blocks for pgmq.q_* and pgmq.a_* that
#              schema.sql never creates -- the CLI leaves the pgmq schema out
#              -- and the first drill was refused at the first of them. So
#              every pgmq table that is NOT an extension member is read from
#              the database at dump time and excluded by name below, and a
#              data.sql that still holds a pgmq COPY block fails the dump.
#
# So they are read with psql and written as statements that recreate them:
# `SELECT pgmq.create(...)` per queue and `SELECT cron.schedule(...)` per job.
# Queue CONTENTS are not kept -- emails waiting at 07:30 UTC, mostly sign-in
# codes that expire in minutes. restore.sh runs this file after the data and
# then switches every job OFF in the same transaction.
#
# ── NOTHING HERE PRINTS A ROW OR THE CONNECTION STRING ────────────────────
#
# The CLI echoes only progress lines. --debug would print the connection, so
# it is never passed. The URL goes to the CLI as an argument on a disposable
# hosted VM, which is how ci.yml's live checks already pass it to psql.

set -euo pipefail

out="${1:?usage: dump.sh <out-dir>}"
: "${SUPABASE_DB_URL:?SUPABASE_DB_URL is not set}"
for tool in supabase psql node; do
  command -v "$tool" >/dev/null || { echo "::error::$tool is not on PATH"; exit 1; }
done

here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$out"

q() { psql "$SUPABASE_DB_URL" -X -At -v ON_ERROR_STOP=1 -c "$1"; }

# The email queues' own tables, wherever they are not extension members (see
# above). Named one by one because the CLI's -x takes schema.table, not a
# pattern. Empty on a database where pgmq owns them, which is correct.
queue_tables=()
while IFS= read -r t; do
  [ -n "$t" ] && queue_tables+=(-x "$t")
done < <(q "select n.nspname || '.' || c.relname
              from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'pgmq' and c.relkind in ('r', 'p')
               and not exists (select 1 from pg_depend d
                                where d.classid = 'pg_class'::regclass
                                  and d.objid = c.oid and d.deptype = 'e')
             order by 1")

supabase db dump --db-url "$SUPABASE_DB_URL" -f "$out/roles.sql" --role-only
supabase db dump --db-url "$SUPABASE_DB_URL" -f "$out/schema.sql"
supabase db dump --db-url "$SUPABASE_DB_URL" -f "$out/data.sql" --use-copy --data-only \
  -x "storage.buckets_vectors" \
  -x "storage.vector_indexes" \
  -x "net.http_request_queue" \
  -x "net._http_response" \
  -x "cron.job_run_details" \
  ${queue_tables[@]+"${queue_tables[@]}"}

# A dump that "succeeded" into an empty file is the cheapest failure to catch
# and the most expensive one to discover at restore time.
for f in roles schema data; do
  if [ ! -s "$out/$f.sql" ]; then
    echo "::error::$f.sql is empty -- the dump did not produce anything"
    exit 1
  fi
done
if grep -q '^COPY "pgmq"\.' "$out/data.sql"; then
  echo "::error::data.sql holds rows for a pgmq table, which schema.sql does not create -- a restore would be refused there"
  exit 1
fi
if ! grep -q '^CREATE TABLE IF NOT EXISTS "public"\.' "$out/schema.sql"; then
  echo "::error::schema.sql defines no table in public -- this is not a dump of the app's database"
  exit 1
fi

{
  echo "-- State kept in extension-owned tables, which pg_dump --data-only skips."
  echo "-- Generated by scripts/backup/dump.sh; run by scripts/backup/restore.sh."
  if [ "$(q "select to_regclass('pgmq.meta') is not null")" = "t" ]; then
    q "select format('SELECT pgmq.create(%L);', queue_name) from pgmq.meta order by queue_name"
  fi
  if [ "$(q "select to_regclass('cron.job') is not null")" = "t" ]; then
    q "select case when jobname is null
                   then format('SELECT cron.schedule(%L, %L);', schedule, command)
                   else format('SELECT cron.schedule(%L, %L, %L);', jobname, schedule, command) end
         from cron.job order by jobid"
  fi
  # The migration ledger. `supabase db dump` leaves the supabase_migrations
  # schema out of both schema.sql and data.sql, so until restore-drill.sh
  # asked for it no backup carried it: a project restored from one had every
  # table and no record of which migration made them, and its first
  # `supabase db push` would try to replay all of them on top. Version and
  # name only -- `statements` is the migration's own SQL, which is in the
  # repo, and would roughly double this file for nothing.
  if [ "$(q "select to_regclass('supabase_migrations.schema_migrations') is not null")" = "t" ]; then
    echo "CREATE SCHEMA IF NOT EXISTS supabase_migrations;"
    echo "CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text NOT NULL PRIMARY KEY, statements text[], name text);"
    q "select format('INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES (%L, %L) ON CONFLICT (version) DO NOTHING;', version, name)
         from supabase_migrations.schema_migrations order by version"
  fi
} > "$out/extension-state.sql"

node "$here/copy-row-counts.mjs" "$out/data.sql" "$out/extension-state.sql" > "$out/counts.json"

for f in roles.sql schema.sql data.sql extension-state.sql counts.json; do
  printf '  %-12s %12s bytes\n' "$f" "$(wc -c < "$out/$f" | tr -d ' ')"
done
