import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FileText } from "lucide-react";
import {
  describeSettlement,
  settlementMoney,
  type SettlementAudience,
  type SettlementRow,
} from "@/lib/franchise-settlement";

// The settlement statements themselves, for whichever side of the franchise is
// reading them.
//
// One component and one vocabulary for both audiences, for the same reason
// `FranchiseAdjustmentTrail` is built that way: the two parties reconcile the
// SAME statement against two different bank accounts, and if each side read a
// differently-worded version the first disagreement would be about the software
// rather than about the money.
//
// ── WHAT THE HEADLINE FIGURE IS ───────────────────────────────────────────
//
// Net due, not royalty. The royalty is an input to the settlement, not its
// result — under parent-collection the franchise holds the location's revenue
// and owes most of it back, so the row that bills a location $100 and the row
// that owes it $900 have the same royalty on them. The parent's screen used to
// show only that royalty, which is why this exists.
//
// ── NO TABLE, ON PURPOSE ──────────────────────────────────────────────────
//
// Seven columns of money at 360px is the case the working agreement calls out
// by name: dense grids reflow, they do not shrink. A list whose lines wrap
// gives every width the same figures in the same order, so there is no width at
// which a franchisee is reading a truncated version of their own bill.

export type SettlementStatementRow = SettlementRow & {
  counterpartyName?: string | null;
  /** Present on the parent's rows, which span every location. The location's
   *  own query has no use for it — every row it can read is its own. */
  child_organization_id?: string | null;
};

export function FranchiseSettlementStatements({
  rows,
  audience,
  isLoading,
  error,
  onSetStatus,
  isUpdating,
}: {
  rows: SettlementStatementRow[];
  audience: SettlementAudience;
  isLoading?: boolean;
  error?: string | null;
  /** Parent only. Absent for the location, which reads statements and does not
   *  move them — issuing and marking paid are the franchise's acts. */
  onSetStatus?: (id: string, status: "issued" | "paid" | "void") => void;
  isUpdating?: boolean;
}) {
  const forLocation = audience === "location";
  const lines = rows.map((r) => ({ line: describeSettlement(r, audience), row: r }));

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <FileText className="h-4 w-4" /> Settlement statements
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          {forLocation
            ? "Each period your franchise has settled with you, and which way the money goes. Periods still being worked out are not shown until your franchise issues them."
            : "Each period settled with a location. The net is what changes hands — it is not the royalty, because whoever collected the revenue is already holding part of it."}
        </p>
        {/* ── WHERE THE MONEY ACTUALLY MOVES ────────────────────────────────
            Owner decision, 2026-08-16: settlement is a statement, and the
            payment happens outside HoundStack.

            Saying so here is the whole of that decision's UI. "Issue to
            location" followed by "Mark paid" reads like a billing flow, and
            everywhere else in this product a flow shaped like that DOES take
            the money — customer invoices, autopay, add-on subscriptions. A
            franchise owner has no reason to assume this one is different, and
            the consequence of assuming wrongly is that nobody sends the money
            and both sides think it is handled.

            Split by audience because the sentence is about what each side
            should DO, and they do different things: the franchise pays or
            collects, the location watches for it. */}
        <p className="mt-2 text-xs text-muted-foreground">
          {forLocation
            ? "HoundStack records these statements; it does not move the money. Settle with your franchise the way you normally do — the statement is the record of what was owed."
            : "HoundStack records these statements; it does not move the money. Pay or collect the net however you already settle with the location, then mark the statement paid here so both sides have the same record."}
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <p className="text-sm text-destructive">{error}</p>}
        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}

        {!isLoading && !error && lines.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {forLocation
              ? "Your franchise has not issued a settlement statement yet."
              : "No settlement statements yet. Set a royalty rate for each location and generate a period."}
          </p>
        )}

        {lines.length > 0 && (
          <ul className="divide-y text-sm">
            {lines.map(({ line, row }) => (
              <li key={line.id} className="py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      {!forLocation && row.counterpartyName && (
                        <span className="font-medium">{row.counterpartyName}</span>
                      )}
                      <span className={forLocation ? "font-medium" : "text-muted-foreground"}>
                        {line.period}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                      <Badge
                        variant={
                          line.status === "paid"
                            ? "secondary"
                            : line.status === "issued"
                              ? "default"
                              : "outline"
                        }
                      >
                        {line.statusLabel}
                      </Badge>
                      <span className="text-muted-foreground">{line.directionLabel}</span>
                    </div>
                    {/* The arithmetic behind the net, so neither side has to
                        take the headline on trust. Adjustments only when there
                        are some — a location that has never had a refund keeps
                        the shorter sentence. */}
                    <p className="mt-1 text-xs text-muted-foreground">
                      Revenue {settlementMoney(line.revenueCents)} · royalty {line.royaltyPercent}%
                      = {settlementMoney(line.royaltyCents)}
                      {line.adjustmentsCents !== 0 && (
                        <> · adjustments {settlementMoney(line.adjustmentsCents)}</>
                      )}
                    </p>
                  </div>

                  <div className="text-right">
                    <div
                      className={
                        line.flow === "incoming"
                          ? "font-medium text-emerald-600"
                          : line.flow === "outgoing"
                            ? "font-medium text-destructive"
                            : "font-medium"
                      }
                    >
                      {line.flow === "settled"
                        ? "—"
                        : `${line.flow === "incoming" ? "+" : "-"}${settlementMoney(line.netDueCents)}`}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {line.flow === "settled" ? "nothing to move" : "net"}
                    </div>
                  </div>
                </div>

                {onSetStatus && (line.status === "draft" || line.status === "issued") && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {line.status === "draft" && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="max-md:min-h-11"
                        disabled={isUpdating}
                        onClick={() => onSetStatus(line.id, "issued")}
                      >
                        Issue to location
                      </Button>
                    )}
                    {line.status === "issued" && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="max-md:min-h-11"
                        disabled={isUpdating}
                        onClick={() => onSetStatus(line.id, "paid")}
                      >
                        Mark paid
                      </Button>
                    )}
                    {/* Void had no control anywhere, while the Generate toast
                        told the owner in as many words to "void an issued
                        statement to recalculate it" — instructions for a button
                        that did not exist. The server function has accepted
                        'void' all along and a trigger releases the adjustments
                        that were on it. */}
                    {line.status === "issued" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="max-md:min-h-11 text-muted-foreground"
                        disabled={isUpdating}
                        onClick={() => onSetStatus(line.id, "void")}
                      >
                        Void
                      </Button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
