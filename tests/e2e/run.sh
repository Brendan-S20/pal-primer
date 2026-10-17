#!/usr/bin/env bash
# Bring up everything these tests need, seed it, and run them.
#
# ── WHY A SCRIPT AND NOT A README LINE ────────────────────────────────────
#
# Five things have to line up: a local Supabase, all 325 migrations, a seeded
# tenant, a dev server holding the LOCAL credentials, and Playwright pointed
# at that server. Getting any one wrong produces a failure that reads like a
# broken app -- an empty page, an invalid login, twenty identical timeouts --
# so the sequence is written down once and run rather than remembered.
#
# ── THE PORT CONSTRAINT, SOLVED ON 2026-09-19 ─────────────────────────────
#
# `supabase/config.toml` puts the local stack on 54421-54427, and CI's
# database job used to read the SAME file on the SAME machine, so this could
# not run while `sandboxes.yml`'s database job was running: both called
# `supabase start` and the second one lost.
#
# CI now patches ITS checkout of config.toml onto 54521-54527 with its own
# project_id ("<id>-ci") — see the "Give this job its own Supabase ports"
# step in sandboxes.yml. Distinct project_id, not just distinct ports,
# because the CLI names every container, volume and network after it: two
# stacks with one id are one stack. This file needed no change for that; it
# reads `supabase status`, which reports whatever the config in THIS
# directory says, and this directory keeps 54421-54427.

set -euo pipefail
cd "$(dirname "$0")/../.."

echo "── 1/4  local Supabase ────────────────────────────────────────────────"
if ! supabase status >/dev/null 2>&1; then
  echo "     starting (this replays 325 migrations; a few minutes on a cold cache)"
  supabase start
else
  echo "     already up"
fi

# `-o env` gives API_URL, ANON_KEY, SERVICE_ROLE_KEY and DB_URL. Read them
# rather than hardcoding: the keys are regenerated whenever the stack is.
eval "$(supabase status -o env | sed 's/^/export /')"
export SUPABASE_URL="$API_URL"
export SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY"
export SUPABASE_PUBLISHABLE_KEY="$ANON_KEY"

echo "── 2/4  migrations ────────────────────────────────────────────────────"
count_sql="select count(*) from supabase_migrations.schema_migrations"
if command -v psql >/dev/null 2>&1; then
  applied=$(psql "$DB_URL" -tAc "$count_sql" 2>/dev/null || echo 0)
else
  # No psql on the runner (the Windows PC): ask the stack's own database container.
  db_container=$(docker ps --format '{{.Names}}' | grep -E '^supabase_db_' | head -1)
  applied=$(docker exec "$db_container" psql -U postgres -d postgres -tAc "$count_sql" 2>/dev/null || echo 0)
fi
echo "     $applied in the ledger"
if [ "$applied" -lt 300 ]; then
  echo "     that is too few. Run 'supabase db reset' and try again." >&2
  exit 1
fi

echo "── 3/4  seed ──────────────────────────────────────────────────────────"
# Prints the row counts it produced. A seed that silently makes an empty org
# presents downstream as a dozen unrelated UI failures, so it is asked to
# prove itself here rather than in a test.
node tests/e2e/seed.mjs

echo "── 4/4  browser ───────────────────────────────────────────────────────"
# No E2E_BASE_URL, so the Playwright config starts its own dev server with the
# local credentials in its environment and shuts it down afterwards.
exec npx playwright test --config playwright.e2e.config.ts "$@"
