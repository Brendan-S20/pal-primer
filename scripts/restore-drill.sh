#!/usr/bin/env bash
# The restore drill: prove one encrypted backup brings the database back,
# into a throwaway local database.
#
#   BACKUP_ARCHIVE=~/Downloads/houndstack-db-<stamp>.tar.gz.gpg \
#   BACKUP_SUMMARY=~/Downloads/summary.json \          (optional, recommended)
#     scripts/restore-drill.sh
#
# BACKUP_PASSPHRASE is read from the environment if it is set, and asked for
# at the terminal by gpg if it is not -- the better way, because then it is
# never in shell history or in an environment a child process can read. It
# is never echoed, logged or passed on a command line.
#
# docs/runbooks/restore-drill.md is the runbook: who runs this, where, and
# how to record the result on #720.
#
# ── WHAT IT DOES ──────────────────────────────────────────────────────────
#
#   1. Refuses to run where it should not: no archive, or a DOCKER_HOST that
#      is not this machine. The restored database's URL must be loopback
#      (scripts/backup/local-only.mjs), checked in drill.sh BEFORE anything
#      is loaded into it and again here before the checks connect.
#   2. scripts/backup/drill.sh, with a random 5xxxx port range: sha256
#      against the summary, decrypt, a fresh Supabase stack from an EMPTY
#      directory, the documented roles/schema/data restore in one
#      transaction with every cron job committed INACTIVE, then every
#      table's row count against the dump's own and every foreign key.
#   3. scripts/backup/restore-drill-checks.mjs on the restored database:
#      tables vs the migrations, key-table row counts, RLS on every public
#      table, the auth schema, and the newest version in the migration
#      ledger.
#   4. Stops the stack and deletes the decrypted dump, pass or fail.
#
# Prints counts, table names and PASS/FAIL. Never a row, never the
# passphrase, never a connection string.
#
# ── WHERE IT RUNS ─────────────────────────────────────────────────────────
#
# Weekly in .github/workflows/restore-drill.yml, on a GitHub-hosted runner
# whose disk is destroyed when the job ends (the owner's decision,
# 2026-11-10). By hand on a private machine you control as the fallback.
# Never on a self-hosted runner or a shared machine: a production backup is
# every customer's data, decrypted on that disk for a few minutes. Its
# self-test (scripts/restore-drill-selftest.sh) makes a backup of local seed
# data and drills that, and is safe anywhere.

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
started=$(date +%s)

fail() { echo "RESTORE DRILL: FAIL -- $1"; exit 1; }

archive="${BACKUP_ARCHIVE:-}"
summary="${BACKUP_SUMMARY:-}"
[ -n "$archive" ] || fail "BACKUP_ARCHIVE is not set (the path to a .tar.gz.gpg backup)"
[ -f "$archive" ] || fail "BACKUP_ARCHIVE does not name a file"
if [ -n "$summary" ] && [ ! -f "$summary" ]; then fail "BACKUP_SUMMARY does not name a file"; fi

# The stack runs in Docker. A DOCKER_HOST pointing at another machine would
# put the decrypted database there, while every URL still says 127.0.0.1.
case "${DOCKER_HOST:-}" in
  ""|unix://*|npipe://*) ;;
  *) fail "DOCKER_HOST points at another machine; the drill only runs on this one" ;;
esac

# libpq reads these when a URL leaves something out; none of them should be
# able to steer a psql call in here anywhere.
unset PGHOST PGHOSTADDR PGSERVICE PGSERVICEFILE PGPASSFILE

# A caller may name the target port range; otherwise pick a free one at
# random so the drill never lands on a stack this machine is already running
# (543xx other projects, 544xx this repo, 545xx CI, 547xx drill.sh's own
# documented choice).
port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
prefix="${DRILL_PORT_PREFIX:-}"
if [ -z "$prefix" ]; then
  for _ in $(seq 1 40); do
    candidate=$(( 550 + RANDOM % 100 ))
    ok=1
    for d in 20 21 22 23 24 25 26 27 28 29; do port_free "$candidate$d" || { ok=0; break; }; done
    if [ "$ok" = 1 ]; then prefix=$candidate; break; fi
  done
  [ -n "$prefix" ] || fail "no free port range found between 55000 and 64999"
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/restore-drill.XXXXXX")"
project="${DRILL_PROJECT_ID:-houndstack-restore-drill}"
stackdir="$work/$project"
cleanup() {
  (cd "$stackdir" 2>/dev/null && supabase stop --no-backup >/dev/null 2>&1) || true
  # The opened dump is every customer's data in plaintext.
  rm -rf "$work"
}
trap cleanup EXIT

echo "restore drill: archive $(basename "$archive"), ports ${prefix}xx, project $project"

# KEEP_STACK=1 so drill.sh leaves the restored database up for step 3; the
# trap above takes it down whatever happens.
if ! KEEP_STACK=1 DRILL_PORT_PREFIX="$prefix" DRILL_WORKDIR="$work" DRILL_PROJECT_ID="$project" \
     "$here/backup/drill.sh" "$archive" ${summary:+"$summary"} 2>&1 \
     | { grep -vE "KEEP_STACK=1|supabase stop --no-backup|rm -rf|every customer's data in plaintext" || true; }; then
  fail "the restore or its row-count check did not pass (see above)"
fi

db_url="$(cd "$stackdir" && supabase status -o env 2>/dev/null | sed -n 's/^DB_URL="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p')"
[ -n "$db_url" ] || fail "the restored stack reported no DB_URL"
# Its output is required, not just its exit code: a guard that never ran
# exits 0 too.
[ "$(RESTORE_TARGET_URL="$db_url" node "$here/backup/local-only.mjs")" = "local" ] \
  || fail "the restored database is not on this machine"

echo
echo "checks on the restored database:"
if ! RESTORE_TARGET_URL="$db_url" node "$here/backup/restore-drill-checks.mjs" | tee "$work/checks.log"; then
  fail "one or more checks above failed ($(( $(date +%s) - started ))s)"
fi
# Five checks, each named, or it is not a pass: a checks script that exited
# 0 without running (see local-only.mjs on symlinks) must not read as PASS.
if [ "$(tail -1 "$work/checks.log")" != "all restore drill checks passed: 5" ]; then
  fail "the checks did not report all five passing"
fi

echo
echo "RESTORE DRILL: PASS in $(( $(date +%s) - started ))s"
