#!/bin/sh
#
# Xcode Cloud: install the JS dependencies and build the web bundle, BEFORE
# Xcode tries to resolve Swift packages.
#
# ── THE FAILURE THIS FIXES ────────────────────────────────────────────────
#
# Xcode Cloud clones the repository and goes straight to "Resolve package
# dependencies", which fails:
#
#     the package at '/Volumes/workspace/repository/node_modules/@capacitor/
#     splash-screen' cannot be accessed (... doesn't exist in file system)
#     ... and nine more
#     xcodebuild: error: Could not resolve package dependencies
#     Command exited with non-zero exit-code: 74
#
# Nothing is wrong with the project. Capacitor references every plugin as a
# LOCAL Swift package — see ios/App/CapApp-SPM/Package.swift, which is a list
# of `path: "../../../node_modules/@capacitor/…"` — and a fresh clone has no
# node_modules. Xcode Cloud never runs `npm ci` on its own, so the paths those
# packages live at do not exist yet. `ci_post_clone.sh` is the only hook that
# runs early enough to create them.
#
# ── AND THE SECOND HALF, WHICH IS EASY TO MISS ────────────────────────────
#
# `ios/App/App/public` is gitignored (ios/.gitignore), because it is a COPY of
# the web build that `cap sync` regenerates. So a cloud checkout has no web
# assets at all. Without the build+sync below the archive still succeeds — and
# ships a native shell wrapped around nothing, which is a worse failure than
# the one above because it does not fail.
#
# ── WHERE THIS FILE LIVES ─────────────────────────────────────────────────
#
# Next to App.xcodeproj, which is where Xcode Cloud looks for `ci_scripts` when
# the project is not at the repository root. A forwarder at the repo root
# covers the other documented location; see ci_scripts/ci_post_clone.sh there.
# Whichever one Xcode Cloud finds, this is the implementation that runs.

set -e

echo "--- ci_post_clone: preparing the JS side of the build"

# Xcode Cloud sets this to the checkout. Fall back to walking up from here so
# the script is also runnable by hand.
REPO="${CI_PRIMARY_REPOSITORY_PATH:-$(cd "$(dirname "$0")/../../.." && pwd)}"
echo "repository: $REPO"

if ! command -v node >/dev/null 2>&1; then
  echo "--- node not on PATH, installing"
  # Pinned to the major CI uses (.github/workflows/ci.yml sets node-version 22)
  # so the cloud build and the gate agree. node@22 is keg-only, hence the PATH.
  export HOMEBREW_NO_AUTO_UPDATE=1
  brew install node@22
  export PATH="$(brew --prefix node@22)/bin:$PATH"
fi
echo "node $(node --version), npm $(npm --version)"

cd "$REPO"

echo "--- npm ci (this is what the Swift packages are waiting for)"
npm ci

echo "--- build:native (NATIVE_BUILD=1, SPA prerender, dist-native/client)"
npm run build:native

echo "--- cap sync ios (copies the bundle into App/App/public + writes capacitor.config.json)"
npx cap sync ios

# Fail loudly here rather than shipping an empty shell. An archive with no
# index.html launches to a white screen and passes every build check.
if [ ! -f "$REPO/ios/App/App/public/index.html" ]; then
  echo "::error::cap sync produced no ios/App/App/public/index.html — the archive would ship an empty WebView"
  exit 1
fi
echo "--- web bundle present: $(find "$REPO/ios/App/App/public" -type f | wc -l | tr -d ' ') files"

echo "--- ci_post_clone: done"
