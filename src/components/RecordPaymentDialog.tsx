// "Record payment": money that did not go through Stripe. Cash at the door, a
// check, a transfer, Venmo, Zelle. Asks how it came in, the check number or
// reference, and the day it arrived, then hands those back to the caller,
// which writes them through bulkMarkInvoicesPaid.
//
// Promise-based like useConfirmDialog, so the invoice list's row menu, its
// bulk bar, the invoice drawer and the full invoice page all ask the same
// question the same way:
//
//   const { ask, dialog } = useRecordPaymentDialog();
//   const answer = await ask({ title: "Record payment", amountLine: "$45.00 ..." });
//   if (answer) mutate(answer);
import { useCallback, useRef, useState, type ReactNode } from "react";
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
import { useOrgToday, useOrgTimezone } from "@/hooks/useOrgToday";
import {
  MANUAL_PAYMENT_LABELS,
  MANUAL_PAYMENT_METHODS,
  REFERENCE_LABELS,
  REFERENCE_MAX,
  receivedOnProblem,
  type ManualPaymentMethod,
} from "@/lib/manual-payments";
import { cn } from "@/lib/utils";

export interface RecordPaymentAnswer {
  method: ManualPaymentMethod;
  reference?: string;
  receivedOn: string;
}

export interface RecordPaymentOptions {
  title?: string;
  /** What is being settled, e.g. "$45.00, the open balance on invoice #26db55a4". */
  amountLine: ReactNode;
  confirmLabel?: string;
}

export function useRecordPaymentDialog() {
  const today = useOrgToday();
  const tz = useOrgTimezone();
  const [options, setOptions] = useState<RecordPaymentOptions | null>(null);
  const [method, setMethod] = useState<ManualPaymentMethod>("cash");
  const [reference, setReference] = useState("");
  const [receivedOn, setReceivedOn] = useState(today);
  const [error, setError] = useState<string | null>(null);
  const resolver = useRef<(v: RecordPaymentAnswer | null) => void>(() => {});

  const ask = useCallback(
    (opts: RecordPaymentOptions): Promise<RecordPaymentAnswer | null> =>
      new Promise((resolve) => {
        resolver.current = resolve;
        setMethod("cash");
        setReference("");
        setReceivedOn(today);
        setError(null);
        setOptions(opts);
      }),
    [today],
  );

  function settle(value: RecordPaymentAnswer | null) {
    resolver.current(value);
    resolver.current = () => {};
    setOptions(null);
  }

  function submit() {
    const problem = receivedOnProblem(receivedOn, tz);
    if (problem) {
      setError(problem);
      return;
    }
    const ref = reference.trim();
    settle({
      method,
      reference: method !== "cash" && ref ? ref : undefined,
      receivedOn,
    });
  }

  const refLabel = REFERENCE_LABELS[method];

  const dialog = (
    <Dialog open={!!options} onOpenChange={(o) => !o && settle(null)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{options?.title ?? "Record payment"}</DialogTitle>
          <DialogDescription asChild>
            <div className="text-sm text-muted-foreground">{options?.amountLine}</div>
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <fieldset>
            <legend className="text-sm font-medium">How was it paid?</legend>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {MANUAL_PAYMENT_METHODS.map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={method === m}
                  onClick={() => setMethod(m)}
                  className={cn(
                    "h-10 rounded-md border px-3 text-sm font-medium transition-colors touch:min-h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    method === m
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-input bg-background hover:bg-muted",
                  )}
                >
                  {MANUAL_PAYMENT_LABELS[m]}
                </button>
              ))}
            </div>
          </fieldset>

          {refLabel && (
            <div>
              <Label htmlFor="record-payment-reference">
                {refLabel} <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="record-payment-reference"
                className="mt-1"
                value={reference}
                maxLength={REFERENCE_MAX}
                inputMode={method === "check" ? "numeric" : "text"}
                autoComplete="off"
                onChange={(e) => setReference(e.target.value)}
              />
            </div>
          )}

          <div>
            <Label htmlFor="record-payment-received-on">Received on</Label>
            <Input
              id="record-payment-received-on"
              type="date"
              className="mt-1"
              value={receivedOn}
              max={today}
              onChange={(e) => {
                setReceivedOn(e.target.value);
                setError(null);
              }}
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => settle(null)}>
              Cancel
            </Button>
            <Button type="submit">{options?.confirmLabel ?? "Record payment"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );

  return { ask, dialog };
}
