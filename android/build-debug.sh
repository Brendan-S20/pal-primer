#!/bin/zsh
# Build the Android debug APK, with the toolchain this repo was built against.
#
# WHY A SCRIPT: neither JAVA_HOME nor ANDROID_HOME is set globally on the
# machine this was developed on, and Gradle's failure when they are missing
# ("Unable to locate a Java Runtime") sends you looking in the wrong place.
# Both live under $HOME — no sudo was needed to install either, which is worth
# knowing before anyone reaches for an installer that wants an admin password.
#
#   JDK 21   brew install openjdk@21          (the FORMULA, not the cask —
#                                              the cask writes to /Library and
#                                              wants sudo; the formula does not)
#   SDK      cmdline-tools unzipped to ~/Library/Android/sdk, then
#            sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"
#
# AGP 8.13 + Gradle 8.14.3 + compileSdk 36 is what android/variables.gradle and
# the wrapper pin, and JDK 21 is what that combination wants. JDK 17 is the
# floor for AGP 8.13; anything older fails before it explains itself.
set -e
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export PATH="$JAVA_HOME/bin:$PATH"

[ -x "$JAVA_HOME/bin/java" ] || { echo "no JDK at $JAVA_HOME — see the header"; exit 1; }
[ -d "$ANDROID_HOME/platforms" ] || { echo "no SDK at $ANDROID_HOME — see the header"; exit 1; }

HERE="${0:A:h}"
# local.properties carries sdk.dir and is gitignored, so it has to be written
# rather than assumed present on a fresh checkout.
printf 'sdk.dir=%s\n' "$ANDROID_HOME" > "$HERE/local.properties"

cd "$HERE"
./gradlew "${@:-assembleDebug}"

echo
echo "APK: $(find "$HERE/app/build/outputs" -name '*.apk' | head -1)"
echo "Merged manifest permissions:"
"$ANDROID_HOME/cmdline-tools/latest/bin/apkanalyzer" manifest permissions \
  "$(find "$HERE/app/build/outputs" -name '*.apk' | head -1)" 2>/dev/null | sed 's/^/  /'
