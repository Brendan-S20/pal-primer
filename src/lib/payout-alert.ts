// The payout alert an owner reads in the Inbox (#1075). It is the only place
// they hear that money did not reach them, so it has to name the real cause.
// Before this, every failure said "fix your bank details" (even a low balance),
// a negative amount printed as "$-2.04", and Stripe's own sentence was pasted in
// with its period and then given a second one.

// Failure codes that mean the bank account itself is the problem: these are
// the ones where every later payout stops until the owner fixes the details.
export const BANK_DETAIL_FAILURES: ReadonlySet<string> = new Set([
  "account_closed",
  "account_frozen",
  "bank_account_restricted",
  "bank_ownership_changed",
  "debit_not_authorized",
  "incorrect_account_holder_address",
  "incorrect_account_holder_name",
  "incorrect_account_holder_tax_id",
  "invalid_account_number",
  "invalid_currency",
  "no_account",
  "unsupported_card",
]);

export type PayoutLike = {
  amount?: number | null;
  failure_code?: string | null;
  failure_message?: string | null;
};

/** Cents to "$2.04", never with a sign. */
export function payoutDollars(cents: number | null | undefined): string {
  return `$${(Math.abs(Number(cents ?? 0)) / 100).toFixed(2)}`;
}

/** A negative payout is Stripe pulling money from the bank, not sending it. */
export function isDebit(payout: PayoutLike | null | undefined): boolean {
  return Number(payout?.amount ?? 0) < 0;
}

/** Stripe's sentence with its own closing punctuation removed. */
export function cleanStripeReason(message: string | null | undefined): string {
  return String(message ?? "")
    .trim()
    .replace(/[.!\s]+$/, "");
}

export function payoutFailedBody(payout: PayoutLike | null | undefined): string {
  const amount = payoutDollars(payout?.amount);
  const head = isDebit(payout)
    ? `A ${amount} debit from your bank couldn't go through.`
    : `A ${amount} payout couldn't go out to your bank.`;
  const code = String(payout?.failure_code ?? "");
  if (code === "insufficient_funds") {
    return (
      `${head} Your HoundStack balance didn't cover it, so nothing needs changing ` +
      `on the bank side. Stripe tries again once the balance is positive. Check Payments.`
    );
  }
  if (BANK_DETAIL_FAILURES.has(code)) {
    return `${head} Payouts stay stopped until your bank details are fixed. Check Payments.`;
  }
  const reason = cleanStripeReason(payout?.failure_message);
  return `${head}${reason ? ` Stripe says: ${reason}.` : ""} Check Payments for the reason.`;
}

export function payoutAlert(
  payout: PayoutLike | null | undefined,
  failed: boolean,
): { type: "payout_failed" | "payout_paid"; title: string; body: string } {
  const amount = payoutDollars(payout?.amount);
  if (failed) {
    return { type: "payout_failed", title: "A payout failed", body: payoutFailedBody(payout) };
  }
  return isDebit(payout)
    ? {
        type: "payout_paid",
        title: `A ${amount} debit from your bank went through`,
        body: `${amount} was debited from your bank account.`,
      }
    : {
        type: "payout_paid",
        title: `${amount} is on its way to your bank`,
        body: `${amount} has been sent to your bank account.`,
      };
}
