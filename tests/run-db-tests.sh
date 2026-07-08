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

exec bun x vitest run tests/integration/leaks.db.test.ts "$@"
