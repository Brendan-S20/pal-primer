// What a native build may show about HOUNDSTACK'S OWN subscription.
//
// ── THE LINE, AND WHY IT FALLS WHERE IT DOES ──────────────────────────────
//
// Two completely different kinds of money move through this app, and App Store
// Review treats them as opposites:
//
//   1. A homeowner pays a pet-waste company for pet-waste removal. That is a
//      real-world service performed at a physical address by a person with a
//      truck. Apple's own rules put physical goods and services OUTSIDE
//      In-App Purchase, and always have. Taking that payment is the operational
//      point of the field app, so it stays, on iOS exactly as on the web.
//
//   2. An organization pays HoundStack for HoundStack. That is digital software
//      sold to the person holding the phone, and it is the thing Apple expects
//      to go through IAP if it happens inside the binary.
//
// Owner decision (2026-08-20): HoundStack's SaaS subscription stays WEB-SOLD.
// The iOS app is a free companion for organizations that already exist. No
// Apple IAP is implemented, and none is to be added without an explicit
// decision. So case 2 must not be purchasable inside the native shell.
//
// ── WHAT THIS HIDES, AND WHAT IT DELIBERATELY DOES NOT ────────────────────
//
// Hidden natively: anything that STARTS OR CHANGES a HoundStack purchase — the
// plan picker, the inline Payment Element checkout, platform add-on
// subscribe/cancel, and the card-on-file used to pay HoundStack.
//
// Kept natively: read-only account status — the plan you are on, trial state,
// what the next invoice will be. That is a fact about the account, not a call
// to action, and hiding it would make the app worse for no review benefit.
//
// Kept natively, and this is the distinction a blunt rule gets wrong: the
// org's own selling. `createAddonSubscription` in client-detail/billing-panels
// sells a SERVICE to the org's client. `subscribePlatformAddon` in
// settings.billing buys software FROM HoundStack. The two read almost
// identically at a call site and land on opposite sides of this line.
//
// ── WHY THE GATE IS ON `native`, NOT ON `ios` ─────────────────────────────
//
// Google Play's Payments policy says the same thing about digital goods, so an
// Android build would inherit the same problem the day it is generated. Gating
// on ios alone would leave a rule that silently stops applying the moment
// `npx cap add android` runs, which is precisely the sort of gap this repo
// keeps finding. Today only iOS exists, so the two are equivalent and this
// costs nothing; the day Android ships it is already right.

/** Platforms whose store rules govern digital-goods sales inside the binary. */
const STORE_PLATFORMS = new Set(["ios", "android"]);

/**
 * May this platform show a way to BUY or CHANGE a HoundStack subscription?
 *
 * Pure and platform-string-shaped rather than reading Capacitor directly, so
 * it can be asserted from a test without a device.
 */
export function saasPurchaseAllowed(platform: string): boolean {
  return !STORE_PLATFORMS.has(platform);
}

/**
 * May this platform take a payment from the TENANT'S OWN CUSTOMER?
 *
 * Always yes. It exists as a named function rather than an absent check so the
 * asymmetry is visible in the code: somebody tightening the rule above should
 * see that this one is deliberately not tightened with it, and why.
 */
export function customerPaymentAllowed(_platform: string): boolean {
  return true;
}

/**
 * Shown in place of the purchase UI inside a store build.
 *
 * ── WHY THIS WORDING, AND WHY IT CHANGED ──────────────────────────────────
 *
 * It used to read "Your HoundStack plan and billing are managed on the web at
 * app.houndstack.com." That is accurate, and it was still the wrong thing to
 * ship. Guideline 3.1.1 is not only about taking the payment — it is about
 * STEERING, and naming the destination is the steer. A sentence that tells
 * someone the domain to go to is a call to action with the button removed,
 * which is the same intent in fewer pixels.
 *
 * So the rule for every string on this screen in a native build:
 *
 *   * state WHERE the capability is not ("outside the mobile app"), never
 *     where it is;
 *   * never name a domain, a URL, or "the web";
 *   * no purchase verbs — no choose, upgrade, subscribe, buy, update payment.
 *
 * What it must NOT do is hide the account's state. Plan, renewal date, trial
 * and past-due are all read-only facts about an account somebody already has,
 * and a store build that concealed them would be worse for the customer and no
 * safer for review. Visibility stays; the verbs go.
 *
 * The web build is untouched and keeps its full purchase flow.
 */
export const BILLING_MANAGED_OUTSIDE_APP =
  "HoundStack plan billing is managed outside the mobile app. " +
  "Existing app features continue here.";
