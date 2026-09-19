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
# ── THE PORT CONSTRAINT, WHICH IS REAL AND NOT YET SOLVED ─────────────────
#
# `supabase/config.toml` puts the local stack on 54421-54427, and CI's
# database job reads the SAME file on the SAME machine. So this cannot run
# while `sandboxes.yml`'s database job is running: both call `supabase start`
# and the second one loses.
#
# That is a genuine limitation rather than an oversight, and the fix is to
# give CI its own port range. It has not been done because changing how CI
# starts its database to suit a local convenience is the wrong way round, and
# the job that needs it is the one that proves migrations replay from nothing.
# Until then: check `gh run list` first, which is what the guard below does.

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
applied=$(psql "$DB_URL" -tAc "select count(*) from supabase_migrations.schema_migrations" 2>/dev/null || echo 0)
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
