#!/bin/zsh
# The guided tour walk, which needs the tour to be UNSEEN and therefore needs
# an invocation of its own.
#
# WHY IT CANNOT JUST BE PART OF THE SUITE: there is exactly one first run.
# reset-tour.sh makes the tour available once, and whichever test launches the
# app first consumes it — every other test dismisses it on purpose, because a
# full-screen modal over the command palette makes them fail in ways that name
# neither a tour nor a palette. Running the whole suite after a reset therefore
# passes the other tests and SKIPS this one, which is the failure mode this
# script exists to prevent.
#
#   ios/UITests/run-tour-test.sh <SIMULATOR_UDID> <email> <password>
set -e
DEVICE="${1:?usage: run-tour-test.sh <udid> <email> <password>}"
HERE="${0:A:h}"
RESULT="${RESULT_BUNDLE:-/tmp/houndstack-qa/tour.xcresult}"

"$HERE/reset-tour.sh" "$DEVICE" "${2:?}" "${3:?}"

rm -rf "$RESULT"
xcodebuild test -project "$HERE/UITests.xcodeproj" -scheme HoundStackUITests \
  -sdk iphonesimulator -destination "platform=iOS Simulator,id=$DEVICE" \
  -derivedDataPath /tmp/hs-uitests -resultBundlePath "$RESULT" \
  -only-testing:HoundStackUITests/TourWalk \
  CODE_SIGNING_ALLOWED=NO

echo
echo "screenshots:  xcrun xcresulttool export attachments --path $RESULT \\"
echo "                --output-path /tmp/tourshots \\"
echo "                --test-id 'TourWalk/testTourWalksThroughTheAppAndStaysDismissed()'"
