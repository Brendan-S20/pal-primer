// Apple's own merchant education for Tap to Pay on iPhone (review guide 4.x):
// ProximityReaderDiscovery, iOS 18 and later. The Stripe plugin does not
// expose it, so a small local plugin in the app target does
// (ios/App/App/TapToPay/TapToPayEducationPlugin.swift, registered in
// HSBridgeViewController). On older iOS, on Android, and anywhere the plugin
// is missing, TapToPayEducation's own screens are shown instead.
import { Capacitor, registerPlugin } from "@capacitor/core";
import { tapToPayEntitled } from "@/lib/tap-to-pay-entitlement";

interface TapToPayEducationPlugin {
  isAvailable(): Promise<{ available: boolean }>;
  show(): Promise<{ shown: boolean }>;
}

let plugin: TapToPayEducationPlugin | null = null;
function native(): TapToPayEducationPlugin {
  plugin ??= registerPlugin<TapToPayEducationPlugin>("TapToPayEducation");
  return plugin;
}

/** True when Apple's own "how to tap" guide can be shown on this phone. */
export async function appleEducationAvailable(): Promise<boolean> {
  try {
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "ios") return false;
    // A Release build is signed without Tap to Pay (#854): no ProximityReader.
    if (!tapToPayEntitled("ios")) return false;
    return (await native().isAvailable()).available;
  } catch {
    return false;
  }
}

/** Show Apple's guide. False when it could not be shown. */
export async function showAppleEducation(): Promise<boolean> {
  try {
    if (!tapToPayEntitled(Capacitor.getPlatform())) return false;
    return (await native().show()).shown;
  } catch {
    return false;
  }
}
