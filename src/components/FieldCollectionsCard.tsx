// Cash and checks the techs recorded in the field, waiting for the office.
//
// On the Invoices page because that is the money page both billing roles can
// open (Payments is the owner's Stripe account), and because confirming one IS
// recording a payment on invoices: "Confirm and apply" sends the ticked
// invoices through bulkMarkInvoicesPaid with the collection's id, the same
// path the office's Record payment takes, so the result is the same payment
// rows, activity entries and pay-page cancellations. Draws nothing when
// nothing is waiting and nothing was decided in the last two weeks.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Banknote } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import {
  confirmFieldCollectionUnapplied,
  listFieldCollections,
  rejectFieldCollection,
  type FieldCollectionRow,
} from "@/lib/field-collections.functions";
import { bulkMarkInvoicesPaid } from "@/lib/invoices.functions";
import { defaultInvoiceSelection, selectionTotals } from "@/lib/field-collections";
import { describeManualPayment } from "@/lib/manual-payments";
import { invoiceNumberLabel } from "@/lib/invoice-labels";
import { formatDay } from "@/lib/format";
import { orgLocalTime } from "@/lib/org-day";
import { useOrgTimezone } from "@/hooks/useOrgToday";

const money = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

export function FieldCollectionsCard() {
  const listFn = useServerFn(listFieldCollections);
  const q = useQuery({
    queryKey: ["field-collections"],
    queryFn: () => listFn(),
    staleTime: 30_000,
  });
  const rows = q.data?.collections ?? [];
  const waiting = rows.filter((r) => r.status === "awaiting_confirmation");
  const decided = rows.filter((r) => r.status !== "awaiting_confirmation");
  if (rows.length === 0) return null;

  return (
    <section className="rounded-lg border bg-card p-4" aria-labelledby="field-collections-heading">
      <div className="flex min-w-0 items-start gap-2">
        <Banknote className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700" aria-hidden="true" />
        <div className="min-w-0">
          <h2 id="field-collections-heading" className="font-semibold">
            Collected in the field
            {waiting.length > 0 && (
              <span className="ml-2 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-800">
                {waiting.length} waiting
              </span>
            )}
          </h2>
          <p className="text-sm text-muted-foreground">
            Cash and checks your techs recorded at the door. Nothing is applied to an invoice until
            you confirm it here.
          </p>
        </div>
      </div>
      {waiting.length > 0 && (
        <ul className="mt-3 space-y-3">
          {waiting.map((c) => (
            <WaitingCollection key={c.id} c={c} />
          ))}
        </ul>
      )}
      {decided.length > 0 && (
        <details className="mt-3">
          <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium text-muted-foreground">
            Decided in the last two weeks ({decided.length})
          </summary>
          <ul className="mt-1 divide-y text-sm">
            {decided.map((c) => (
              <li key={c.id} className="flex flex-wrap items-baseline justify-between gap-x-3 py-2">
                <span className="min-w-0">
                  <span className="font-medium">{c.client_name}</span>{" "}
                  <span className="text-muted-foreground">
                    {money(c.amount_cents)} · {describeManualPayment(c.method, c.reference)}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {c.status === "confirmed"
                    ? c.applied_cents < c.amount_cents
                      ? `Confirmed · ${money(c.amount_cents - c.applied_cents)} not applied to an invoice`
                      : "Confirmed and applied"
                    : `Rejected${c.decision_note ? `: ${c.decision_note}` : ""}`}
                  {c.decided_by ? ` · by ${c.decided_by}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function WaitingCollection({ c }: { c: FieldCollectionRow }) {
  const qc = useQueryClient();
  const tz = useOrgTimezone();
  const { confirm, dialog } = useConfirmDialog();
  const [selected, setSelected] = useState<string[]>(() =>
    defaultInvoiceSelection(c.open_invoices, c.amount_cents),
  );
  const totals = useMemo(
    () => selectionTotals(c.open_invoices, selected, c.amount_cents),
    [c.open_invoices, selected, c.amount_cents],
  );
  const paidFn = useServerFn(bulkMarkInvoicesPaid);
  const unappliedFn = useServerFn(confirmFieldCollectionUnapplied);
  const rejectFn = useServerFn(rejectFieldCollection);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["field-collections"] });
    qc.invalidateQueries({ queryKey: ["invoices"] });
    qc.invalidateQueries({ queryKey: ["dashboard-summary"] });
    qc.invalidateQueries({ queryKey: ["billing-summary"] });
  };

  const confirmM = useMutation({
    mutationFn: async () => {
      if (selected.length === 0) {
        await unappliedFn({ data: { id: c.id } });
        return { ok: 0, failed: 0, intentStillLive: [] as string[] };
      }
      return paidFn({ data: { ids: selected, fieldCollectionId: c.id } });
    },
    onSuccess: (r) => {
      if (selected.length === 0) toast.success("Confirmed as received. Nothing was applied");
      else if (r.failed > 0)
        toast.warning(
          `Confirmed. ${r.ok} invoice${r.ok === 1 ? "" : "s"} paid, ${r.failed} could not be (already paid or voided)`,
        );
      else toast.success(`Confirmed. ${r.ok} invoice${r.ok === 1 ? "" : "s"} paid`);
      if (r.intentStillLive?.length) {
        toast.warning(
          "A payment link for one of these invoices is still live. Cancel it in Stripe, or the client can still be charged.",
          { duration: 15000 },
        );
      }
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const rejectM = useMutation({
    mutationFn: () => rejectFn({ data: { id: c.id } }),
    onSuccess: () => {
      toast.success("Rejected. Nothing was recorded");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const busy = confirmM.isPending || rejectM.isPending;
  return (
    <li className="rounded-md border p-3">
      {dialog}
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <div className="font-medium [overflow-wrap:anywhere]">{c.client_name}</div>
          <div className="text-sm text-muted-foreground">
            {money(c.amount_cents)} · {describeManualPayment(c.method, c.reference)}
            {c.collected_by ? ` · ${c.collected_by}` : ""}
          </div>
        </div>
        <div className="text-xs text-muted-foreground">
          {formatDay(c.collected_at)} {orgLocalTime(c.collected_at, tz)}
        </div>
      </div>

      {c.open_invoices.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          This customer has no open invoices now. Confirm it as received, or reject it.
        </p>
      ) : (
        <fieldset className="mt-2">
          <legend className="text-xs font-medium text-muted-foreground">Apply to</legend>
          {c.open_invoices.map((inv) => {
            const id = `fc-${c.id}-${inv.id}`;
            return (
              <label
                key={inv.id}
                htmlFor={id}
                className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-1 text-sm"
              >
                <Checkbox
                  id={id}
                  checked={selected.includes(inv.id)}
                  onCheckedChange={(v) =>
                    setSelected((prev) =>
                      v === true ? [...prev, inv.id] : prev.filter((x) => x !== inv.id),
                    )
                  }
                />
                <span className="min-w-0 flex-1">
                  {invoiceNumberLabel(inv)}
                  {inv.due_on ? (
                    <span className="text-muted-foreground"> · due {formatDay(inv.due_on)}</span>
                  ) : null}
                </span>
                <span className="shrink-0 tabular-nums">{money(inv.open_cents)}</span>
              </label>
            );
          })}
          <p
            className={`mt-1 text-xs ${totals.overBy > 0 ? "font-medium text-destructive" : "text-muted-foreground"}`}
          >
            {totals.overBy > 0
              ? `Those come to ${money(totals.overBy)} more than was collected. An invoice is paid in full or not at all.`
              : `Applies ${money(totals.appliedCents)}${
                  totals.unappliedCents > 0
                    ? `. ${money(totals.unappliedCents)} stays unapplied, because an invoice is paid in full or not at all.`
                    : "."
                }`}
          </p>
        </fieldset>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          className="touch:min-h-11"
          disabled={busy || totals.overBy > 0}
          onClick={async () => {
            if (
              selected.length === 0 &&
              !(await confirm({
                title: "Confirm without applying it?",
                description:
                  "It is recorded as received from the customer, and no invoice is marked paid. Use this when it does not cover a whole invoice.",
                confirmLabel: "Confirm as received",
              }))
            )
              return;
            confirmM.mutate();
          }}
        >
          {selected.length === 0 ? "Confirm as received" : "Confirm and apply"}
        </Button>
        <Button
          variant="outline"
          className="touch:min-h-11"
          disabled={busy}
          onClick={async () => {
            if (
              await confirm({
                title: `Reject ${money(c.amount_cents)} from ${c.client_name}?`,
                description:
                  "Nothing is recorded against the customer. Use this when the tech recorded it by mistake.",
                confirmLabel: "Reject",
                destructive: true,
              })
            )
              rejectM.mutate();
          }}
        >
          Reject
        </Button>
      </div>
    </li>
  );
}
