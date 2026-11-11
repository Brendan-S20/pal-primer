import { Badge } from "@/components/ui/badge";
import { quoteStatusLabel } from "@/lib/quotes";

/**
 * The invoice badge's palette, carried over so a quote and an invoice in the
 * same state read the same colour: green is a yes, blue is waiting on the
 * customer, red is a no, amber is lapsed, grey is still the office's.
 */
const STYLES: Record<string, string> = {
  draft: "border-transparent bg-muted text-muted-foreground hover:bg-muted",
  sent: "border-transparent bg-blue-500/15 text-blue-700 dark:text-blue-400 hover:bg-blue-500/15",
  accepted:
    "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/15",
  declined: "border-transparent bg-destructive/10 text-destructive hover:bg-destructive/10",
  expired:
    "border-transparent bg-amber-500/15 text-amber-800 dark:text-amber-400 hover:bg-amber-500/15",
};

export function QuoteStatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="secondary" className={STYLES[status] ?? ""}>
      {quoteStatusLabel(status)}
    </Badge>
  );
}
