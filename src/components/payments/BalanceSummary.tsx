import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { formatDay } from "@/lib/format";
import {
  PAYMENTS_FETCH_TIMEOUT_MS,
  STRIPE_DID_NOT_ANSWER,
  balanceSummaryState,
  withTimeout,
  type BalanceSummaryData,
} from "@/lib/payments-load";

/**
 * The headline the Money tab exists to give: how much is available now, how
 * much is still clearing, and when the last payout lands.
 *
 * Rendered above the embedded components rather than instead of them. They own
 * the detail — per-currency breakdown, the payout history, changing the
 * schedule — but each is an iframe that fetches on its own, so the one number
 * an owner opens this page for arrived last and moved the layout when it did.
 *
 * Its own file (#922) so the error state can be rendered in a test. The fetch
 * is passed in (the route hands it useServerFn(getStripeBalanceSummary)).
 */
export function BalanceSummary({
  fetchSummary,
}: {
  fetchSummary: () => Promise<BalanceSummaryData>;
}) {
  const q = useQuery({
    queryKey: ["stripe-balance"],
    // A deadline, and one retry rather than React Query's three with backoff:
    // "Loading balance…" is never the last thing this card says (#436).
    queryFn: () => withTimeout(fetchSummary(), PAYMENTS_FETCH_TIMEOUT_MS, STRIPE_DID_NOT_ANSWER),
    retry: 1,
  });
  type Ready = {
    available?: Array<{ amount: number; currency: string }>;
    pending?: Array<{ amount: number; currency: string }>;
    lastPayout?: {
      amount: number;
      currency: string;
      status: string;
      arrivalDate: number | null;
    } | null;
  };
  const d = (q.data ?? {}) as Ready;
  const view = balanceSummaryState(q);

  if (view.kind === "loading") {
    return (
      <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
        Loading balance…
      </div>
    );
  }
  // Said, not swallowed (#436), and said in our words (#922). It used to read
  // "Couldn't load your balance." followed by whatever Stripe answered, which
  // on the demo business was a paragraph about Connect platforms and client_id
  // parameters with a Dashboard link. view.message is always
  // BALANCE_UNAVAILABLE; Stripe's reason is in the server log.
  //
  // One card, in the slot the figures would have taken, laid out as one row
  // (message, then Try again) so it is no taller than the figures it stands in
  // for: Balance and Payouts below sit where they always do, and appear once.
  // Muted rather than red: it is one figure we could not fetch, not money
  // gone wrong.
  if (view.kind === "error") {
    return (
      <div
        role="alert"
        data-balance-summary="error"
        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4 text-sm"
      >
        <p className="min-w-0 flex-1 basis-64 text-muted-foreground">{view.message}</p>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => q.refetch()}
          disabled={q.isFetching}
        >
          {q.isFetching ? "Retrying…" : "Try again"}
        </Button>
      </div>
    );
  }
  if (view.kind === "not-connected") return null;

  const fmt = (amount: number, currency: string) =>
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(amount / 100);

  const avail = d.available ?? [];
  const pending = d.pending ?? [];

  return (
    <div
      data-balance-summary="ready"
      className="grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-3"
    >
      <div>
        <div className="text-2xs uppercase tracking-wide text-muted-foreground">Available now</div>
        <div className="text-xl font-semibold">
          {avail.length ? avail.map((b) => fmt(b.amount, b.currency)).join(" · ") : "—"}
        </div>
      </div>
      <div>
        <div className="text-2xs uppercase tracking-wide text-muted-foreground">Still clearing</div>
        {/* Kept separate from "available" rather than summed. A single total
            overstates what can actually be drawn today, which is the number
            somebody opens this page to find. */}
        <div className="text-xl font-semibold text-muted-foreground">
          {pending.length ? pending.map((b) => fmt(b.amount, b.currency)).join(" · ") : "—"}
        </div>
      </div>
      <div>
        <div className="text-2xs uppercase tracking-wide text-muted-foreground">Latest payout</div>
        {d.lastPayout ? (
          <div className="text-sm">
            <span className="font-semibold">{fmt(d.lastPayout.amount, d.lastPayout.currency)}</span>
            <span className="ml-1.5 text-muted-foreground">{d.lastPayout.status}</span>
            {d.lastPayout.arrivalDate && (
              // "Expected" because arrival_date is Stripe's estimate, not a
              // commitment from the bank. Presenting it flat would make us
              // answerable for a date we do not control.
              <div className="text-2xs text-muted-foreground">
                Expected {formatDay(new Date(d.lastPayout.arrivalDate).toISOString())}
              </div>
            )}
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">None yet</div>
        )}
      </div>
    </div>
  );
}
