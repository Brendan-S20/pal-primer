import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { FranchiseSettlementStatements } from "@/components/FranchiseSettlementStatements";
import { FranchiseAdjustmentTrail } from "@/components/FranchiseAdjustmentTrail";
import { settlementMoney } from "@/lib/franchise-settlement";
import type { SettlementStatementRow } from "@/components/FranchiseSettlementStatements";
import type { AdjustmentLedgerRow } from "@/lib/franchise-adjustments";
import type { FranchiseRow } from "@/lib/franchise.functions";

// One location, on its own — the drill-down half of BUILD-6.
//
// ── WHY THIS NEEDED NO NEW QUERIES ────────────────────────────────────────
//
// The rollup page already loads every figure this shows: the per-location row
// from `franchise_rollup`, the statements from `listRoyaltyInvoices`, and the
// adjustment ledger. What it did not do was let anyone look at ONE location.
// A franchise owner reconciling a single location's statement had to read it
// out of a table sorted by revenue across every location they own, with that
// location's refunds itemised in a separate list further down the page.
//
// So this is a filter with a heading, deliberately: re-fetching per location
// would put a second set of numbers on the screen that could disagree with the
// first, which is the fault this page has already been fixed for twice.
//
// ── WHAT A PARENT MAY SEE ─────────────────────────────────────────────────
//
// Totals, statements and the money moved between the two organizations. NOT
// clients, visits or staff — /franchise says in as many words "you see their
// totals, not their customers", and a drill-down is exactly where that promise
// would quietly erode if it showed a visit list.

export function FranchiseLocationDrawer({
  row,
  statements,
  adjustments,
  royaltyPercent,
  onOpenChange,
  onSetStatus,
  isUpdating,
}: {
  /** The location being looked at. Null closes the drawer. */
  row: FranchiseRow | null;
  statements: SettlementStatementRow[];
  adjustments: AdjustmentLedgerRow[];
  royaltyPercent: number | null;
  onOpenChange: (open: boolean) => void;
  onSetStatus?: (id: string, status: "issued" | "paid" | "void") => void;
  isUpdating?: boolean;
}) {
  const mine = row ? statements.filter((s) => s.child_organization_id === row.organization_id) : [];
  const myAdjustments = row
    ? adjustments.filter((a) => a.child_organization_id === row.organization_id)
    : [];

  const done = row?.visits_today
    ? Math.round((row.visits_completed_today / row.visits_today) * 100)
    : 0;

  return (
    <Sheet open={!!row} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        {row && (
          <>
            <SheetHeader>
              {/* min-w-0 so a long location name truncates rather than pushing
                  the close button past the edge of a 360px sheet. */}
              <SheetTitle className="min-w-0 truncate pr-8 text-left">
                {row.organization_name}
              </SheetTitle>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {royaltyPercent !== null && (
                  <Badge variant="outline">{royaltyPercent}% royalty</Badge>
                )}
                <span className="text-muted-foreground">
                  {row.tech_count} tech{row.tech_count === 1 ? "" : "s"} · {row.active_clients}{" "}
                  active client{row.active_clients === 1 ? "" : "s"}
                </span>
              </div>
            </SheetHeader>

            <div className="mt-4 space-y-4">
              {/* Two across at every width. Four figures of six or seven
                  characters fit two to a 360px row and do not fit four. */}
              <div className="grid grid-cols-2 gap-3">
                <Figure
                  label={row.refunds_mtd_cents > 0 ? "Net revenue MTD" : "Revenue MTD"}
                  value={settlementMoney(row.revenue_mtd_cents)}
                />
                <Figure label="AR open" value={settlementMoney(row.ar_open_cents)} />
                {row.refunds_mtd_cents > 0 && (
                  <Figure
                    label="Collected MTD"
                    value={settlementMoney(row.revenue_mtd_gross_cents)}
                  />
                )}
                {row.refunds_mtd_cents > 0 && (
                  <Figure
                    label="Refunds MTD"
                    value={`-${settlementMoney(row.refunds_mtd_cents)}`}
                    tone="bad"
                  />
                )}
                <Figure
                  label="Visits today"
                  value={`${row.visits_completed_today}/${row.visits_today}${
                    row.visits_today > 0 ? ` · ${done}%` : ""
                  }`}
                />
              </div>

              <FranchiseSettlementStatements
                rows={mine}
                audience="franchise"
                onSetStatus={onSetStatus}
                isUpdating={isUpdating}
              />

              <FranchiseAdjustmentTrail rows={myAdjustments} audience="franchise" />
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: "bad" }) {
  return (
    <div className="min-w-0 rounded-md border p-3">
      <div className="truncate text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${tone === "bad" ? "text-destructive" : ""}`}>
        {value}
      </div>
    </div>
  );
}
