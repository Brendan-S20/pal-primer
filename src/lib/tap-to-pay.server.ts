// Tap to Pay on the phone (#579): the Stripe side.
//
// The phone itself is the card reader (Stripe Terminal, Tap to Pay on iPhone /
// Android). Everything here runs on the business's CONNECTED account, exactly
// like Take payment: a DIRECT charge created with `{ stripeAccount }`, so the
// money settles into the business's own balance and only
// `application_fee_amount` (platformFeeCents, currently zero) moves to the
// platform. Terminal on Connect with direct charges needs three things on that
// same account, and nothing on the platform's own:
//
//   1. a connection token  (the SDK on the phone asks for one per session)
//   2. a Terminal Location (Tap to Pay registers the phone against one)
//   3. a card_present PaymentIntent
//
// The Location is created LAZILY, the first time somebody in the org taps, and
// found again afterwards by its metadata rather than stored in a column. That
// keeps this change free of a migration, and it is the right shape anyway: the
// location lives on the Stripe account, so Stripe is the authority on whether
// it exists. A franchise location whose franchise collects (BUILD-6) charges
// into the franchise's account; `organization_id` in the metadata keeps one
// location per business on that shared account.
//
// Nothing in this file decides WHO may tap or on WHICH phone. The server
// functions require `manage_client_billing` (the same permission as Take
// payment), and `src/lib/tap-to-pay.ts` decides whether the button is drawn.
import type Stripe from "stripe";
import { platformFeeCents } from "@/lib/platform-fee";
import { tipMetadata } from "@/lib/tips";

/** Marks a Terminal Location as the one this product made for an org. */
export const TAP_TO_PAY_LOCATION_TAG = "houndstack_tap_to_pay";

/** What the webhook needs to credit the invoice. `source: "staff_inline"` is
 *  deliberate: `payment_intent.succeeded` in hooks/stripe.ts already marks an
 *  invoice paid (and writes the payments row through markInvoicePaidFromStripe)
 *  for that source, whatever the payment method type, so a card_present charge
 *  lands in the ledger exactly like a card typed into Take payment. `channel`
 *  says which of the two it was, for reporting and for a future webhook that
 *  wants to tell them apart, without needing that webhook to change today. */
export const TAP_TO_PAY_SOURCE = "staff_inline";
export const TAP_TO_PAY_CHANNEL = "tap_to_pay";

export type LocationAddress = {
  line1: string;
  city: string;
  state: string;
  postal_code: string;
  country: string;
};

/** The org's free-text `contact_address` as a Stripe address, or null when it
 *  cannot be read with confidence. Stripe requires line1, city, state and
 *  postal code for a US location, and a location in the wrong place is a
 *  compliance problem rather than a cosmetic one, so this refuses rather than
 *  guesses. Accepts the shape the settings form and Google autocomplete both
 *  produce: "123 Main St, Springfield, IL 62704[, USA]". */
export function parseLocationAddress(
  contactAddress: string | null | undefined,
  country: string | null | undefined,
): LocationAddress | null {
  const raw = (contactAddress ?? "").trim();
  if (!raw) return null;
  const parts = raw
    .split(/\s*[,\n]\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  // A trailing country name is dropped; the org's own country column decides.
  if (parts.length && /^(usa|us|united states( of america)?|canada|ca)$/i.test(parts.at(-1)!)) {
    parts.pop();
  }
  if (parts.length < 3) return null;
  const stateZip = parts.at(-1)!;
  const m = /^([A-Za-z]{2})\s+([A-Za-z0-9][A-Za-z0-9 -]{2,9})$/.exec(stateZip);
  if (!m) return null;
  const city = parts.at(-2)!;
  const line1 = parts.slice(0, -2).join(", ");
  if (!line1 || !city) return null;
  return {
    line1,
    city,
    state: m[1].toUpperCase(),
    postal_code: m[2].trim().toUpperCase(),
    country: (country ?? "US").trim().toUpperCase() || "US",
  };
}

export const TAP_TO_PAY_ADDRESS_MISSING =
  "Tap to Pay needs the business address (street, city, state and ZIP). Add it under Settings, Client portal, then try again.";

type StripeLike = Pick<Stripe, "terminal" | "paymentIntents">;

/** The org's Terminal Location on its connected account, created on first use. */
export async function ensureTerminalLocation(
  stripe: StripeLike,
  stripeAccount: string,
  org: { id: string; name: string; contact_address: string | null; country: string | null },
): Promise<string> {
  const opts = { stripeAccount };
  // Locations are few (one per business here); the first page is the whole set.
  const existing = await stripe.terminal.locations.list({ limit: 100 }, opts);
  const mine = existing.data.find(
    (l) =>
      !(l as { deleted?: boolean }).deleted &&
      l.metadata?.[TAP_TO_PAY_LOCATION_TAG] === "1" &&
      l.metadata?.organization_id === org.id,
  );
  if (mine) return mine.id;

  const address = parseLocationAddress(org.contact_address, org.country);
  if (!address) throw new Error(TAP_TO_PAY_ADDRESS_MISSING);
  const created = await stripe.terminal.locations.create(
    {
      display_name: org.name.slice(0, 100) || "Business",
      address,
      metadata: { [TAP_TO_PAY_LOCATION_TAG]: "1", organization_id: org.id },
    },
    // Two phones tapping for the first time at once must not make two.
    { ...opts, idempotencyKey: `tap-to-pay-location:${org.id}` },
  );
  return created.id;
}

/** A one-use connection token for the Terminal SDK, scoped to the location. */
export async function createConnectionToken(
  stripe: StripeLike,
  stripeAccount: string,
  locationId: string,
): Promise<string> {
  const token = await stripe.terminal.connectionTokens.create(
    { location: locationId },
    { stripeAccount },
  );
  return token.secret;
}

export type TapToPayInvoice = {
  id: string;
  organization_id: string;
  total_cents: number;
  tax_cents?: number | null;
  currency: string | null;
  stripe_payment_intent_id: string | null;
};

/**
 * Clear the way for a card_present intent, then create it.
 *
 * Same two guards as the saved-card charge: an intent already `processing` (a
 * bank debit clearing) means the invoice IS being paid, so refuse; a
 * still-confirmable intent may be open in the customer's portal at the old
 * amount, so cancel it, or they could pay it after the tap and pay twice.
 */
export async function createCardPresentIntent(
  stripe: StripeLike,
  stripeAccount: string,
  invoice: TapToPayInvoice,
  dueCents: number,
  customerId: string | null,
): Promise<Stripe.PaymentIntent> {
  const opts = { stripeAccount };
  if (invoice.stripe_payment_intent_id) {
    let existing: Stripe.PaymentIntent | null = null;
    try {
      existing = await stripe.paymentIntents.retrieve(invoice.stripe_payment_intent_id, {}, opts);
    } catch {
      existing = null; // a retrieve hiccup does not block; the reconcile ran first
    }
    if (existing?.status === "processing") {
      throw new Error(
        "A payment for this invoice is already processing. Bank payments can take a few days to clear.",
      );
    }
    if (
      existing &&
      (existing.status === "requires_payment_method" ||
        existing.status === "requires_confirmation" ||
        existing.status === "requires_action")
    ) {
      await stripe.paymentIntents.cancel(existing.id, {}, opts);
    }
  }

  const currency = (invoice.currency ?? "usd").toLowerCase();
  const createParams = {
    amount: dueCents,
    application_fee_amount: platformFeeCents(dueCents, invoice),
    currency,
    ...(customerId ? { customer: customerId } : {}),
    metadata: {
      invoice_id: invoice.id,
      organization_id: invoice.organization_id,
      source: TAP_TO_PAY_SOURCE,
      channel: TAP_TO_PAY_CHANNEL,
      // No tip on Tap to Pay (on-reader tipping is out of scope). Written as
      // zero, like Take payment, so the webhook never credits a stale tip.
      ...tipMetadata(0),
    },
  };
  return await stripe.paymentIntents.create(
    {
      ...createParams,
      payment_method_types: ["card_present"],
      // Captured on confirm, so payment_intent.succeeded fires and the
      // existing webhook path marks the invoice paid with no second step.
      capture_method: "automatic",
    },
    opts,
  );
}
