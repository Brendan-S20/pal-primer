// "Refund" on a payment row, and the dialog behind it.
//
// Used on both invoice surfaces — the full invoice page and the invoice drawer
// the invoices list and the client Billing tab open — because a phone reaches
// the drawer first, and the phone is the reason this exists: Stripe's own
// refund control on /payments is replaced by NotOnAPhone on a coarse pointer.
//
// Two steps, on purpose. The first collects the amount, a reason and a note;
// the second states, in one sentence, the exact dollars going back and to
// whom, with the only button that moves money. A refund cannot be taken back,
// and a single-step form puts "Refund" one mis-tap from the amount field.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePermissions } from "@/hooks/useMyRole";
import {
  REFUND_NOTE_MAX,
  REFUND_REASONS,
  REFUND_REASON_LABELS,
  canOfferRefund,
  parseRefundAmount,
  type RefundReason,
  type RefundablePaymentRow,
} from "@/lib/refunds";
import { getPaymentRefundQuote, refundInvoicePayment } from "@/lib/refunds.functions";
import { splitRefund } from "@/lib/refund-split";

function fmt(cents: number, currency = "usd") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: (currency || "usd").toUpperCase(),
  }).format(cents / 100);
}

function newAttemptId(): string {
  // Every supported browser and the iOS/Android webviews have it; the fallback
  // is for an old embedded webview, where a collision within one dialog is the
  // only thing that matters and cannot happen.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const h = () =>
    Math.floor(Math.random() * 0x10000)
      .toString(16)
      .padStart(4, "0");
  return `${h()}${h()}-${h()}-4${h().slice(1)}-a${h().slice(1)}-${h()}${h()}${h()}`;
}

export function RefundPaymentAction({
  payment,
  invoiceId,
  currency,
  customerName,
  onRefunded,
}: {
  payment: RefundablePaymentRow & { id: string };
  invoiceId: string;
  currency?: string | null;
  customerName?: string | null;
  onRefunded?: () => void;
}) {
  const { role } = usePermissions();
  const [open, setOpen] = useState(false);
  // THE UI GATE. Cosmetic — the server asks the same permission — but a
  // button a dispatcher can see and not use is a promise the product breaks.
  if (!canOfferRefund(role, payment)) return null;
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
        Refund
      </Button>
      {open && (
        <RefundDialog
          paymentId={payment.id}
          invoiceId={invoiceId}
          currency={currency ?? "usd"}
          customerName={customerName ?? null}
          onClose={() => setOpen(false)}
          onRefunded={onRefunded}
        />
      )}
    </>
  );
}

function RefundDialog({
  paymentId,
  invoiceId,
  currency,
  customerName,
  onClose,
  onRefunded,
}: {
  paymentId: string;
  invoiceId: string;
  currency: string;
  customerName: string | null;
  onClose: () => void;
  onRefunded?: () => void;
}) {
  const qc = useQueryClient();
  const quoteFn = useServerFn(getPaymentRefundQuote);
  const refundFn = useServerFn(refundInvoicePayment);
  // One id for the life of this dialog. A double tap on the final button, or
  // a retried request, sends the same id and Stripe returns the same refund.
  const [attemptId] = useState(newAttemptId);
  const [step, setStep] = useState<"form" | "confirm">("form");
  const [amountText, setAmountText] = useState("");
  const [reason, setReason] = useState<RefundReason>("requested_by_customer");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const quoteQ = useQuery({
    queryKey: ["refund-quote", paymentId],
    queryFn: () => quoteFn({ data: { paymentId } }),
    // Always fresh: the ceiling is whatever Stripe says NOW.
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const quote = quoteQ.data;
  const cur = quote?.currency ?? currency;

  // Default the amount to everything still refundable, once it is known.
  useEffect(() => {
    if (quote && amountText === "") setAmountText((quote.refundableCents / 100).toFixed(2));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quote]);

  const amountCents = parseRefundAmount(amountText);
  const who = customerName || "the client";

  const refundM = useMutation({
    mutationFn: () =>
      refundFn({
        data: {
          paymentId,
          amountCents: amountCents ?? undefined,
          reason,
          note: note.trim() || undefined,
          attemptId,
        },
      }),
    onSuccess: (r) => {
      toast.success(
        `Refund of ${fmt(r.amountCents, r.currency)} sent. It usually reaches ${who} in 5 to 10 business days.`,
      );
      qc.invalidateQueries({ queryKey: ["invoice", invoiceId] });
      qc.invalidateQueries({ queryKey: ["invoice-detail", invoiceId] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["billing-summary"] });
      onRefunded?.();
      onClose();
    },
    onError: (e: Error) => {
      // Back to the form, with the reason, so the amount can be corrected.
      setError(e.message);
      setStep("form");
    },
  });

  function review() {
    if (!quote) return;
    if (amountCents == null || amountCents < 1) {
      setError("Enter an amount in dollars and cents, like 45.00.");
      return;
    }
    if (amountCents > quote.refundableCents) {
      setError(`The most you can refund on this payment is ${fmt(quote.refundableCents, cur)}.`);
      return;
    }
    setError(null);
    setStep("confirm");
  }

  // The same division the webhook files, so the dialog and the ledger cannot
  // disagree about a cent.
  const share =
    quote && amountCents
      ? splitRefund(
          amountCents,
          quote.chargedCents,
          quote.surchargeCents,
          quote.tipCents ?? 0,
          quote.taxCents ?? 0,
        )
      : null;
  const surchargeShare = share?.surchargeCents ?? 0;
  const tipShare = share?.tipCents ?? 0;
  const taxShare = share?.taxCents ?? 0;

  return (
    <Dialog open onOpenChange={(o) => !o && !refundM.isPending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{step === "confirm" ? "Confirm refund" : "Refund payment"}</DialogTitle>
          <DialogDescription asChild>
            <div className="text-sm text-muted-foreground">
              {quoteQ.isLoading && <p>Checking this payment with Stripe…</p>}
              {quoteQ.error && (
                <p className="text-destructive">{(quoteQ.error as Error).message}</p>
              )}
              {quote && step === "form" && (
                <p>
                  Charged {fmt(quote.chargedCents, cur)}
                  {quote.refundedCents > 0
                    ? `, ${fmt(quote.refundedCents, cur)} already refunded`
                    : ""}
                  . Up to {fmt(quote.refundableCents, cur)} can go back.
                </p>
              )}
            </div>
          </DialogDescription>
        </DialogHeader>

        {quote && step === "form" && (
          <form
            className="min-w-0 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              review();
            }}
          >
            <div>
              <Label htmlFor="refund-amount">Amount to refund</Label>
              <div className="relative mt-1">
                <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground">
                  $
                </span>
                <Input
                  id="refund-amount"
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
              {amountCents !== quote.refundableCents && (
                <button
                  type="button"
                  className="mt-1 inline-flex items-center text-xs font-medium text-primary hover:underline touch:min-h-11"
                  onClick={() => {
                    setAmountText((quote.refundableCents / 100).toFixed(2));
                    setError(null);
                  }}
                >
                  Refund the full {fmt(quote.refundableCents, cur)}
                </button>
              )}
            </div>

            <div>
              <Label htmlFor="refund-reason">Reason</Label>
              <Select value={reason} onValueChange={(v) => setReason(v as RefundReason)}>
                <SelectTrigger id="refund-reason" className="mt-1 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REFUND_REASONS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {REFUND_REASON_LABELS[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {reason === "fraudulent" && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Stripe will also block this card from paying you again.
                </p>
              )}
            </div>

            <div>
              <Label htmlFor="refund-note">
                Note <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Textarea
                id="refund-note"
                className="mt-1"
                rows={2}
                maxLength={REFUND_NOTE_MAX}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit">Review refund</Button>
            </DialogFooter>
          </form>
        )}

        {quote && step === "confirm" && amountCents != null && (
          <div className="min-w-0 space-y-4">
            <p className="text-base">
              Send <span className="font-semibold tabular-nums">{fmt(amountCents, cur)}</span> back
              to <span className="font-semibold break-words">{who}</span>?
            </p>
            <ul className="space-y-1 text-sm text-muted-foreground">
              <li>It goes to the card or bank account they paid with.</li>
              {surchargeShare > 0 && (
                <li>
                  About {fmt(surchargeShare, cur)} of it is the card fee they paid, which comes off
                  your fee recovery rather than your revenue.
                </li>
              )}
              {tipShare > 0 && (
                <li>
                  About {fmt(tipShare, cur)} of it is the tip they added, which was never counted as
                  revenue, so it comes off tips rather than income.
                </li>
              )}
              {taxShare > 0 && (
                <li>
                  About {fmt(taxShare, cur)} of it is sales tax, which was never your revenue, so
                  it comes off the tax you collected rather than your income.
                </li>
              )}
              {amountCents < quote.refundableCents && (
                <li>
                  {fmt(quote.refundableCents - amountCents, cur)} will still be refundable
                  afterwards.
                </li>
              )}
              <li>A refund can&rsquo;t be undone.</li>
            </ul>
            <DialogFooter className="gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={refundM.isPending}
                onClick={() => setStep("form")}
              >
                Back
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={refundM.isPending}
                onClick={() => refundM.mutate()}
              >
                {refundM.isPending ? "Refunding…" : `Refund ${fmt(amountCents, cur)}`}
              </Button>
            </DialogFooter>
          </div>
        )}

        {quoteQ.error && (
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Close
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
