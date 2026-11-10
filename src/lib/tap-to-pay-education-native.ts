// Apple's own merchant education for Tap to Pay on iPhone (review guide 4.x):
// ProximityReaderDiscovery, iOS 18 and later. The Stripe plugin does not
// expose it, so a small local plugin in the app target does
// (ios/App/App/TapToPay/TapToPayEducationPlugin.swift, registered in
// HSBridgeViewController). On older iOS, on Android, and anywhere the plugin
// is missing, TapToPayEducation's own screens are shown instead.
import { Capacitor, registerPlugin } from "@capacitor/core";

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
    return (await native().isAvailable()).available;
  } catch {
    return false;
  }
}

/** Show Apple's guide. False when it could not be shown. */
export async function showAppleEducation(): Promise<boolean> {
  try {
    return (await native().show()).shown;
  } catch {
    return false;
  }
}
