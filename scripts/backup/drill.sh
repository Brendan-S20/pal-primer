#!/usr/bin/env bash
# The restore drill: take one encrypted backup and prove it restores.
#
#   BACKUP_PASSPHRASE=... scripts/backup/drill.sh <archive.tar.gz.gpg> [summary.json]
#
# Runs weekly in .github/workflows/backup.yml on a hosted runner, and is the
# same thing a person runs to bring a backup up on a laptop and look at it:
# set KEEP_STACK=1 and the restored database is left running afterwards.
#
#   1. If a summary is given, the archive's sha256 must be the one recorded the
#      night it was made -- the drill restores the file it was handed, intact.
#   2. Decrypt and unpack (crypt.sh open).
#   3. Start a brand-new local Supabase stack from an EMPTY directory -- not
#      this repo's, whose `supabase start` would replay supabase/migrations
#      first and leave nothing for the restore to prove. Auth and storage run,
#      because their services create the auth and storage schemas that
#      data.sql loads rows into; a bare Postgres would refuse auth.users. The
#      Postgres major version is the one production reported in the summary.
#   4. restore.sh: Supabase's documented roles/schema/data restore, one
#      transaction, triggers off, every cron job committed INACTIVE.
#   5. verify-restore.mjs: every table's row count exactly equal to the
#      dump's, organizations and auth.users not empty, every foreign key
#      holding.
#
# ── PORTS ─────────────────────────────────────────────────────────────────
#
# A hosted runner is empty, so the CLI's default 543xx ports are free. On a
# development machine they usually are not (see supabase/config.toml: another
# project's stack holds 543xx here, this repo's holds 544xx, CI's 545xx).
# DRILL_PORT_PREFIX=547 moves the drill's whole stack to 547xx.

set -euo pipefail

archive="${1:?usage: drill.sh <archive.tar.gz.gpg> [summary.json]}"
summary="${2:-}"
here="$(cd "$(dirname "$0")" && pwd)"
prefix="${DRILL_PORT_PREFIX:-543}"
work="${DRILL_WORKDIR:-$(mktemp -d)}"
opened="$work/opened"
# The CLI names every container and volume after this directory. Its own name
# for the self-test (scripts/restore-drill-selftest.sh), so a self-test on a
# machine where a person is mid-drill cannot stop their stack.
stackdir="$work/${DRILL_PROJECT_ID:-houndstack-restore-drill}"

for tool in supabase psql gpg node docker; do
  command -v "$tool" >/dev/null || { echo "::error::$tool is not on PATH"; exit 1; }
done

json() { node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const v=process.argv[2].split(".").reduce((o,k)=>o?.[k],s); console.log(v ?? "")' "$1" "$2"; }

if [ -n "$summary" ]; then
  want="$(json "$summary" archive.sha256)"
  if command -v sha256sum >/dev/null; then got="$(sha256sum "$archive" | cut -d' ' -f1)"; else got="$(shasum -a 256 "$archive" | cut -d' ' -f1)"; fi
  if [ "$want" != "$got" ]; then
    echo "::error::the archive's sha256 is not the one recorded when it was made -- damaged in storage, or not the same file"
    exit 1
  fi
  echo "archive sha256 matches the summary"
fi

mkdir -p "$stackdir"
cleanup() {
  if [ "${KEEP_STACK:-}" = "1" ]; then
    echo "KEEP_STACK=1: the restored stack is still running. Stop it with:"
    echo "  (cd '$stackdir' && supabase stop --no-backup)"
    echo "and delete the decrypted dump, which is every customer's data in plaintext:"
    echo "  rm -rf '$opened'"
    return
  fi
  (cd "$stackdir" && supabase stop --no-backup >/dev/null 2>&1) || true
  # The opened dump is plaintext customer data. Do not leave it in a temp dir.
  rm -rf "$opened"
}
trap cleanup EXIT

"$here/crypt.sh" open "$archive" "$opened"

major=17
if [ -n "$summary" ]; then
  v="$(json "$summary" server_version_num)"
  if [ -n "$v" ]; then major=$(( v / 10000 )); fi
fi

cd "$stackdir"
supabase init --force >/dev/null
node - "$prefix" "$major" <<'EOF'
const fs = require("node:fs");
const [prefix, major] = process.argv.slice(2);
const path = "supabase/config.toml";
let s = fs.readFileSync(path, "utf8");
let ports = 0;
s = s.replace(/\b543(\d\d)\b/g, (_, d) => { ports += 1; return `${prefix}${d}`; });
if (!/^major_version = \d+$/m.test(s)) {
  console.error("::error::config.toml from `supabase init` has no major_version line to set; update drill.sh");
  process.exit(1);
}
s = s.replace(/^major_version = \d+$/m, `major_version = ${major}`);
if (ports === 0) {
  console.error("::error::config.toml from `supabase init` no longer uses 543xx ports; update drill.sh");
  process.exit(1);
}
fs.writeFileSync(path, s);
console.log(`drill stack: ports ${prefix}xx, Postgres ${major}`);
EOF

# Only what a restore needs: Postgres, plus the auth and storage services
# whose own migrations create the schemas data.sql writes into. Kong stays
# because the storage service is reached and health-checked through it.
# Started twice at most: a first start on a cold machine can time out on a
# health check while the images are still being unpacked.
# Its banner prints the throwaway stack's keys. They are the CLI's local
# defaults, but a log that prints anything shaped like a key teaches people
# to skim past one, so those lines are dropped.
exclude=realtime,imgproxy,mailpit,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor
# grep, not sed's I flag, which macOS sed does not have; `|| true` because
# grep -v exits 1 when it drops every line, and pipefail would read that as a
# stack that did not start.
start_stack() { supabase start -x "$exclude" 2>&1 | { grep -viE 'key|secret|jwt|token|password' || true; }; }
if ! start_stack; then
  echo "::warning::the drill stack did not come up first time; stopping it and trying once more"
  supabase stop --no-backup >/dev/null 2>&1 || true
  sleep 10
  start_stack
fi

db_url="$(supabase status -o env 2>/dev/null | sed -n 's/^DB_URL="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p')"
[ -n "$db_url" ] || { echo "::error::supabase status reported no DB_URL"; exit 1; }
cd - >/dev/null

# The stack was started on this machine a moment ago, so this cannot fail
# today. It is here so that no later edit -- a DB_URL read from somewhere
# else -- can send decrypted customer data to a
# database off this machine without the drill stopping first.
# The output, not just the exit code: a guard that never ran exits 0 too.
if [ "$(RESTORE_TARGET_URL="$db_url" node "$here/local-only.mjs")" != "local" ]; then
  echo "::error::the drill stack's database is not on this machine; refusing to restore into it"
  exit 1
fi

"$here/restore.sh" "$opened" "$db_url"
node "$here/verify-restore.mjs" "$opened" "$db_url" ${summary:+"$summary"}
