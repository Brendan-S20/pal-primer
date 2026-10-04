#!/usr/bin/env bash
# Dump the production database the way Supabase documents for a restore into a
# new project: three files, roles / schema / data.
#
#   SUPABASE_DB_URL=postgresql://... scripts/backup/dump.sh <out-dir>
#
# Writes <out-dir>/roles.sql, schema.sql, data.sql and counts.json.
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
# cron.job itself IS kept -- it is configuration, including two jobs that no
# migration schedules (process-email-queue, nightly-automation) -- and
# restore.sh switches every job OFF in the same transaction that loads it.
#
# ── NOTHING HERE PRINTS A ROW OR THE CONNECTION STRING ────────────────────
#
# The CLI echoes only progress lines. --debug would print the connection, so
# it is never passed. The URL goes to the CLI as an argument on a disposable
# hosted VM, which is how ci.yml's live checks already pass it to psql.

set -euo pipefail

out="${1:?usage: dump.sh <out-dir>}"
: "${SUPABASE_DB_URL:?SUPABASE_DB_URL is not set}"
command -v supabase >/dev/null || { echo "::error::the Supabase CLI is not on PATH"; exit 1; }

here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$out"

supabase db dump --db-url "$SUPABASE_DB_URL" -f "$out/roles.sql" --role-only
supabase db dump --db-url "$SUPABASE_DB_URL" -f "$out/schema.sql"
supabase db dump --db-url "$SUPABASE_DB_URL" -f "$out/data.sql" --use-copy --data-only \
  -x "storage.buckets_vectors" \
  -x "storage.vector_indexes" \
  -x "net.http_request_queue" \
  -x "net._http_response" \
  -x "cron.job_run_details"

# A dump that "succeeded" into an empty file is the cheapest failure to catch
# and the most expensive one to discover at restore time.
for f in roles schema data; do
  if [ ! -s "$out/$f.sql" ]; then
    echo "::error::$f.sql is empty -- the dump did not produce anything"
    exit 1
  fi
done
if ! grep -q '^CREATE TABLE IF NOT EXISTS "public"\.' "$out/schema.sql"; then
  echo "::error::schema.sql defines no table in public -- this is not a dump of the app's database"
  exit 1
fi

node "$here/copy-row-counts.mjs" "$out/data.sql" > "$out/counts.json"

for f in roles.sql schema.sql data.sql counts.json; do
  printf '  %-12s %12s bytes\n' "$f" "$(wc -c < "$out/$f" | tr -d ' ')"
done
