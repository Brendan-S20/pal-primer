import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeftRight, Receipt, AlertTriangle } from "lucide-react";
import { summariseLedger, centsToUsd, type AdjustmentLedgerRow } from "@/lib/franchise-adjustments";

// BUG-26 readback — the settlement's adjustment lines, and the link between a
// deduction and the repayment that cancelled it.
//
// One component, both audiences, on purpose. A franchise owner and a franchisee
// have to reconcile the SAME statement against two different bank accounts; if
// each side read a differently-worded version of the trail, the first
// disagreement would be about the software rather than the money.
//
// `audience` changes only the framing ("this location" vs "your"), never the
// figures.

export function FranchiseAdjustmentTrail({
  rows,
  audience,
  isLoading,
  error,
}: {
  rows: AdjustmentLedgerRow[];
  audience: "franchise" | "location";
  isLoading?: boolean;
  error?: string | null;
}) {
  const summary = summariseLedger(rows);
  const forLocation = audience === "location";

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <ArrowLeftRight className="h-4 w-4 shrink-0" /> Deductions &amp; repayments
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          {forLocation
            ? "Every refund and chargeback your franchise has settled with you, and (when a dispute was won) the repayment that cancelled it."
            : "Every refund and chargeback carried onto a location's settlement, and the repayment that cancelled it when a dispute was won."}
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <p className="text-sm text-destructive">{error}</p>}
        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}

        {!isLoading && !error && summary.lines.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No refunds or chargebacks have been settled
            {forLocation ? " against this location" : " for any location"} yet.
          </p>
        )}

        {summary.lines.length > 0 && (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <Figure
                label={forLocation ? "Deducted from you" : "Deducted from locations"}
                value={`-${centsToUsd(summary.deductedCents)}`}
                tone={summary.deductedCents > 0 ? "bad" : undefined}
              />
              <Figure
                label="Repaid after a win"
                value={summary.repaidCents > 0 ? `+${centsToUsd(summary.repaidCents)}` : "—"}
                tone={summary.repaidCents > 0 ? "good" : undefined}
              />
              <Figure
                label="Not yet on a statement"
                value={
                  summary.openCents === 0
                    ? "—"
                    : `${summary.openCents < 0 ? "-" : "+"}${centsToUsd(summary.openCents)}`
                }
              />
            </div>

            {summary.needsAttentionCount > 0 && (
              <div className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <p>
                  {summary.needsAttentionCount === 1
                    ? "One deduction was reversed after it had already been billed, and no repayment has been raised for it."
                    : `${summary.needsAttentionCount} deductions were reversed after they had already been billed, and no repayment has been raised for them.`}{" "}
                  {forLocation
                    ? "Your franchise should be able to explain this one."
                    : "Nothing has given that money back yet."}
                </p>
              </div>
            )}

            <ul className="divide-y text-sm">
              {summary.lines.map((line) => (
                <li key={line.id} className="py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <span className="font-medium">{line.kindLabel}</span>
                      {!forLocation && (
                        <span className="ml-2 text-muted-foreground">{line.locationName}</span>
                      )}
                      {line.disputeRef && (
                        <span className="ml-2 font-mono text-xs text-muted-foreground">
                          {line.disputeRef}
                        </span>
                      )}
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                        <Badge variant={line.isRepayment ? "secondary" : "outline"}>
                          {line.stateLabel}
                        </Badge>
                        {line.billedPeriod && !line.isRepayment && (
                          <span className="inline-flex items-center gap-1 text-muted-foreground">
                            <Receipt className="h-3 w-3 shrink-0" /> {line.billedPeriod}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="text-right">
                      <div
                        className={
                          line.effectCents < 0
                            ? "font-medium text-destructive"
                            : "font-medium text-emerald-600"
                        }
                      >
                        {line.effectCents < 0 ? "-" : "+"}
                        {centsToUsd(line.effectCents)}
                      </div>
                      {/* The gross event, when it differs from what actually
                          moved on the settlement — a location that collected
                          its own money already absorbed the rest. */}
                      {Math.abs(line.effectCents) !== line.amountCents && (
                        <div className="text-xs text-muted-foreground">
                          of {centsToUsd(line.amountCents)}
                        </div>
                      )}
                    </div>
                  </div>

                  {line.trail && (
                    <p
                      className={`mt-1 text-xs ${
                        line.needsAttention ? "text-amber-600" : "text-muted-foreground"
                      }`}
                    >
                      {line.trail}
                    </p>
                  )}
                  {line.note && !line.trail && (
                    <p className="mt-1 text-xs text-muted-foreground">{line.note}</p>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div
        className={`mt-1 text-lg font-semibold ${
          tone === "bad" ? "text-destructive" : tone === "good" ? "text-emerald-600" : ""
        }`}
      >
        {value}
      </div>
    </div>
  );
}
