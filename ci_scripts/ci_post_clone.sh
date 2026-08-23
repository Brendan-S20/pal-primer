#!/bin/sh
#
# Forwarder. The implementation is ios/App/ci_scripts/ci_post_clone.sh.
#
# Apple documents TWO places Xcode Cloud will look for a `ci_scripts`
# directory: the repository root, and the directory containing the Xcode
# project or workspace. This repository's project is at ios/App, so which one
# applies is not something you can settle by reading — and getting it wrong
# costs a full cloud build to discover, because the symptom is the same
# "Could not resolve package dependencies" as having no script at all.
#
# So both exist and one of them is four lines. Only one will ever run: Xcode
# Cloud picks a single location, it does not merge them.
set -e
exec "$(dirname "$0")/../ios/App/ci_scripts/ci_post_clone.sh"
