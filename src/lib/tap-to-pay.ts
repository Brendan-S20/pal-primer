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

/** The per-tap fee a charge's application fee carried, from the
 *  `tap_to_pay_fee_cents` its PaymentIntent was created with. 0 for every
 *  charge that is not a tap, and for anything malformed. */
export function tapToPayFeeFromMetadata(
  metadata: Record<string, string> | null | undefined,
): number {
  const raw = metadata?.tap_to_pay_fee_cents;
  if (typeof raw !== "string" || !/^\d{1,6}$/.test(raw)) return 0;
  return Number(raw);
}

/**
 * The part of an application fee that a refund or a lost dispute may hand back.
 *
 * Everything except the per-tap fee. Where the platform is the fee payer, the
 * tap's application fee is platform fee + TAP_TO_PAY_FEE_CENTS, and the ten
 * cents recovers a fee Stripe billed the platform and does not return when a
 * charge is refunded or disputed. Reversing it proportionally would leave the
 * platform paying for the tenant's tap, which the owner ruled out
 * (2026-11-10). The platform-fee part still comes back exactly as before.
 */
export function reversibleApplicationFeeCents(
  feeCents: number,
  metadata: Record<string, string> | null | undefined,
): number {
  if (!Number.isFinite(feeCents) || feeCents <= 0) return 0;
  return Math.max(0, feeCents - tapToPayFeeFromMetadata(metadata));
}

/** What a fee reversal learned about the charge's PaymentIntent metadata.
 *  `readable: false` means it could not be learned at all, which is not the
 *  same as "this charge carries no per-tap fee". */
export type ChargeMetadataRead =
  | { readable: true; metadata: Record<string, string> }
  | { readable: false; reason: string };

/**
 * The metadata a charge's PaymentIntent was created with. A charge made by a
 * PaymentIntent normally carries a copy; when it does not (or there is no
 * charge object, as on a dispute), the intent is read through `readIntent`,
 * which the webhook points at the connected account the intent lives on.
 * Never throws: a failure comes back as `readable: false`.
 */
export async function readChargeMetadata(
  charge: { metadata?: Record<string, string> | null } | null,
  paymentIntentId: string | null,
  readIntent: ((id: string) => Promise<Record<string, string> | null | undefined>) | null,
): Promise<ChargeMetadataRead> {
  const fromCharge = charge?.metadata;
  if (fromCharge && Object.keys(fromCharge).length > 0) {
    return { readable: true, metadata: fromCharge };
  }
  if (!paymentIntentId) return { readable: false, reason: "no payment intent" };
  if (!readIntent) return { readable: false, reason: "no connected account" };
  try {
    return { readable: true, metadata: (await readIntent(paymentIntentId)) ?? {} };
  } catch (e) {
    return { readable: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * The part of an application fee a refund or dispute may hand back, given what
 * could be learned about the charge's metadata. The webhook feeds it into
 * feeReversalCents and sends only the difference from what Stripe has already
 * returned, exactly as before.
 *
 * Readable metadata behaves exactly as before.
 *
 * Unreadable metadata (#826) reverses the fee less at most
 * TAP_TO_PAY_FEE_CENTS. A tap's ten cents may be in the fee and may not, and
 * assuming "no per-tap fee" would hand it back on the `application` fee payer,
 * so the platform would pay for the tenant's tap (owner decision, 2026-11-10).
 * Taking ten cents off covers that case, and otherwise leaves the business
 * short at most ten cents pro rata. It is never a reason to skip: the webhook
 * answers 2xx, so Stripe does NOT redeliver the event, and a skipped reversal
 * would stay skipped. The caller files a platform audit row for every
 * unreadable case so a person can square the ten cents by hand.
 *
 * Deliberately not importing @/lib/platform-fee: this module ships to the
 * app, and the fee term stays off the client
 * (tests/a-pricing-term-that-shipped-to-the-browser.test.ts).
 */
export function reversibleFeeBaseCents(feeCents: number, read: ChargeMetadataRead): number {
  if (!read.readable) {
    if (!Number.isFinite(feeCents) || feeCents <= 0) return 0;
    return Math.max(0, feeCents - TAP_TO_PAY_FEE_CENTS);
  }
  return reversibleApplicationFeeCents(feeCents, read.metadata);
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
