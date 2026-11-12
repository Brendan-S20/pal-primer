// What a stranger reads on the booking link for a one-time cleanup (D12,
// R2-37): the first cleanup and the visit as two lines, then their sum, all
// before the Book and pay button. The sum is oneTimeCleanupTotal's, the same
// addition signupChargeFromQuote charges, so the total read here is the
// amount on the card. Both prices are the owner's (see one-time-cleanup.ts).
//
// Each row is the price panel's own shape: a label that wraps (min-w-0) and
// an amount that keeps its width (shrink-0), so a 46-character tier label at
// 320px pushes its own line taller rather than the amount off the side.
import { ONE_TIME_CLEANUP_COPY, oneTimeCleanupTotal } from "@/lib/one-time-cleanup";

function money(cents: number, currency = "usd") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

export function OneTimeCleanupPriceLines({
  visitCents,
  firstCleanupCents,
  showsFirstCleanup,
  lastCleanedLabel,
  currency,
}: {
  /** The visit, as the server priced it. */
  visitCents: number | null;
  /** The first cleanup, as the server priced it; null while the customer has
   *  not answered "when was your yard last cleaned?". */
  firstCleanupCents: number | null;
  /** False when the owner charges no first cleanup. */
  showsFirstCleanup: boolean;
  /** The answer picked, when priced by tier. */
  lastCleanedLabel: string | null;
  currency: string;
}) {
  const total = oneTimeCleanupTotal({ visitCents, firstCleanupCents });
  return (
    <div className="space-y-3" data-testid="one-time-cleanup-price">
      {showsFirstCleanup && (
        <div className="flex items-baseline justify-between gap-3">
          <div className="min-w-0 text-sm">
            {ONE_TIME_CLEANUP_COPY.firstCleanupLine}
            {lastCleanedLabel && (
              <span className="block break-words text-xs text-muted-foreground">
                Last cleaned: {lastCleanedLabel}
              </span>
            )}
          </div>
          <div className="shrink-0 font-medium">
            {firstCleanupCents == null ? "Answer above" : money(firstCleanupCents, currency)}
          </div>
        </div>
      )}
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0 text-sm">{ONE_TIME_CLEANUP_COPY.visitLine}</div>
        <div className="shrink-0 font-medium">
          {visitCents == null ? "" : money(visitCents, currency)}
        </div>
      </div>
      {total && (
        <div
          className="flex items-baseline justify-between gap-3 border-t pt-3"
          data-testid="one-time-cleanup-total"
        >
          <div className="min-w-0 text-sm font-semibold">{ONE_TIME_CLEANUP_COPY.totalLabel}</div>
          <div className="shrink-0 text-base font-semibold tabular-nums">
            {money(total.totalCents, currency)}
          </div>
        </div>
      )}
    </div>
  );
}
