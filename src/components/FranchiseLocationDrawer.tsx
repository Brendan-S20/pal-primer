import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Unlink } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { FranchiseSettlementStatements } from "@/components/FranchiseSettlementStatements";
import { FranchiseAdjustmentTrail } from "@/components/FranchiseAdjustmentTrail";
import { settlementMoney } from "@/lib/franchise-settlement";
import { removeFranchiseLocation } from "@/lib/franchise-membership.functions";
import { getFranchiseRollup } from "@/lib/franchise.functions";
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
  onReopenAsDraft,
  isUpdating,
}: {
  /** The location being looked at. Null closes the drawer. */
  row: FranchiseRow | null;
  statements: SettlementStatementRow[];
  adjustments: AdjustmentLedgerRow[];
  royaltyPercent: number | null;
  onOpenChange: (open: boolean) => void;
  onSetStatus?: (id: string, status: "issued" | "paid" | "void") => void;
  /** Reopening is deliberately a SEPARATE callback rather than a fourth value
   *  on `onSetStatus`. `FranchiseSettlementStatements` offers the control only
   *  when handed this prop AND only on a void row, and keeping the union at
   *  three values is what stops a caller reopening an issued or paid statement
   *  by passing "draft" to the ordinary status setter. */
  onReopenAsDraft?: (id: string) => void;
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
      {/* The safe-area insets and the close button's offset come from
          ui/sheet.tsx, which gives them to every full-height sheet. */}
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
                onReopenAsDraft={onReopenAsDraft}
                isUpdating={isUpdating}
              />

              <FranchiseAdjustmentTrail rows={myAdjustments} audience="franchise" />

              <RemoveLocation row={row} onDone={() => onOpenChange(false)} />
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ── Removing a location ─────────────────────────────────────────────────────
//
// `unlink_franchise_child` shipped on 2026-07-30 and nothing has called it
// since: its wrapper was deleted on 2026-08-07 because it hung a destructive,
// cross-organization action off a row in a REPORTING table. Ending a franchise
// link was therefore not possible from inside the product at all — a franchise
// that wanted a location out had to ask HoundStack support to run the RPC by
// hand. That is the gap this closes, and the reason it is closed HERE.
//
// This drawer is the only screen in the product that is about ONE named
// location. That is what a removal needs: a person doing this has already
// chosen which location and is looking at its statements and its money while
// they decide, rather than aiming at the sixth line of a table sorted by
// revenue.
//
// ── WHY IT IS LAST, AND FENCED ────────────────────────────────────────────
//
// Everything above is reading. This is the one control in the drawer that
// changes anything, it cannot be undone from this screen, and it affects an
// organization that is not the one the person is signed in to. It sits below
// the reading, inside its own border, behind a confirmation that names the
// location and lists what actually happens — and asks for the name to be
// typed, the bar this product already sets for deleting a tenant.
//
// ── THE PARENT'S OWN ROW IS NOT A LOCATION ────────────────────────────────
//
// franchise_rollup returns the franchise's own numbers as the first row, so
// this drawer opens on the parent too. `unlink_franchise_child` would refuse
// it ("That organization is not part of a franchise") and so would
// removeFranchiseLocation, but offering a control that can only fail is its
// own defect. The parent's id comes from the SAME react-query key the rollup
// table is drawn from — the same cache entry, not a second answer to the
// question, which is the rule this drawer was built on. Until that answer is
// in hand the section does not render, so the failure direction is "no button"
// rather than "a button on the wrong row".
function RemoveLocation({ row, onDone }: { row: FranchiseRow; onDone: () => void }) {
  const qc = useQueryClient();
  const rollupFn = useServerFn(getFranchiseRollup);
  const removeFn = useServerFn(removeFranchiseLocation);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");

  // staleTime Infinity so this observer never triggers a fetch of its own: the
  // table that opened this drawer was drawn from this very cache entry, so the
  // answer is already there, and re-requesting it on every drawer open would be
  // the "second set of numbers" this component was built to avoid. The queryFn
  // is the fallback for the case the cache is somehow cold, not the normal
  // path.
  const rollup = useQuery({
    queryKey: ["franchise", "rollup"],
    queryFn: () => rollupFn(),
    staleTime: Infinity,
  });
  const parentOrgId = rollup.data?.parentOrgId ?? null;
  const isLocation = !!parentOrgId && parentOrgId !== row.organization_id;

  const remove = useMutation({
    mutationFn: () =>
      removeFn({ data: { organizationId: row.organization_id, confirmName: typed.trim() } }),
    onSuccess: (r) => {
      toast.success(`${r.name} is no longer part of this franchise.`);
      setOpen(false);
      setTyped("");
      // Every panel on this page is keyed under "franchise" and every one of
      // them changes: the location leaves the rollup, the trend, the royalty
      // rate list and payment routing. The drawer then closes, because the
      // location it was about is gone from the table behind it.
      qc.invalidateQueries({ queryKey: ["franchise"] });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!isLocation) return null;

  const nameMatches = typed.trim() === row.organization_name.trim();

  return (
    <div className="rounded-md border border-destructive/40 p-3">
      {/* min-w-0 on the text column: a long location name in the sentence below
          would otherwise set the width of this row and push the button off the
          side of a 360px sheet. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="text-sm font-medium">Remove from franchise</div>
          <p className="mt-1 text-xs text-muted-foreground">
            Ends this location&apos;s membership. Statements already issued stay on both sides.
            Removing a location is not a way to clear what was owed.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0 text-destructive hover:text-destructive touch:min-h-11"
          onClick={() => setOpen(true)}
        >
          <Unlink className="mr-2 h-4 w-4 shrink-0" /> Remove
        </Button>
      </div>

      <AlertDialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setTyped("");
        }}
      >
        {/* Taller than the tenant-delete dialog because it says more, so it
            scrolls inside itself rather than running off a phone screen. */}
        <AlertDialogContent className="max-h-[85vh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle className="break-words">
              Remove {row.organization_name} from this franchise?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This ends the franchise link between your organization and {row.organization_name}. It
              cannot be undone from this screen.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {/* Outside AlertDialogDescription, which renders a <p>. The list is
              the substance of the warning, not decoration: an owner who has
              never done this has no way to know which of these are true, and
              the two that surprise people — the history is KEPT, and the
              location is not told — are the two worth reading. */}
          {/* break-words: a location name is user-supplied and can be one long
              unbroken token, which would otherwise set the width of the dialog. */}
          <ul className="list-disc space-y-1 break-words pl-5 text-sm text-muted-foreground">
            <li>
              {row.organization_name} stops rolling up here. Its {row.active_clients} active client
              {row.active_clients === 1 ? "" : "s"}, its visits, its revenue and its open balances
              leave this page immediately.
            </li>
            <li>
              Its royalty rate is set back to 0% and no further royalty accrues. No new settlement
              statement will be generated for it.
            </li>
            <li>
              Statements and adjustments already raised are kept, on both sides. Anything still
              unpaid is still owed.
            </li>
            <li>
              {row.organization_name} keeps its own clients, invoices, staff and history and carries
              on as an independent organization. You lose access to its numbers.
            </li>
            <li>
              HoundStack does not tell them. If this is not something they are expecting, tell them
              yourself.
            </li>
            <li>
              To link them again later you issue a new invitation code and their owner redeems it,
              so they have to agree a second time.
            </li>
          </ul>

          <div className="space-y-1">
            <Label htmlFor="confirm-location-name" className="block break-words text-xs">
              Type <span className="font-medium text-foreground">{row.organization_name}</span> to
              confirm
            </Label>
            <Input
              id="confirm-location-name"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={row.organization_name}
              autoComplete="off"
              className="touch:min-h-11"
            />
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel className="touch:min-h-11">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 touch:min-h-11"
              disabled={!nameMatches || remove.isPending}
              onClick={(e) => {
                // The dialog closes itself on action; hold it open until the
                // server has answered, so a failure is read on the screen that
                // caused it rather than behind a drawer that already shut.
                e.preventDefault();
                remove.mutate();
              }}
            >
              {remove.isPending ? "Removing…" : "Remove location"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
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
