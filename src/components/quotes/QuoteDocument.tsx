// The quote as a document: who it is from, who it is for, the lines, and the
// two totals. Drawn on the customer's page (/q/:token) and on the office's
// read-only view of a sent quote, so what the office looks at is what the
// customer was shown.
//
// Lines are a stacked list, not a table. A quote line has four numbers'
// worth of meaning (description, quantity, unit price, total) and at 320px a
// four-column table either scrolls sideways inside the one page a customer
// ever sees, or crushes the description into a column one word wide. Each
// line is a description that wraps, the arithmetic under it, and the total
// beside it, which is the same shape at every width.
import { QuoteStatusBadge } from "@/components/quotes/QuoteStatusBadge";
import {
  RECURRING_LABEL,
  formatQuantity,
  formatQuoteDay,
  formatQuoteMoney,
  quoteTotals,
} from "@/lib/quotes";

export type QuoteDocumentLine = {
  description: string;
  quantity: number;
  unitAmountCents: number;
  amountCents: number;
  recurring: boolean;
};

export function QuoteDocument({
  orgName,
  label,
  status,
  title,
  recipientName,
  validUntil,
  message,
  lines,
  currency = "usd",
}: {
  orgName: string;
  label: string;
  status: string;
  title: string | null;
  recipientName: string | null;
  validUntil: string | null;
  message: string | null;
  lines: QuoteDocumentLine[];
  currency?: string;
}) {
  const totals = quoteTotals(
    lines.map((l) => ({ amount_cents: l.amountCents, recurring: l.recurring })),
  );
  const money = (c: number) => formatQuoteMoney(c, currency);
  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm sm:p-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="break-words text-lg font-semibold">{orgName}</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">Quote</h1>
          <p className="mt-0.5 font-mono text-sm text-muted-foreground">{label}</p>
        </div>
        <div className="flex flex-col items-start gap-1.5 text-sm sm:items-end">
          <QuoteStatusBadge status={status} />
          {validUntil && (
            <p>
              <span className="text-muted-foreground">Valid until</span>{" "}
              {formatQuoteDay(validUntil)}
            </p>
          )}
        </div>
      </div>

      {(recipientName || title) && (
        <div className="mt-6 space-y-3">
          {recipientName && (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Prepared for
              </p>
              <p className="mt-1 break-words text-sm font-medium">{recipientName}</p>
            </div>
          )}
          {title && (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                For
              </p>
              <p className="mt-1 break-words text-sm font-medium">{title}</p>
            </div>
          )}
        </div>
      )}

      {message && (
        <p className="mt-6 whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 text-sm">
          {message}
        </p>
      )}

      <ul className="mt-6 divide-y border-y">
        {lines.map((l, i) => (
          <li key={`${i}:${l.description}`} className="flex items-start justify-between gap-3 py-3">
            <div className="min-w-0 flex-1">
              <p className="break-words text-sm font-medium">{l.description}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {formatQuantity(l.quantity)} × {money(l.unitAmountCents)}
                {l.recurring ? `, ${RECURRING_LABEL}` : ", one time"}
              </p>
            </div>
            <div className="shrink-0 text-right text-sm font-medium tabular-nums">
              {money(l.amountCents)}
              {l.recurring && (
                <span className="block text-xs font-normal text-muted-foreground">
                  {RECURRING_LABEL}
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>

      <div className="mt-4 flex justify-end">
        <dl className="w-full space-y-2 sm:max-w-xs">
          {totals.oneTimeCount > 0 && (
            <div className="flex items-baseline justify-between gap-3">
              <dt className="min-w-0 text-sm text-muted-foreground">One-time total</dt>
              <dd className="shrink-0 text-lg font-semibold tabular-nums">
                {money(totals.oneTimeCents)}
              </dd>
            </div>
          )}
          {totals.recurringCount > 0 && (
            <div className="flex items-baseline justify-between gap-3">
              <dt className="min-w-0 text-sm text-muted-foreground">
                Recurring, {RECURRING_LABEL}
              </dt>
              <dd className="shrink-0 text-lg font-semibold tabular-nums">
                {money(totals.recurringCents)}
              </dd>
            </div>
          )}
        </dl>
      </div>
    </div>
  );
}
