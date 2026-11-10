#!/usr/bin/env bash
# The restore drill, proved end to end on data that belongs to nobody.
#
#   supabase start                       # this checkout's stack, from the migrations
#   scripts/restore-drill-selftest.sh
#
# 1. Seeds the local stack with one made-up business
#    (scripts/backup/restore-drill-seed.sql: every address on .invalid).
# 2. Backs it up with the SAME commands .github/workflows/backup.yml runs --
#    crypt.sh check, dump.sh, crypt.sh seal, summarize.mjs -- under a
#    passphrase generated for this run and thrown away with it.
# 3. Runs scripts/restore-drill.sh on that archive and summary.
#
# Safe on any machine, a CI runner included, because nothing in it is
# anyone's data. It refuses a stack that is not on this machine before it
# seeds, because seed_demo_org deletes rows before it writes. It never reads
# BACKUP_PASSPHRASE from the caller's environment: a real passphrase has no
# business in a self-test, so it is overwritten.

set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
for tool in supabase psql gpg node docker openssl; do
  command -v "$tool" >/dev/null || { echo "::error::$tool is not on PATH"; exit 1; }
done

db_url="${SELFTEST_DB_URL:-$(supabase status -o env 2>/dev/null | sed -n 's/^DB_URL="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p')}"
[ -n "$db_url" ] || { echo "::error::no local stack: run 'supabase start' in this checkout first"; exit 1; }
RESTORE_TARGET_URL="$db_url" node scripts/backup/local-only.mjs >/dev/null

work="$(mktemp -d "${TMPDIR:-/tmp}/restore-drill-selftest.XXXXXX")"
trap 'rm -rf "$work"' EXIT

started=$(date +%s)
echo "── seed (made-up data only)"
psql "$db_url" -X -q -v ON_ERROR_STOP=1 -f scripts/backup/restore-drill-seed.sql >/dev/null

echo "── back up, exactly as backup.yml does"
BACKUP_PASSPHRASE="$(openssl rand -base64 32)"
export BACKUP_PASSPHRASE
export SUPABASE_DB_URL="$db_url"
name="houndstack-db-selftest-$(date -u +%Y%m%dT%H%M%SZ).tar.gz.gpg"
scripts/backup/crypt.sh check
scripts/backup/dump.sh "$work/dump"
scripts/backup/crypt.sh seal "$work/dump" "$work/$name"
SUPABASE_CLI_VERSION="$(supabase --version | head -1)" \
  node scripts/backup/summarize.mjs "$work/dump" "$work/$name" "$work/summary.json" >/dev/null
rm -rf "$work/dump"
unset SUPABASE_DB_URL
backup_s=$(( $(date +%s) - started ))
echo "backup made in ${backup_s}s"

echo "── drill"
BACKUP_ARCHIVE="$work/$name" BACKUP_SUMMARY="$work/summary.json" \
DRILL_PROJECT_ID=houndstack-restore-drill-selftest \
  scripts/restore-drill.sh

echo "self-test: seed + backup ${backup_s}s, total $(( $(date +%s) - started ))s"
