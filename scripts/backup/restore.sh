#!/usr/bin/env bash
# Load an opened backup (roles.sql, schema.sql, data.sql) into an EMPTY
# Supabase database, in one transaction.
#
#   scripts/backup/restore.sh <opened-dir> <target-db-url>
#
# The target is either a brand-new Supabase project (its session-pooler
# connection string) or a local stack started from an empty directory -- see
# docs/backups-and-restore.md. NEVER the production project: this script
# creates tables that already exist there, and is not a way to merge rows into
# a live database. One tenant's rows go back by the procedure in the doc.
#
# ── WHAT IT DOES BEYOND SUPABASE'S DOCUMENTED COMMAND ─────────────────────
#
# The core is Supabase's own restore line: roles, schema, then data with
# `session_replication_role = replica` so no trigger fires while rows land --
# no "visit completed" webhook, no invoice email, no audit row stamped with
# today's date for a payment taken last month.
#
# Then, IN THE SAME TRANSACTION, every restored pg_cron job is switched OFF.
# cron.job is in the backup because two of its jobs exist in no migration,
# but each of them POSTs to the production app or calls deliver_webhooks(),
# which POSTs to customers' own endpoints. A restored database with those
# jobs live starts doing production's work within a minute: nightly
# automation run twice, webhooks delivered twice to customers from a database
# nobody meant to be live. pg_cron only ever sees committed rows, so jobs that
# commit inactive never run once. Turning them back on is a deliberate step
# for whoever is cutting over -- `update cron.job set active = true` -- and
# only once the old project is no longer running them.
#
# ── ERRORS ARE PRINTED WITHOUT CUSTOMER DATA ──────────────────────────────
#
# psql's default error report for a failed COPY quotes the offending ROW back
# ("CONTEXT: COPY clients, line 41: ..."), and this runs in CI, where logs are
# kept and readable by every collaborator. So psql runs with VERBOSITY=terse
# (no DETAIL, no CONTEXT), its stderr goes to a file, and only the primary
# message is printed -- with anything in quotes masked when the error came
# from data.sql, and the TABLE worked out from the line number instead. The
# schema and roles files hold no customer data, and their errors are printed
# as they are, because there the quoted name is the useful part.

set -euo pipefail

dir="${1:?usage: restore.sh <opened-dir> <target-db-url>}"
url="${2:?usage: restore.sh <opened-dir> <target-db-url>}"
for f in roles.sql schema.sql data.sql; do
  [ -s "$dir/$f" ] || { echo "::error::$dir/$f is missing or empty"; exit 1; }
done
command -v psql >/dev/null || { echo "::error::psql is not on PATH"; exit 1; }

here="$(cd "$(dirname "$0")" && pwd)"
err="$(mktemp)"
trap 'rm -f "$err"' EXIT

mask() { sed -E "s/\"[^\"]*\"/\"...\"/g; s/'[^']*'/'...'/g"; }

# Refuse a target that already holds this app. A restore is into an EMPTY
# database; one that already has public.organizations is either production or
# a previous restore, and loading on top of either is a mistake whose cleanup
# is worse than the error.
existing="$(psql "$url" -X -At -c "select to_regclass('public.organizations') is not null" 2>/dev/null || true)"
if [ -z "$existing" ]; then
  echo "::error::could not connect to the target database"
  exit 1
fi
if [ "$existing" = "t" ]; then
  echo "::error::the target database already has public.organizations -- refusing to restore on top of it."
  echo "  Restore into a NEW project, or a local stack started from an empty directory."
  exit 1
fi

started=$(date +%s)
set +e
psql "$url" -X -q \
  --single-transaction \
  -v ON_ERROR_STOP=1 \
  -v VERBOSITY=terse \
  --file "$dir/roles.sql" \
  --file "$dir/schema.sql" \
  --command 'SET session_replication_role = replica' \
  --file "$dir/data.sql" \
  --file "$here/disable-restored-cron-jobs.sql" \
  >/dev/null 2>"$err"
code=$?
set -e

if [ "$code" -ne 0 ]; then
  echo "::error::the restore was refused and rolled back as a whole (psql exit $code). Nothing was left half-loaded."
  while IFS= read -r line; do
    if [[ "$line" =~ ^psql:(.*):([0-9]+):\ (.*)$ ]]; then
      file="${BASH_REMATCH[1]}"; n="${BASH_REMATCH[2]}"; msg="${BASH_REMATCH[3]}"
      if [[ "$(basename "$file")" == data.sql ]]; then
        table="$(awk -v L="$n" 'NR > L { exit } /^COPY "/ { t = $2 } /^\\\.$/ { t = "" } END { print t }' "$dir/data.sql")"
        echo "  data.sql line $n${table:+ (in the COPY block for $table)}: $(printf '%s' "$msg" | mask)"
      else
        echo "  $(basename "$file") line $n: $msg"
      fi
    elif [[ "$line" =~ ^(NOTICE|WARNING): ]]; then
      continue
    else
      # Anything else psql said, masked the same way: it cannot be traced to
      # a file, so it cannot be shown to be free of a value.
      echo "  $(printf '%s' "$line" | mask)"
    fi
  done < "$err"
  exit 1
fi

echo "restored in $(( $(date +%s) - started ))s"
psql "$url" -X -At -c "select 'cron jobs restored: ' || count(*) || ', active: ' || count(*) filter (where active) from cron.job" 2>/dev/null \
  || echo "no cron schema in the target (nothing was scheduled in the backup)"
