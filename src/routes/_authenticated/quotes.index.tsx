// Quotes: every price the business has put in writing, and where each one
// stands. See src/lib/quotes.functions.ts for what a quote is and who can see
// it.
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { FileText, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { QuoteStatusBadge } from "@/components/quotes/QuoteStatusBadge";
import { listQuotes } from "@/lib/quotes.functions";
import {
  QUOTE_STATUSES,
  RECURRING_LABEL,
  formatQuoteDay,
  formatQuoteMoney,
  quoteStatusLabel,
  type QuoteStatus,
} from "@/lib/quotes";
import { orgLocalDay } from "@/lib/org-day";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/quotes/")({
  head: () => ({ meta: [{ title: "Quotes · HoundStack" }] }),
  component: QuotesPage,
});

type Filter = QuoteStatus | "all";

function QuotesPage() {
  const list = useServerFn(listQuotes);
  const q = useQuery({ queryKey: ["quotes"], queryFn: () => list() });
  const [filter, setFilter] = useState<Filter>("all");

  const quotes = useMemo(() => q.data?.quotes ?? [], [q.data]);
  // A timestamp read as a day on the business's calendar, not the browser's.
  const onOrgDay = (ts: string) => formatQuoteDay(orgLocalDay(ts, q.data?.timezone));
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: quotes.length };
    for (const s of QUOTE_STATUSES) c[s] = 0;
    for (const x of quotes) c[x.status] = (c[x.status] ?? 0) + 1;
    return c;
  }, [quotes]);
  const shown = filter === "all" ? quotes : quotes.filter((x) => x.status === filter);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">Quotes</h1>
          <p className="text-sm text-muted-foreground">
            A price in writing. The customer accepts or declines it from a link, no password needed.
          </p>
        </div>
        <Button asChild>
          <Link to="/quotes/new">
            <Plus className="mr-1 h-4 w-4 shrink-0" /> New quote
          </Link>
        </Button>
      </div>

      {/* Status chips. They wrap rather than scroll: six short labels fit two
          rows on a 320px phone, and a wrapped row keeps every chip in view. */}
      <div role="group" aria-label="Filter by status" className="flex flex-wrap gap-2">
        {(["all", ...QUOTE_STATUSES] as Filter[]).map((s) => (
          <Button
            key={s}
            type="button"
            size="sm"
            variant={filter === s ? "default" : "outline"}
            aria-pressed={filter === s}
            onClick={() => setFilter(s)}
          >
            {s === "all" ? "All" : quoteStatusLabel(s)}
            <span
              className={cn("tabular-nums", filter === s ? "opacity-80" : "text-muted-foreground")}
            >
              {counts[s] ?? 0}
            </span>
          </Button>
        ))}
      </div>

      {q.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : q.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {(q.error as Error).message}
        </p>
      ) : shown.length === 0 ? (
        <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
          <FileText className="mx-auto mb-2 h-6 w-6 shrink-0" />
          {quotes.length === 0
            ? "No quotes yet. Write one for a client, a lead, or somebody who just called."
            : `No ${quoteStatusLabel(filter).toLowerCase()} quotes.`}
        </div>
      ) : (
        <ul className="space-y-2">
          {shown.map((x) => (
            <li key={x.id}>
              <Link
                to="/quotes/$quoteId"
                params={{ quoteId: x.id }}
                className="flex flex-col gap-2 rounded-lg border bg-card p-4 transition-colors hover:bg-muted/30 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm text-muted-foreground">{x.label}</span>
                    <QuoteStatusBadge status={x.status} />
                    {x.isProspect && (
                      <span className="text-xs text-muted-foreground">Not a client yet</span>
                    )}
                    {x.convertedAt && (
                      <span className="text-xs text-emerald-700 dark:text-emerald-400">
                        Turned into work
                      </span>
                    )}
                  </div>
                  <p className="break-words font-medium">{x.recipientName}</p>
                  {x.title && (
                    <p className="break-words text-sm text-muted-foreground">{x.title}</p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {x.acceptedAt
                      ? `Accepted ${onOrgDay(x.acceptedAt)}`
                      : x.declinedAt
                        ? `Declined ${onOrgDay(x.declinedAt)}`
                        : x.sentAt
                          ? `Sent ${onOrgDay(x.sentAt)}`
                          : `Created ${onOrgDay(x.createdAt)}`}
                    {x.validUntil && x.status !== "accepted" && x.status !== "declined"
                      ? `, valid until ${formatQuoteDay(x.validUntil)}`
                      : ""}
                  </p>
                </div>
                <div className="shrink-0 text-sm tabular-nums sm:text-right">
                  {x.recurringCents > 0 && (
                    <p className="font-semibold">
                      {formatQuoteMoney(x.recurringCents)}{" "}
                      <span className="font-normal text-muted-foreground">{RECURRING_LABEL}</span>
                    </p>
                  )}
                  {x.oneTimeCents > 0 && (
                    <p className={x.recurringCents > 0 ? "text-muted-foreground" : "font-semibold"}>
                      {formatQuoteMoney(x.oneTimeCents)}{" "}
                      <span className="font-normal text-muted-foreground">one time</span>
                    </p>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
