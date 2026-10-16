// What a money surface shows when its read fails: a sentence and a Retry.
//
// The alternative it replaces was worse in both directions. A figure computed
// from `data ?? []` prints $0.00, which an owner reads as "nobody owes me
// anything"; a `isLoading || !data ? "Loading..." : ...` spins forever after
// an error, because an errored query is no longer loading and still has no
// data. Retry is `refetch()`, not a route reset: the app has no
// QueryErrorResetBoundary, so a query thrown to the root boundary would throw
// again on remount instead of asking the server a second time.
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function LoadError({
  what,
  onRetry,
  retrying = false,
  className,
}: {
  /** Lower-case noun phrase: "your invoices", "this invoice". */
  what: string;
  onRetry: () => void;
  retrying?: boolean;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm",
        className,
      )}
    >
      <p className="min-w-0 text-destructive">Couldn't load {what}.</p>
      <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
        {retrying ? "Retrying…" : "Retry"}
      </Button>
    </div>
  );
}
