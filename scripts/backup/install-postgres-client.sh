#!/usr/bin/env bash
# Install the Postgres client whose major version matches production, from the
# PostgreSQL project's own apt repository (PGDG), on a GitHub-hosted Ubuntu
# runner, and put it first on PATH for the steps after this one.
#
#   scripts/backup/install-postgres-client.sh [major]     # default 17
#
# ubuntu-latest ships Ubuntu's own client, one major behind Supabase. The
# dump itself does not depend on it -- `supabase db dump` runs pg_dump inside
# the Supabase Postgres image -- but psql loads that dump in the drill and
# takes the live counts, and a client older than the server it reads is the
# kind of mismatch that works until the day a new pg_dump emits something the
# old psql does not understand. Matching majors removes the question.

set -euo pipefail

major="${1:-17}"
sudo apt-get install -y -qq postgresql-common >/dev/null
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y >/dev/null
sudo apt-get install -y -qq "postgresql-client-$major" >/dev/null
bin="/usr/lib/postgresql/$major/bin"
[ -x "$bin/psql" ] || { echo "::error::postgresql-client-$major installed no $bin/psql"; exit 1; }
if [ -n "${GITHUB_PATH:-}" ]; then echo "$bin" >> "$GITHUB_PATH"; fi
"$bin/psql" --version
