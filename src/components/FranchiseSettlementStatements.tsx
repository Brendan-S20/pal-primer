import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FileText } from "lucide-react";
import {
  describeSettlement,
  settlementMoney,
  settlementSignedMoney,
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
  onReopenAsDraft,
  isUpdating,
}: {
  rows: SettlementStatementRow[];
  audience: SettlementAudience;
  isLoading?: boolean;
  error?: string | null;
  /** Parent only. Absent for the location, which reads statements and does not
   *  move them — issuing and marking paid are the franchise's acts. */
  onSetStatus?: (id: string, status: "issued" | "paid" | "void") => void;
  /** Parent only, and separate from `onSetStatus` on purpose.
   *
   *  Reopening is not another status transition of the same kind: the other
   *  three move a statement FORWARD along the settlement it describes, and this
   *  one puts a finished statement back on the workbench. Keeping it its own
   *  callback also keeps `onSetStatus`'s union as it was, so the surfaces that
   *  offer only the forward moves — the per-location drawer — keep compiling
   *  unchanged rather than gaining a control their own state does not handle. */
  onReopenAsDraft?: (id: string) => void;
  isUpdating?: boolean;
}) {
  const forLocation = audience === "location";
  const lines = rows.map((r) => ({ line: describeSettlement(r, audience), row: r }));

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <FileText className="h-4 w-4 shrink-0" /> Settlement statements
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          {forLocation
            ? "Each period your franchise has settled with you, and which way the money goes. Periods still being worked out are not shown until your franchise issues them."
            : "Each period settled with a location. The net is what changes hands. It is not the royalty, because whoever collected the revenue is already holding part of it."}
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
            ? "HoundStack records these statements; it does not move the money. Settle with your franchise the way you normally do. The statement is the record of what was owed."
            : "HoundStack records these statements; it does not move the money. Pay or collect the net however you already settle with the location, then mark the statement paid here so both sides have the same record."}
        </p>
        {/* ── WHAT THE PERCENTAGE IS A PERCENTAGE OF ────────────────────────
            Owner decision, 2026-08-19: the royalty stays on GROSS, and the
            product says so.

            `revenue_cents` is sum(payments.amount_cents) for the period. That
            figure already excludes the card surcharge — correct, it was fee
            recovery and was never revenue — but it is gross of Stripe's
            processing fee. So a location keeps less than "collected revenue"
            and is billed a percentage of the whole of it.

            HoundStack's 0.5% platform fee was named here as a second deduction
            until 2026-09-08. PLATFORM_FEE_BPS is now 0, so it is not one. Both
            copies of this sentence are checked against the constant rather than
            against a fixed string, so the rate coming back puts the words back.

            That is the arrangement, not a defect, and nothing about the
            arithmetic changes. What was missing is that neither party could
            read it anywhere: a franchisee reconciling a statement against what
            landed in their bank account finds a deduction the statement never
            mentions, and the first time they notice is an argument. Said on
            both sides' copy, in the same words, because the two reconcile the
            same document. */}
        <p className="mt-2 text-xs text-muted-foreground">
          The percentage applies to collected revenue before fees. Stripe&apos;s processing fee comes
          out of what {forLocation ? "you receive" : "the location receives"}, and the royalty is
          calculated on the amount collected, not on what is left after it.
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
                        take the headline on trust. Three things about this line
                        were wrong, and all three were of the kind that leaves a
                        plausible number on the screen:

                        "Revenue" — the rollup on the same page uses that word
                        for a figure NET of the month's refunds and calls the
                        gross "Collected". This figure is the gross:
                        sum(payments.amount_cents) for every payment that
                        arrived, refunded ones included, with reversals carried
                        separately as adjustments. Two screens a franchise owner
                        reads together, one word, two meanings.

                        The adjustment ran through `settlementMoney`, which
                        takes an absolute value — right for the net, whose
                        direction is carried by `direction`, and wrong here,
                        where a negative is the franchise absorbing a reversal.
                        A credit printed as a charge.

                        And the collector split was never shown, so on a period
                        the franchise collected part of, the net followed from
                        none of the figures beside it:
                        net = |collected_by_franchise − royalty − adjustments|.

                        Each component appears only when it says something — a
                        location that has never had a refund and collects its
                        own money keeps the short sentence it already had. */}
                    <p className="mt-1 text-xs text-muted-foreground">
                      Collected revenue {settlementMoney(line.revenueCents)} · royalty{" "}
                      {line.royaltyPercent}% = {settlementMoney(line.royaltyCents)}
                      {line.collectedByFranchiseCents !== null &&
                        line.collectedByFranchiseCents > 0 && (
                          <>
                            {" "}
                            · of which the franchise collected{" "}
                            {settlementMoney(line.collectedByFranchiseCents)}
                          </>
                        )}
                      {line.adjustmentsCents !== 0 && (
                        <> · adjustments {settlementSignedMoney(line.adjustmentsCents)}</>
                      )}
                      {/* Sales tax the franchise collected for the location:
                          the location's to remit, so passed on whole and never
                          in the royalty. Absent when there is none. */}
                      {line.taxHeldByFranchiseCents > 0 && (
                        <>
                          {" "}
                          · plus sales tax the franchise collected{" "}
                          {settlementMoney(line.taxHeldByFranchiseCents)}
                        </>
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

                {/* ── REOPENING A VOIDED STATEMENT ──────────────────────────
                    Owner decision, 2026-08-19: voiding and reopening are two
                    deliberate acts.

                    Void was a one-way door. The row keeps `status = 'void'`,
                    the unique key (child, period_start, period_end) stays
                    occupied, and the generator's `ON CONFLICT … DO UPDATE …
                    WHERE status = 'draft'` refuses to write over it — so
                    regenerating that period wrote nothing and returned 0,
                    while the Generate toast told the owner in as many words to
                    "void an issued statement to recalculate it". An
                    instruction for something the software cannot do.

                    Meanwhile the void trigger had already released the
                    statement's adjustments back to `pending`, so they were
                    sitting there waiting to be swept onto whatever period got
                    generated next — a July chargeback landing on September's
                    statement because July's was voided and could never be cut
                    again.

                    Reopening needs no migration: setRoyaltyInvoiceStatus has
                    accepted and authorised 'draft' all along. It lands the row
                    back in the one state the generator is allowed to rewrite,
                    and — because a draft is a draft — the figures are visible
                    and re-issuable rather than being recomputed silently on
                    the way out. */}
                {onReopenAsDraft && line.status === "void" && (
                  <div className="mt-2 space-y-2">
                    <p className="text-xs text-muted-foreground">
                      Voided. Reopening puts this period back in draft so it can be regenerated and
                      issued again. The adjustments this statement had claimed were released when
                      it was voided, and regenerating draws whichever of them are still outstanding
                      back onto it.
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="touch:min-h-11"
                      disabled={isUpdating}
                      onClick={() => onReopenAsDraft(line.id)}
                    >
                      Reopen as draft
                    </Button>
                  </div>
                )}

                {onSetStatus && (line.status === "draft" || line.status === "issued") && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {line.status === "draft" && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="touch:min-h-11"
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
                        className="touch:min-h-11"
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
                        className="touch:min-h-11 text-muted-foreground"
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
