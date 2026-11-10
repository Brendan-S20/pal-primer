// Tap to Pay on the phone (#579): who sees the button, on which phone, and
// what to say when a tap cannot happen.
//
// The phone is the card reader (Stripe Terminal, Tap to Pay on iPhone and on
// Android). The button is drawn only when ALL of these hold:
//
//   * this is the app binary, not the web or the PWA (IS_NATIVE_BUNDLE, a
//     build-time constant, so the web build folds every branch away);
//   * the platform is iOS on an iPhone, or Android 13 or later. Tap to Pay on
//     iPhone does not exist on iPad, and Stripe needs iOS 16.4 for the
//     terms check; Product set Android 13 as the floor;
//   * the person may already take a payment: `manage_client_billing`, the
//     permission createInvoicePaymentIntent requires. A tech or a dispatcher
//     does not hold it, so neither sees the button (and the server refuses
//     them anyway);
//   * the business can take cards at all (a charge-ready connected account),
//     and the invoice is open with something due.
//
// What this cannot know in advance is whether THIS iPhone model or THIS
// Android phone passes Stripe's own checks (iPhone XS or later, NFC on, not
// rooted, Developer options off). The SDK says so when the phone looks for
// its reader, and `describeTapToPayError` turns that into a sentence.
//
// Deliberately a new file: src/lib/native.ts is not touched by this feature.
import { hasPermission } from "@/lib/permissions";
import type { AppRole } from "@/hooks/useMyRole";

/** Stripe's Tap to Pay per-transaction fee (US), in cents. The business that
 *  takes the tap bears it (owner decision, 2026-11-10): Stripe bills it to
 *  the connected account on a direct charge, and where Stripe would bill the
 *  platform instead, tap-to-pay.server.ts recovers it through the
 *  application fee. Shown on the button before the first tap. */
export const TAP_TO_PAY_FEE_CENTS = 10;

/** "$0.10", for the sentence on the button. */
export function tapToPayFeeLabel(): string {
  return "$" + (TAP_TO_PAY_FEE_CENTS / 100).toFixed(2);
}

export type TapToPayPlatform = "ios" | "android" | "web" | string;

export type TapToPayGateInput = {
  isNativeBundle: boolean;
  platform: TapToPayPlatform;
  userAgent: string;
  role: AppRole | null | undefined;
  cardPaymentsReady: boolean;
  invoiceStatus: string | null | undefined;
  dueCents: number;
};

export type TapToPayGate =
  | { show: true }
  | {
      show: false;
      reason: "web" | "platform" | "device" | "role" | "no_stripe" | "not_payable";
    };

/** iOS version from a WKWebView user agent ("iPhone OS 17_4 like Mac OS X"). */
export function iosVersion(userAgent: string): [number, number] | null {
  const m = /iPhone OS (\d+)[_.](\d+)/.exec(userAgent);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** Android major version from a WebView user agent ("Android 14; Pixel 8"). */
export function androidVersion(userAgent: string): number | null {
  const m = /Android (\d+)/.exec(userAgent);
  return m ? Number(m[1]) : null;
}

export const TAP_TO_PAY_MIN_IOS: [number, number] = [16, 4];
export const TAP_TO_PAY_MIN_ANDROID = 13;

/** Can this phone be a Tap to Pay reader, as far as can be known before asking Stripe? */
export function deviceCanTapToPay(platform: TapToPayPlatform, userAgent: string): boolean {
  if (platform === "ios") {
    // An iPad reports "iPad" (or a desktop Safari UA); only an iPhone has
    // Tap to Pay on iPhone.
    const v = iosVersion(userAgent);
    if (!v || !/iPhone/.test(userAgent)) return false;
    const [major, minor] = v;
    const [minMajor, minMinor] = TAP_TO_PAY_MIN_IOS;
    return major > minMajor || (major === minMajor && minor >= minMinor);
  }
  if (platform === "android") {
    const v = androidVersion(userAgent);
    return v !== null && v >= TAP_TO_PAY_MIN_ANDROID;
  }
  return false;
}

/** Whether to draw "Tap to pay" on an invoice, and if not, why not. */
export function tapToPayGate(input: TapToPayGateInput): TapToPayGate {
  if (!input.isNativeBundle) return { show: false, reason: "web" };
  if (input.platform !== "ios" && input.platform !== "android") {
    return { show: false, reason: "platform" };
  }
  if (!deviceCanTapToPay(input.platform, input.userAgent)) return { show: false, reason: "device" };
  if (!hasPermission(input.role ?? null, "manage_client_billing")) {
    return { show: false, reason: "role" };
  }
  if (!input.cardPaymentsReady) return { show: false, reason: "no_stripe" };
  if (input.invoiceStatus !== "open" || !(input.dueCents > 0)) {
    return { show: false, reason: "not_payable" };
  }
  return { show: true };
}

export const TAP_TO_PAY_MESSAGES = {
  offline:
    "No connection. Tap to Pay needs the internet to approve the card. Try again when you have signal, or record a cash or check payment instead.",
  ineligible:
    "This phone can't take Tap to Pay. It needs an iPhone XS or newer on iOS 16.4 or later, or an Android 13+ phone with NFC turned on and Developer options off.",
  terms:
    "Apple's Tap to Pay on iPhone terms haven't been accepted for this business yet. The account owner accepts them once, on an iPhone signed in with an Apple ID, then any iPhone can take taps.",
  nfcOff: "NFC is turned off. Turn it on in the phone's settings, then try again.",
  canceled: "Tap to Pay was canceled. Nothing was charged.",
  declined: "The card was declined. Nothing was charged. Ask for another card.",
  generic: "Tap to Pay couldn't finish. Nothing was charged. Try again, or use Enter card details.",
} as const;

/**
 * A plugin rejection (the SDK's `localizedDescription`) as something a person
 * at a customer's door can act on. The plugin rejects with free text, so this
 * matches on wording; anything unrecognised gets the generic message plus the
 * SDK's own words, rather than a guess.
 */
export function describeTapToPayError(
  error: unknown,
  ctx: { online: boolean; termsLinked?: boolean | null } = { online: true },
): string {
  if (!ctx.online) return TAP_TO_PAY_MESSAGES.offline;
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : String((error as { message?: unknown })?.message ?? "");
  const msg = raw.toLowerCase();
  if (/network|offline|internet connection|timed out|could not connect/.test(msg)) {
    return TAP_TO_PAY_MESSAGES.offline;
  }
  if (/terms|tos|account.?link|not linked|apple id|icloud/.test(msg) || ctx.termsLinked === false) {
    return TAP_TO_PAY_MESSAGES.terms;
  }
  if (/nfc.*(disabled|off|not enabled)/.test(msg)) return TAP_TO_PAY_MESSAGES.nfcOff;
  if (
    /unsupported|not supported|incompatible|ineligible|developer options|rooted|debug|attestation|tampered|passcode|os version/.test(
      msg,
    )
  ) {
    return TAP_TO_PAY_MESSAGES.ineligible;
  }
  if (/cancel/.test(msg)) return TAP_TO_PAY_MESSAGES.canceled;
  if (/declin/.test(msg)) return TAP_TO_PAY_MESSAGES.declined;
  return raw ? `${TAP_TO_PAY_MESSAGES.generic} (${raw})` : TAP_TO_PAY_MESSAGES.generic;
}
