// "Record refund" on a cash or check payment, and the dialog behind it
// (#653, F-09). The Stripe Refund button (RefundPaymentAction) cannot give
// back money that never went through Stripe, so until this the office had no
// way to record a bounced check or cash handed back.
//
// Two steps, like the Stripe refund: the form collects what happened, how
// much and why (the why is required), and the second step says in one
// sentence what will be recorded, with the only button that records it.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Undo2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { usePermissions } from "@/hooks/useMyRole";
import {
  MANUAL_REFUND_REASON_MAX,
  canRecordManualRefund,
  manualRefundReasonProblem,
  parseRefundAmount,
  type ManualRefundKind,
  type RefundablePaymentRow,
} from "@/lib/refunds";
import { recordManualRefund } from "@/lib/refunds.functions";

function fmt(cents: number, currency = "usd") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: (currency || "usd").toUpperCase(),
  }).format(cents / 100);
}

const KIND_LABELS: Record<ManualRefundKind, { title: string; help: string }> = {
  refund: {
    title: "I gave the money back",
    help: "Cash or a check returned to the client. The invoice keeps its status.",
  },
  reversal: {
    title: "The payment didn't go through",
    help: "A bounced check, or a payment recorded by mistake. The invoice is owed again.",
  },
};

export function ManualRefundAction({
  payment,
  invoiceId,
  currency,
  customerName,
  onRecorded,
}: {
  payment: RefundablePaymentRow & { id: string };
  invoiceId: string;
  currency?: string | null;
  customerName?: string | null;
  onRecorded?: () => void;
}) {
  const { role } = usePermissions();
  const [open, setOpen] = useState(false);
  if (!canRecordManualRefund(role, payment)) return null;
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="shrink-0"
        onClick={() => setOpen(true)}
      >
        <Undo2 className="mr-1 h-3.5 w-3.5 shrink-0" aria-hidden />
        Record refund
      </Button>
      {open && (
        <ManualRefundDialog
          paymentId={payment.id}
          paidCents={payment.amount_cents ?? 0}
          invoiceId={invoiceId}
          currency={currency ?? "usd"}
          customerName={customerName ?? null}
          onClose={() => setOpen(false)}
          onRecorded={onRecorded}
        />
      )}
    </>
  );
}

function ManualRefundDialog({
  paymentId,
  paidCents,
  invoiceId,
  currency,
  customerName,
  onClose,
  onRecorded,
}: {
  paymentId: string;
  paidCents: number;
  invoiceId: string;
  currency: string;
  customerName: string | null;
  onClose: () => void;
  onRecorded?: () => void;
}) {
  const qc = useQueryClient();
  const recordFn = useServerFn(recordManualRefund);
  const [step, setStep] = useState<"form" | "confirm">("form");
  const [kind, setKind] = useState<ManualRefundKind>("refund");
  const [amountText, setAmountText] = useState((paidCents / 100).toFixed(2));
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const amountCents = parseRefundAmount(amountText);
  const who = customerName || "the client";

  const recordM = useMutation({
    mutationFn: () =>
      recordFn({
        data: { paymentId, amountCents: amountCents ?? 0, reason: reason.trim(), kind },
      }),
    onSuccess: (r) => {
      toast.success(
        kind === "reversal"
          ? `Recorded: ${fmt(r.amountCents, currency)} did not go through.${r.reopened ? " The invoice is open again." : ""}`
          : `Recorded: ${fmt(r.amountCents, currency)} given back to ${who}.`,
      );
      qc.invalidateQueries({ queryKey: ["invoice", invoiceId] });
      qc.invalidateQueries({ queryKey: ["invoice-detail", invoiceId] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["billing-summary"] });
      onRecorded?.();
      onClose();
    },
    onError: (e: Error) => {
      setError(e.message);
      setStep("form");
    },
  });

  function review() {
    if (amountCents == null || amountCents < 1) {
      setError("Enter an amount in dollars and cents, like 45.00.");
      return;
    }
    if (amountCents > paidCents) {
      setError(`The most you can record on this payment is ${fmt(paidCents, currency)}.`);
      return;
    }
    const problem = manualRefundReasonProblem(reason);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setStep("confirm");
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !recordM.isPending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{step === "confirm" ? "Confirm" : "Record a refund"}</DialogTitle>
          <DialogDescription>
            {step === "form"
              ? `This payment of ${fmt(paidCents, currency)} was not taken through Stripe, so nothing is sent from here. Record what happened.`
              : "This is recorded on the invoice and in your reports, and can't be undone."}
          </DialogDescription>
        </DialogHeader>

        {step === "form" && (
          <form
            className="min-w-0 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              review();
            }}
          >
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">What happened</legend>
              {(Object.keys(KIND_LABELS) as ManualRefundKind[]).map((k) => (
                <label
                  key={k}
                  className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md border p-3 text-sm"
                >
                  <input
                    type="radio"
                    name="manual-refund-kind"
                    className="mt-0.5 h-4 w-4 shrink-0"
                    checked={kind === k}
                    onChange={() => setKind(k)}
                  />
                  <span className="min-w-0">
                    <span className="block font-medium">{KIND_LABELS[k].title}</span>
                    <span className="block text-xs text-muted-foreground">
                      {KIND_LABELS[k].help}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>

            <div>
              <Label htmlFor="manual-refund-amount">Amount</Label>
              <div className="relative mt-1">
                <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground">
                  $
                </span>
                <Input
                  id="manual-refund-amount"
                  className="pl-7 tabular-nums"
                  inputMode="decimal"
                  autoComplete="off"
                  value={amountText}
                  onChange={(e) => {
                    setAmountText(e.target.value);
                    setError(null);
                  }}
                />
              </div>
            </div>

            <div>
              <Label htmlFor="manual-refund-reason">Reason</Label>
              <Textarea
                id="manual-refund-reason"
                className="mt-1"
                rows={2}
                maxLength={MANUAL_REFUND_REASON_MAX}
                placeholder={
                  kind === "reversal"
                    ? "Check 1042 bounced"
                    : "Returned at the door, service missed"
                }
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  setError(null);
                }}
              />
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit">Review</Button>
            </DialogFooter>
          </form>
        )}

        {step === "confirm" && amountCents != null && (
          <div className="min-w-0 space-y-4">
            <p className="text-base">
              {kind === "reversal" ? (
                <>
                  Record that{" "}
                  <span className="font-semibold tabular-nums">{fmt(amountCents, currency)}</span>{" "}
                  from <span className="break-words font-semibold">{who}</span> did not go through?
                </>
              ) : (
                <>
                  Record{" "}
                  <span className="font-semibold tabular-nums">{fmt(amountCents, currency)}</span>{" "}
                  given back to <span className="break-words font-semibold">{who}</span>?
                </>
              )}
            </p>
            <p className="break-words text-sm text-muted-foreground">Reason: {reason.trim()}</p>
            <DialogFooter className="gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={recordM.isPending}
                onClick={() => setStep("form")}
              >
                Back
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={recordM.isPending}
                onClick={() => recordM.mutate()}
              >
                {recordM.isPending ? "Recording…" : "Record it"}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
