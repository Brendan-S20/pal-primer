#!/usr/bin/env bash
# Installs the Chromium the browser jobs in sandboxes.yml measure with.
#
# Inside mcr.microsoft.com/playwright (the jobs' `container:` on GitHub's
# Linux machine) the browser and every system library it needs are already in
# the image, so this does NOT pass --with-deps and apt never runs. That is the
# point: on 2026-11-11 apt's "Temporary failure resolving archive.ubuntu.com"
# failed both browser jobs on nine PRs and on main before a test had started.
# `playwright install chromium` is then a no-op, because the image tag is
# pinned to the lockfile's Playwright (tests/the-browser-image-is-the-lockfile-
# playwright.test.ts).
#
# Anywhere else -- the Mac, the PC, a self-hosted Linux box -- it is the
# `--with-deps` install the jobs always ran, retried a bounded number of times
# with backoff so a resolver blip is not a red PR. A real failure still fails:
# the last attempt's exit status is the step's.
set -uo pipefail

if [ "${PLAYWRIGHT_BROWSERS_PATH:-}" = "/ms-playwright" ] && [ -d /ms-playwright ]; then
  echo "In the Playwright image (browsers at $PLAYWRIGHT_BROWSERS_PATH): installing with no system deps, so no apt."
  exec npx playwright install chromium
fi

delays=(0 20 60)
status=1
for i in "${!delays[@]}"; do
  if [ "${delays[$i]}" -gt 0 ]; then
    echo "::warning title=Browser install::attempt $i failed (exit $status); retrying in ${delays[$i]}s"
    sleep "${delays[$i]}"
  fi
  npx playwright install --with-deps chromium && exit 0
  status=$?
done
echo "::error title=Browser install::playwright install --with-deps failed ${#delays[@]} times (last exit $status)"
exit "$status"
