#!/usr/bin/env bash
# Run the DB-layer leak tests against the LOCAL Supabase stack.
# Prereq: `supabase start` (Docker) with all migrations applied
# (`supabase db reset` re-applies from scratch).
set -euo pipefail
cd "$(dirname "$0")/.."

eval "$(supabase status -o env 2>/dev/null | grep -E '^(API_URL|ANON_KEY|SERVICE_ROLE_KEY)=')"

export TEST_SUPABASE_URL="${API_URL:?supabase stack not running — run 'supabase start'}"
export TEST_SUPABASE_ANON_KEY="${ANON_KEY:?}"
export TEST_SUPABASE_SERVICE_KEY="${SERVICE_ROLE_KEY:?}"

# bun when it is there, npx otherwise. CI installs node and npm and nothing
# else, so hardcoding bun meant this script could only ever run on a laptop
# that happened to have it — which is a large part of why these three files had
# never run in CI at all.
RUNNER=(npx vitest)
command -v bun >/dev/null 2>&1 && RUNNER=(bun x vitest)

exec "${RUNNER[@]}" run tests/integration/leaks.db.test.ts tests/integration/portal-auth.db.test.ts tests/integration/portal-email.db.test.ts "$@"
