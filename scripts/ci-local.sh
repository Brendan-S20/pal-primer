#!/usr/bin/env bash
# Run what CI runs, here, before pushing.
#
# ── WHY THIS EXISTS ───────────────────────────────────────────────────────
#
# Two reasons, and the second is the one that bites.
#
# GitHub Actions minutes are finite, and this repo spends them generously: a
# push to a PR branch runs two jobs, and the merge to main runs them again.
# Most of that is verifying something already verifiable on the machine the
# code was written on.
#
# And the local habit had drifted from the workflow without anyone noticing.
# `tsc`, `vitest` and the dead-machinery check were being run by hand before
# every push; `npm run build` was not. That is exactly the step that catches
# what `tsc --noEmit` cannot — a Vite plugin misconfiguration, an SSR-only
# import pulled into a client file, a failed Nitro preset — and it is also
# the only thing that runs scripts/check-pwa-output.mjs, which exists because
# /sw.js 404'd in production for the entire life of the PWA. A local routine
# that silently omits a gate is worse than no routine, because it feels like
# coverage.
#
# So this file is the list, in the workflow's own order, with nothing left to
# memory.
#
# ── WHAT IT DOES NOT COVER ────────────────────────────────────────────────
#
# The `migrations` job talks to the live database. Its three schema checks
# each take an offline capture instead of a connection — `--applied-from`,
# `--live-from`, `--catalog-from` — but producing those captures needs
# database access this script does not assume. Run them from an MCP session
# (see MIGRATION CHECKS below) or let the main-push CI run be the gate.
#
# That split is deliberate and matches the workflow: on a pull request every
# migration step is `continue-on-error`, because a PR legitimately contains
# migrations that have not been applied yet. They are a hard gate only on
# main. So this script covering the `verify` job in full covers everything a
# PR run can actually fail on.
#
# Usage:  bash scripts/ci-local.sh          (fails on the first hard gate)
#         bash scripts/ci-local.sh --quick  (skips the build; not a pre-push run)

set -uo pipefail
cd "$(dirname "$0")/.."

QUICK=0
[ "${1:-}" = "--quick" ] && QUICK=1

fail=0
step() {
  printf '\n\033[1m── %s\033[0m\n' "$1"
}
report() {
  if [ "$1" -eq 0 ]; then
    printf '\033[32m✓ %s\033[0m\n' "$2"
  else
    printf '\033[31m✗ %s\033[0m\n' "$2"
    fail=1
  fi
}

step "Typecheck"
npx tsc --noEmit
report $? "tsc --noEmit"

step "Tests"
npm test
report $? "vitest run"

if [ "$QUICK" -eq 0 ]; then
  step "Build (and verify the service worker is real)"
  # The gate that was being skipped. ~40s, and the only one that runs
  # check-pwa-output.mjs against real build output.
  npm run build
  report $? "vite build + check-pwa-output"
else
  printf '\n\033[33m! build skipped (--quick) — do not push on this\033[0m\n'
fi

step "Dead machinery"
npm run check:dead-machinery
report $? "check-dead-machinery"

step "App origin answers the native preflight"
# No database needed — it asks the live edge. The workflow runs this in the
# migrations job, but it belongs to neither: it is a question only the
# deployed host can answer.
#
# WARNING, not a gate, and the difference matters. This is the one check here
# whose verdict depends on the machine it runs from: it uses `fetch`, and
# Node does not route fetch through HTTPS_PROXY, so behind a proxying sandbox
# it can report a failure the live host is not having. Measured: this printed
# "the preflight answered 403" while the identical request via curl answered
# 204. A local gate that cries wolf about production teaches people to ignore
# it, so it warns and hands over the command that settles it.
if node scripts/check-app-origin.mjs; then
  report 0 "check-app-origin"
else
  printf '\033[33m! check-app-origin failed — CONFIRM before believing it:\033[0m\n'
  printf '    curl -s -o /dev/null -w "%%{http_code}\\n" -X OPTIONS \\\n'
  printf '      https://app.houndstack.com/_serverFn/getMyDay \\\n'
  printf '      -H "Origin: capacitor://localhost" -H "Access-Control-Request-Method: POST"\n'
  printf '  A 2xx there means the host is fine and this run was the environment.\n'
fi

step "Auth hooks point at a host that exists"
# #764: the Supabase Auth Send Email hook pointed at www.app.houndstack.com
# for three months after that host stopped resolving, and every password
# reset died as 422 hook_timeout_after_retry. The URI is a remote Auth
# setting; this checks the value it is told (AUTH_HOOK_URIS /
# AUTH_SEND_EMAIL_HOOK_URI, default the app origin's /email/auth/webhook).
# Warning, not a gate, for the same reason as the origin check above: its
# verdict depends on this machine's DNS and network.
if node scripts/check-auth-hook-hosts.mjs; then
  report 0 "check-auth-hook-hosts"
else
  printf '\033[33m! check-auth-hook-hosts failed — confirm with: dig +short <host>, then\n'
  printf '    curl -s -o /dev/null -w "%%{http_code}\\n" -X POST <hook uri>   (401 = alive)\033[0m\n'
fi

# ── Lint is opt-in, and that is not laziness ──────────────────────────────
#
# `eslint .` over this repo takes minutes — measured, not guessed: the first
# version of this script ran it unconditionally and had to be killed after
# seven. CI can afford that because the step is `continue-on-error` and
# nobody is watching; a pre-push gate that takes seven minutes is a gate
# people stop running, which costs more than the lint finds.
#
# The rule this repo actually holds itself to is not "zero problems" — there
# is real pre-existing drift — it is that a touched file must not GROW its
# count. That is a per-file comparison against the base, not a whole-repo
# sweep, so the whole-repo run answers a question nobody asked.
if [ "${RUN_LINT:-0}" = "1" ]; then
  step "Lint (non-blocking, as in CI)"
  npx eslint . 2>&1 | tail -3
else
  step "Lint"
  printf '\033[33m! skipped — takes minutes. RUN_LINT=1 to include it.\033[0m\n'
  printf '  The rule is per-file and comparative. For each file you touched:\n'
  printf "    npx eslint \"<abs path>\" 2>&1 | grep -cE '^[[:space:]]+[0-9]+:[0-9]+'\n"
  printf '  before (git stash push -u -- src/) and after. It must not grow.\n'
fi

printf '\n'
if [ "$fail" -eq 0 ]; then
  printf '\033[32m✓ everything the CI verify job would run has passed here.\033[0m\n'
  printf '  Not covered: the three live-database schema checks. See MIGRATION CHECKS in this file.\n'
else
  printf '\033[31m✗ at least one gate failed — do not push.\033[0m\n'
fi
exit $fail

# ── MIGRATION CHECKS ──────────────────────────────────────────────────────
#
# Each takes a captured snapshot instead of a connection, so they can be run
# from a session that has MCP database access but no SUPABASE_DB_URL:
#
#   node scripts/check-migrations.mjs      --applied-from applied.json
#   node scripts/check-schema-declared.mjs --live-from    live.json
#   node scripts/check-baseline-objects.mjs --catalog-from catalog.json
#
# `applied.json` is a JSON array of the names in
# supabase_migrations.schema_migrations, newest last:
#
#   select coalesce(name, version) from supabase_migrations.schema_migrations
#    order by version;
#
# A cheaper equivalent when you only want a yes/no and not the whole list:
# normalise both sides (lower-case, strip `-` and `_`, which is what
# check-migrations.mjs does) and ask the database which repo names are
# absent. That answers the same question in one small round trip.
