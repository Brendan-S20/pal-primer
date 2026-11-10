// Detaching a saved card in Stripe, with one answer for "it is already gone".
//
// Removing a card has to remove it in Stripe, not only from our screen: a card
// left attached to a customer can still be charged off-session. So a detach
// that FAILS is an error the person sees, never a "Card removed" we cannot
// stand behind. A detach that finds the card already detached (or deleted) is
// the outcome that was asked for, and is reported as success.

export type DetachOutcome = "detached" | "already_detached";

/** What a person reads when Stripe would not let go of the card. */
export const CARD_NOT_REMOVED_MESSAGE =
  "We couldn't remove this card. Nothing was changed. Please try again in a moment.";

/** Stripe's ways of saying the card is not attached to anyone any more. */
export function isAlreadyDetachedError(e: unknown): boolean {
  const err = e as { code?: string; message?: string } | null;
  if (!err) return false;
  if (err.code === "resource_missing") return true;
  if (err.code === "payment_method_unexpected_state" && /not attached/i.test(err.message ?? "")) {
    return true;
  }
  return /is not attached to a customer|No such PaymentMethod/i.test(err.message ?? "");
}

type DetachingStripe = {
  paymentMethods: {
    detach: (id: string, params?: object, opts?: object) => Promise<unknown>;
  };
};

export async function detachPaymentMethod(
  stripe: DetachingStripe,
  paymentMethodId: string,
  opts: { stripeAccount?: string; context: string },
): Promise<DetachOutcome> {
  try {
    if (opts.stripeAccount) {
      await stripe.paymentMethods.detach(
        paymentMethodId,
        {},
        { stripeAccount: opts.stripeAccount },
      );
    } else {
      await stripe.paymentMethods.detach(paymentMethodId);
    }
    return "detached";
  } catch (e) {
    if (isAlreadyDetachedError(e)) {
      console.info(`[${opts.context}] card already detached`, paymentMethodId);
      return "already_detached";
    }
    const err = e as { code?: string; message?: string };
    console.error(`[${opts.context}] card detach failed`, paymentMethodId, err?.code, err?.message);
    throw new Error(CARD_NOT_REMOVED_MESSAGE);
  }
}
