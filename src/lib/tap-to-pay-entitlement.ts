// Was THIS app binary signed with Tap to Pay on iPhone? (#579, #757)
//
// Apple granted com.apple.developer.proximity-reader.payment.acceptance to
// HoundStack for DEVELOPMENT only (case 23404969). A distribution provisioning
// profile cannot carry it, so the Release configuration signs with
// ios/App/App/App.Release.entitlements, which leaves it out, and the Xcode
// Cloud archive exports again. Debug still signs with App.entitlements and
// keeps Tap to Pay.
//
// The web bundle is the same in both, so it cannot know at build time which
// one it is inside. HSBridgeViewController.swift tells it, before any page
// script runs, from the HS_TAP_TO_PAY_ENTITLED build setting (Info.plist key
// HSTapToPayEntitled): `window.__HS_TAP_TO_PAY_ENTITLED__ = true | false`.
//
// On iOS an absent flag means "no": an older binary, or a Release build, must
// not draw a button whose first SDK call fails for want of the entitlement.
// Android has no entitlement of this kind, so it is unaffected.
//
// Deliberately its own file, so tap-to-pay.ts (and #841's rework of it) stay
// untouched. docs/tap-to-pay-release-entitlements.md says how to turn it back
// on for Release.
import type { TapToPayPlatform } from "@/lib/tap-to-pay";

declare global {
  interface Window {
    __HS_TAP_TO_PAY_ENTITLED__?: boolean;
  }
}

export function tapToPayEntitled(
  platform: TapToPayPlatform,
  flag: unknown = typeof window === "undefined" ? undefined : window.__HS_TAP_TO_PAY_ENTITLED__,
): boolean {
  if (platform !== "ios") return true;
  return flag === true;
}
