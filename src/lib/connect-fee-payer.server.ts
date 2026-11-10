// Who Stripe bills for a connected account's direct charges, read from the
// account itself (#757, #825).
//
// HoundStack creates every connected account with the legacy
// `type: "express"` (stripe-connect.server.ts, ensureExpressAccount), which
// Stripe records as `controller.fees.payer: "application_express"`. That is a
// property of each account, not of this code, so the charge paths that pass a
// Stripe cost through to the business read it at the charge rather than
// assume it:
//
//   * the per-tap fee (src/lib/tap-to-pay.server.ts) is added only where the
//     platform would be billed: `application`, or unreadable;
//   * the Radar fee (src/lib/radar-fee.ts) is added everywhere except
//     `account`, because the live check on #825 found Radar billed to the
//     platform under `application_express`.
import type Stripe from "stripe";
import { radarFeeCents, radarFeeMetadata } from "@/lib/radar-fee";

type AccountsLike = { accounts: { retrieve: (id: string) => Promise<unknown> } };

/** The connected account's `controller.fees.payer`, or null if it cannot be read. */
export async function connectedAccountFeePayer(
  stripe: AccountsLike,
  stripeAccount: string,
): Promise<string | null> {
  // Two attempts: a transient failure here would otherwise be charged as if
  // the platform pays. A second failure is logged so it can be reconciled.
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const acct = (await stripe.accounts.retrieve(stripeAccount)) as {
        controller?: { fees?: { payer?: string | null } | null } | null;
      } | null;
      const payer = acct?.controller?.fees?.payer ?? null;
      if (!payer) console.warn("Connect: no controller.fees.payer on", stripeAccount);
      return payer;
    } catch (e) {
      lastError = e;
    }
  }
  console.warn(
    "Connect: could not read the fee payer; charged as if the platform pays",
    stripeAccount,
    lastError,
  );
  return null;
}

export type RadarPassThrough = {
  /** Cents to add to the application fee (withPassThroughFees). */
  cents: number;
  /** Written into the intent's metadata, so a refund or dispute can tell. */
  metadata: ReturnType<typeof radarFeeMetadata>;
};

/**
 * The Radar fee a charge on `stripeAccount` passes through, for a charge
 * offering `paymentMethodTypes` (undefined: automatic methods). Reads the
 * account's fee payer; never throws.
 */
export async function radarPassThrough(
  stripe: AccountsLike | Pick<Stripe, "accounts">,
  stripeAccount: string,
  paymentMethodTypes: readonly string[] | null | undefined,
): Promise<RadarPassThrough> {
  const feePayer = await connectedAccountFeePayer(stripe as AccountsLike, stripeAccount);
  const cents = radarFeeCents(feePayer, paymentMethodTypes);
  return { cents, metadata: radarFeeMetadata(cents, feePayer) };
}
