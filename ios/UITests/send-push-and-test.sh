#!/bin/zsh
# Runs the push deep-link UI test.
#
# The push cannot simply be sent first: a banner lives about five seconds and
# `xcodebuild test-without-building` takes considerably longer than that to spin
# up. So the test backgrounds the app and waits up to 90s for a banner, while
# this script sends one every 8 seconds until the test finishes.
#
#   ios/UITests/send-push-and-test.sh <SIMULATOR_NAME_OR_UDID> [payload.json]
set -e
DEVICE="${1:?usage: send-push-and-test.sh <device> [payload.json]}"
PAYLOAD="${2:-$(dirname "$0")/push-my-day.json}"
BUNDLE=consulting.thenorth.houndstack
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

xcodebuild test-without-building \
  -project "$ROOT/ios/UITests/UITests.xcodeproj" -scheme HoundStackUITests \
  -destination "platform=iOS Simulator,name=$DEVICE" \
  -derivedDataPath "${DERIVED_DATA:-/tmp/houndstack-qa/UITestsDD}" \
  -resultBundlePath "${RESULT_BUNDLE:-/tmp/houndstack-qa/push.xcresult}" \
  -only-testing:HoundStackUITests/HoundStackUITests/testTappingAPushNotificationLandsOnItsDeepLink \
  CODE_SIGNING_ALLOWED=NO &
TEST_PID=$!

# Give the test time to launch the app, background it, and start watching.
sleep 30
for _ in 1 2 3 4 5 6 7 8; do
  kill -0 $TEST_PID 2>/dev/null || break
  xcrun simctl push "$DEVICE" "$BUNDLE" "$PAYLOAD" >/dev/null 2>&1 || true
  sleep 8
done
wait $TEST_PID
