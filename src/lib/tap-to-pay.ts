// Tap to Pay on the phone (#579): who sees the button, on which phone, and
// what to say when a tap cannot happen.
//
// The phone is the card reader (Stripe Terminal, Tap to Pay on iPhone and on
// Android). Tap to Pay is drawn on an invoice only when ALL of these hold:
//
//   * this is the app binary, not the web or the PWA (IS_NATIVE_BUNDLE, a
//     build-time constant, so the web build folds every branch away);
//   * the platform is iOS on an iPhone, or Android 13 or later. Tap to Pay on
//     iPhone does not exist on iPad. An iPhone below iOS 16.4 (Stripe's
//     floor) is not left blank: it is told to update to the latest iOS
//     (Apple's review guide 1.4), and 16.4 to 17.5 can tap with the same note;
//   * the business can take cards at all (a charge-ready connected account),
//     and the invoice is open with something due.
//
// Who may START a tap is `manage_client_billing`, the permission
// createInvoicePaymentIntent requires (owner, office manager). Anyone else is
// shown who to ask (Apple 3.8.1) instead of nothing, and the server refuses
// them anyway. Only the owner may accept Apple's terms (3.8).
//
// What this cannot know in advance is whether THIS iPhone model or THIS
// Android phone passes Stripe's own checks (iPhone XS or later, NFC on, not
// rooted, Developer options off). The SDK says so when the phone looks for
// its reader, and `describeTapToPayError` turns that into a sentence.
//
// Deliberately a new file: src/lib/native.ts is not touched by this feature.
import { hasPermission } from "@/lib/permissions";
import type { AppRole } from "@/hooks/useMyRole";
import { radarFeeFromMetadata } from "@/lib/radar-fee";

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

/** The Stripe costs a charge's application fee carried on the business's
 *  behalf: the per-tap fee (#757) plus the Radar fee (#825), from the
 *  intent's metadata. Neither comes back from Stripe on a refund or dispute. */
export function passedThroughFeeCents(metadata: Record<string, string> | null | undefined): number {
  return tapToPayFeeFromMetadata(metadata) + radarFeeFromMetadata(metadata);
}

/**
 * The part of an application fee that a refund or a lost dispute may hand back.
 *
 * Everything except the Stripe costs passed through to the business: the
 * per-tap fee and, since #825, the Radar screening fee (`radar_fee_cents`).
 * Stripe keeps its Radar fee on a refunded or disputed charge just as it
 * keeps the tap fee, so handing that part back would leave the platform
 * paying for the business's screening.
 *
 * Where the platform is the fee payer, the tap's application fee is platform fee + TAP_TO_PAY_FEE_CENTS, and the ten
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
  return Math.max(0, feeCents - passedThroughFeeCents(metadata));
}

/** What a fee reversal learned about the charge's PaymentIntent metadata.
 *  `readable: false` means it could not be learned at all, which is not the
 *  same as "this charge carries no per-tap fee". */
export type ChargeMetadataRead =
  { readable: true; metadata: Record<string, string> } | { readable: false; reason: string };

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
 * short at most ten cents pro rata. It covers the Radar fee (#825) too: a tap
 * is `card_present`, which Radar does not screen, so a charge carries the tap
 * fee or the Radar fee and never both, and RADAR_SCREENING_FEE_CENTS (5) is
 * below the ten cents held back. It is never a reason to skip: the webhook
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
  | {
      show: true;
      /** "ready": the button that starts a tap. "update_ios": an iPhone too
       *  old for Tap to Pay, told to update rather than shown nothing (1.4).
       *  "ask_admin": a role that cannot take a payment, told who can
       *  (3.8.1) instead of seeing nothing. */
      mode: "ready" | "update_ios" | "ask_admin";
    }
  | {
      show: false;
      reason: "web" | "platform" | "device" | "no_stripe" | "not_payable";
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

/** Apple's review guide (1.4): below this, prompt to update to the latest
 *  iOS. Stripe itself still works from 16.4, so 16.4 to 17.5 can tap, with a
 *  note; below 16.4 the phone cannot tap at all and gets only the prompt. */
export const TAP_TO_PAY_LATEST_IOS_PROMPT_BELOW: [number, number] = [17, 6];

function atLeast(v: [number, number], min: [number, number]): boolean {
  return v[0] > min[0] || (v[0] === min[0] && v[1] >= min[1]);
}

/** True for an iPhone (not an iPad) on any iOS. */
export function isIPhone(platform: TapToPayPlatform, userAgent: string): boolean {
  return platform === "ios" && /iPhone/.test(userAgent) && iosVersion(userAgent) !== null;
}

/**
 * Whether this iPhone should be asked to update iOS (Apple 1.4):
 *   "required"    below 16.4: Tap to Pay cannot run, so this is all it gets;
 *   "recommended" 16.4 to 17.5: it can tap, and is told to update;
 *   null          17.6 or later, or not an iPhone.
 */
export function iosUpdateAdvice(
  platform: TapToPayPlatform,
  userAgent: string,
): "required" | "recommended" | null {
  if (!isIPhone(platform, userAgent)) return null;
  const v = iosVersion(userAgent)!;
  if (!atLeast(v, TAP_TO_PAY_MIN_IOS)) return "required";
  if (!atLeast(v, TAP_TO_PAY_LATEST_IOS_PROMPT_BELOW)) return "recommended";
  return null;
}

/** Can this phone be a Tap to Pay reader, as far as can be known before asking Stripe? */
export function deviceCanTapToPay(platform: TapToPayPlatform, userAgent: string): boolean {
  if (platform === "ios") {
    // An iPad reports "iPad" (or a desktop Safari UA); only an iPhone has
    // Tap to Pay on iPhone.
    if (!isIPhone(platform, userAgent)) return false;
    return atLeast(iosVersion(userAgent)!, TAP_TO_PAY_MIN_IOS);
  }
  if (platform === "android") {
    const v = androidVersion(userAgent);
    return v !== null && v >= TAP_TO_PAY_MIN_ANDROID;
  }
  return false;
}

/** Whether to draw Tap to Pay on an invoice, and in which form. */
export function tapToPayGate(input: TapToPayGateInput): TapToPayGate {
  if (!input.isNativeBundle) return { show: false, reason: "web" };
  if (input.platform !== "ios" && input.platform !== "android") {
    return { show: false, reason: "platform" };
  }
  const updateIos = iosUpdateAdvice(input.platform, input.userAgent) === "required";
  if (!updateIos && !deviceCanTapToPay(input.platform, input.userAgent)) {
    return { show: false, reason: "device" };
  }
  if (!input.cardPaymentsReady) return { show: false, reason: "no_stripe" };
  if (input.invoiceStatus !== "open" || !(input.dueCents > 0)) {
    return { show: false, reason: "not_payable" };
  }
  // Apple 3.8.1: a person who cannot take the payment is told who can, rather
  // than left wondering why the option is missing. The server refuses them
  // anyway (manage_client_billing on every Tap to Pay call).
  if (!hasPermission(input.role ?? null, "manage_client_billing")) {
    return { show: true, mode: "ask_admin" };
  }
  if (updateIos) return { show: true, mode: "update_ios" };
  return { show: true, mode: "ready" };
}

/**
 * Who may accept Apple's Tap to Pay on iPhone terms for the business (Apple
 * 3.8): the account owner, the one role that holds the business's own
 * billing. An office manager can take taps once the owner has accepted, and
 * is asked to fetch the owner when the terms are still open.
 */
export function canAcceptTapToPayTerms(role: AppRole | null | undefined): boolean {
  return hasPermission(role ?? null, "manage_org_billing");
}

/** Apple's name for the feature, and the button label (5.4). Never with the
 *  amount in it and never with an Apple logo. Android has no Apple name. */
export const TAP_TO_PAY_ON_IPHONE = "Tap to Pay on iPhone";
export function tapToPayLabel(platform: TapToPayPlatform): string {
  return platform === "ios" ? TAP_TO_PAY_ON_IPHONE : "Tap to Pay";
}

/** The SF Symbol Apple's guide names for the button icon (5.5). The web view
 *  cannot draw SF Symbols, so TapToPayMark draws this one as SVG. */
export const TAP_TO_PAY_SF_SYMBOL = "wave.3.right.circle";

/** Reader setup progress (Apple 3.9.1, 5.7) from the plugin's
 *  ReaderSoftwareUpdateProgress event, which reports 0 to 1. A whole percent,
 *  clamped, so a stray value can never draw a meter past its track. */
export function readerSetupPercent(progress: unknown): number {
  const n = typeof progress === "number" ? progress : Number(progress);
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.min(1, Math.max(0, n)) * 100);
}

export type TapToPayOutcome = "approved" | "declined";

/**
 * The receipt text a merchant can send the customer after a tap, approved or
 * declined (Apple 5.10). Sent through the phone's share sheet (text, email,
 * AirDrop), so the customer gets it in whatever way they ask for. Customer
 * facing, so English, in the business's own name.
 */
export function tapToPayReceiptText(r: {
  businessName: string;
  amountLabel: string;
  outcome: TapToPayOutcome;
  invoiceLabel?: string | null;
  at: Date;
}): string {
  const when = r.at.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const lines = [
    `Receipt from ${r.businessName || "your service provider"}`,
    r.outcome === "approved"
      ? `Payment approved: ${r.amountLabel}`
      : `Payment declined: ${r.amountLabel}`,
    r.outcome === "approved" ? "Paid by contactless card or wallet." : "Your card was not charged.",
  ];
  if (r.invoiceLabel) lines.push(`Invoice: ${r.invoiceLabel}`);
  lines.push(`Date: ${when}`);
  return lines.join("\n");
}

/** What an interrupted tap's PaymentIntent status means for the merchant.
 *  "unknown" (no intent, or it could not be read) says nothing: a wrong "not
 *  approved" would send someone to charge a card twice. */
export function tapToPayInterruptedOutcome(
  status: string | null | undefined,
): "approved" | "pending" | "not_approved" | "unknown" {
  if (!status) return "unknown";
  if (status === "succeeded") return "approved";
  if (status === "processing" || status === "requires_capture") return "pending";
  return "not_approved";
}

/** The push sent when a tap was not approved because the app closed (5.12). */
export function tapToPayNotApprovedPush(amountLabel: string): { title: string; body: string } {
  return {
    title: "Payment not approved",
    body: `The ${amountLabel} Tap to Pay payment was not approved because the app was closed. Nothing was charged. Open the invoice to try again.`,
  };
}

export const TAP_TO_PAY_MESSAGES = {
  offline:
    "No connection. Tap to Pay needs the internet to approve the card. Try again when you have signal, or record a cash or check payment instead.",
  ineligible:
    "This phone can't take Tap to Pay. It needs an iPhone XS or newer on the latest version of iOS, or an Android 13+ phone with NFC turned on and Developer options off.",
  terms:
    "Apple's Tap to Pay on iPhone terms haven't been accepted for this business yet. The account owner accepts them once, on an iPhone signed in with an Apple ID, then any iPhone can take taps.",
  nfcOff: "NFC is turned off. Turn it on in the phone's settings, then try again.",
  canceled: "Tap to Pay was canceled. Nothing was charged.",
  declined: "The card was declined. Nothing was charged. Ask for another card.",
  updateIosRequired:
    "Update this iPhone to the latest version of iOS to use Tap to Pay on iPhone. Go to Settings, General, Software Update.",
  updateIosRecommended:
    "Update this iPhone to the latest version of iOS for the best Tap to Pay on iPhone experience. Go to Settings, General, Software Update.",
  askAdmin:
    "Ask your account owner to turn on Tap to Pay on iPhone. They accept Apple's terms once, then you can take payments by tap.",
  askAdminToPay:
    "Taking payments by tap is for the account owner and office managers. Ask your account owner if you need it.",
  notAvailable: "Tap to Pay isn't turned on for this business yet.",
  generic: "Tap to Pay couldn't finish. Nothing was charged. Try again, or use Enter card details.",
} as const;

export type TapToPayErrorKind =
  "offline" | "terms" | "nfcOff" | "ineligible" | "canceled" | "declined" | "generic";

/** Which of the known failures a plugin rejection is. The plugin rejects with
 *  free text (the SDK's `localizedDescription`), so this matches on wording. */
export function classifyTapToPayError(
  error: unknown,
  ctx: { online: boolean; termsLinked?: boolean | null } = { online: true },
): { kind: TapToPayErrorKind; raw: string } {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : String((error as { message?: unknown })?.message ?? "");
  if (!ctx.online) return { kind: "offline", raw };
  const msg = raw.toLowerCase();
  if (/network|offline|internet connection|timed out|could not connect/.test(msg)) {
    return { kind: "offline", raw };
  }
  if (/terms|tos|account.?link|not linked|apple id|icloud/.test(msg) || ctx.termsLinked === false) {
    return { kind: "terms", raw };
  }
  if (/nfc.*(disabled|off|not enabled)/.test(msg)) return { kind: "nfcOff", raw };
  if (
    /unsupported|not supported|incompatible|ineligible|developer options|rooted|debug|attestation|tampered|passcode|os version/.test(
      msg,
    )
  ) {
    return { kind: "ineligible", raw };
  }
  if (/cancel/.test(msg)) return { kind: "canceled", raw };
  if (/declin/.test(msg)) return { kind: "declined", raw };
  return { kind: "generic", raw };
}

/**
 * A plugin rejection as something a person at a customer's door can act on.
 * Anything unrecognised gets the generic message plus the SDK's own words,
 * rather than a guess.
 */
export function describeTapToPayError(
  error: unknown,
  ctx: { online: boolean; termsLinked?: boolean | null } = { online: true },
): string {
  const { kind, raw } = classifyTapToPayError(error, ctx);
  if (kind === "generic") {
    return raw ? `${TAP_TO_PAY_MESSAGES.generic} (${raw})` : TAP_TO_PAY_MESSAGES.generic;
  }
  return TAP_TO_PAY_MESSAGES[kind];
}
