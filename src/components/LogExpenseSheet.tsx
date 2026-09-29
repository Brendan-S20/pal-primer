// "Log an expense", from My Day.
//
// A tech at the dump, or at the pump between stops, with a receipt in one hand
// and a phone in the other. So: a bottom sheet that fits a 320px phone, every
// control at least 44px, the category as big buttons rather than a menu, the
// amount keyboard numeric, and the receipt one tap to the camera. It is saved
// through lib/offline/expense-actions.ts, which queues it -- receipt and all --
// when there is no signal, and replays it with the rest of the day's work.
//
// The date is the ORGANIZATION's today, not the phone's: see
// src/lib/expenses.ts on why an expense dated by the wrong calendar lands in
// the wrong month, and at year end the wrong tax year.

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Camera, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { createExpense, getExpenseSettings } from "@/lib/expenses.functions";
import {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  IRS_STANDARD_MILEAGE_RATE_CENTS,
  formatExpenseCents,
  formatRate,
  mileageAmountCents,
  parseAmountCents,
  parseMiles,
  type ExpenseCategory,
} from "@/lib/expenses";
import { logExpenseOrQueue } from "@/lib/offline/expense-actions";
import { useOrgToday } from "@/hooks/useOrgToday";

export function LogExpenseSheet({
  open,
  onOpenChange,
  organizationId,
  staffId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string | null | undefined;
  /** The signed-in person's own staff row, from My Day's cached payload. */
  staffId: string | null | undefined;
}) {
  const qc = useQueryClient();
  const today = useOrgToday();
  const sendFn = useServerFn(createExpense);
  const settingsFn = useServerFn(getExpenseSettings);
  const settings = useQuery({
    queryKey: ["expense-settings"],
    queryFn: () => settingsFn(),
    enabled: open,
    staleTime: 5 * 60_000,
    retry: false,
  });
  // Offline, the org's rate is not to hand. The preview then uses the IRS
  // rate and says so; the database prices the row from the org's own rate
  // when it arrives, whatever the preview said.
  const rateKnown = settings.data?.mileageRateCents != null;
  const rate = settings.data?.mileageRateCents ?? IRS_STANDARD_MILEAGE_RATE_CENTS;

  const [category, setCategory] = useState<ExpenseCategory>("fuel");
  const [amount, setAmount] = useState("");
  const [miles, setMiles] = useState("");
  const [spentOn, setSpentOn] = useState(today);
  const [vendor, setVendor] = useState("");
  const [note, setNote] = useState("");
  const [receipt, setReceipt] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // A fresh form each time the sheet opens, dated today on the org's calendar.
  useEffect(() => {
    if (!open) return;
    setCategory("fuel");
    setAmount("");
    setMiles("");
    setSpentOn(today);
    setVendor("");
    setNote("");
    setReceipt(null);
  }, [open, today]);

  const mileage = category === "mileage";
  const parsedMiles = parseMiles(miles);
  const parsedAmount = parseAmountCents(amount);
  const preview = mileage && parsedMiles != null ? mileageAmountCents(parsedMiles, rate) : null;
  const valid =
    !!spentOn && spentOn <= today && (mileage ? parsedMiles != null : parsedAmount != null);

  const save = async () => {
    if (!valid || saving) return;
    setSaving(true);
    try {
      const res = await logExpenseOrQueue({
        organizationId,
        staffId,
        receipt,
        send: sendFn,
        fields: {
          spentOn,
          category,
          ...(mileage ? { miles: parsedMiles! } : { amountCents: parsedAmount! }),
          ...(vendor.trim() ? { vendor: vendor.trim() } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        },
      });
      if (res.queued) {
        toast.success("Expense saved on this phone", {
          description: receipt
            ? "It and the receipt will sync when you have signal."
            : "It will sync when you have signal.",
        });
      } else {
        toast.success("Expense logged");
        qc.invalidateQueries({ queryKey: ["expenses"] });
      }
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message || "Could not log the expense");
    } finally {
      setSaving(false);
    }
  };

  const noStaff = open && !staffId;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        // A bottom sheet on a phone, a centred panel from md up. Scrolls
        // inside itself: seven category buttons, a date, a receipt and a note
        // do not fit a landscape phone's 360px of height.
        className="max-h-[92dvh] overflow-y-auto px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-4 md:mx-auto md:max-w-lg md:rounded-t-xl"
        aria-describedby="log-expense-desc"
      >
        <SheetHeader className="pr-10 text-left">
          <SheetTitle>Log an expense</SheetTitle>
          <SheetDescription id="log-expense-desc">
            Fuel, a dump fee, bags. Saved on the phone if there is no signal.
          </SheetDescription>
        </SheetHeader>

        {noStaff ? (
          <p className="mt-4 text-sm text-muted-foreground">
            Your account has no team profile yet, so there is nobody to file the expense under. Ask
            the office to add you on Settings, Users.
          </p>
        ) : (
          <form
            className="mt-4 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <fieldset>
              <legend className="mb-2 text-sm font-medium">What was it?</legend>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {EXPENSE_CATEGORIES.map((c) => (
                  <Button
                    key={c}
                    type="button"
                    variant={category === c ? "default" : "outline"}
                    aria-pressed={category === c}
                    className="h-auto min-h-11 min-w-0 whitespace-normal px-2 py-1 text-sm leading-tight"
                    onClick={() => setCategory(c)}
                  >
                    {EXPENSE_CATEGORY_LABELS[c]}
                  </Button>
                ))}
              </div>
            </fieldset>

            <div className="grid gap-3 sm:grid-cols-2">
              {mileage ? (
                <div className="min-w-0">
                  <Label htmlFor="expense-miles">Miles</Label>
                  <Input
                    id="expense-miles"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="23.4"
                    value={miles}
                    onChange={(e) => setMiles(e.target.value)}
                    className="mt-1 h-11"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    {preview != null
                      ? `${formatExpenseCents(preview)} at ${formatRate(rate)}`
                      : `Priced at ${formatRate(rate)}`}
                    {!rateKnown && " (your rate is applied when it syncs)"}
                  </p>
                </div>
              ) : (
                <div className="min-w-0">
                  <Label htmlFor="expense-amount">Amount</Label>
                  <Input
                    id="expense-amount"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="$0.00"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="mt-1 h-11"
                  />
                </div>
              )}
              <div className="min-w-0">
                <Label htmlFor="expense-date">Date</Label>
                <Input
                  id="expense-date"
                  type="date"
                  max={today}
                  value={spentOn}
                  onChange={(e) => setSpentOn(e.target.value)}
                  className="mt-1 h-11"
                />
              </div>
            </div>

            <div>
              <Label htmlFor="expense-vendor">
                {mileage ? "Trip" : "Where"}{" "}
                <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="expense-vendor"
                maxLength={120}
                placeholder={
                  mileage ? "Yard to the Elm St route" : "Shell, County transfer station"
                }
                value={vendor}
                onChange={(e) => setVendor(e.target.value)}
                className="mt-1 h-11"
              />
            </div>

            <div>
              <span className="text-sm font-medium">
                Receipt <span className="font-normal text-muted-foreground">(optional)</span>
              </span>
              <input
                ref={fileInput}
                type="file"
                accept="image/*,application/pdf"
                capture="environment"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  setReceipt(f);
                  e.target.value = "";
                }}
              />
              {receipt ? (
                <div className="mt-1 flex min-h-11 items-center gap-2 rounded-md border px-3">
                  <Camera className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-sm" title={receipt.name}>
                    {receipt.name}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-11 w-11 shrink-0"
                    aria-label="Remove the receipt"
                    onClick={() => setReceipt(null)}
                  >
                    <X className="h-4 w-4 shrink-0" aria-hidden="true" />
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  className="mt-1 h-11 w-full"
                  onClick={() => fileInput.current?.click()}
                >
                  <Camera className="mr-1.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  Take a photo of the receipt
                </Button>
              )}
            </div>

            <div>
              <Label htmlFor="expense-note">
                Note <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Textarea
                id="expense-note"
                maxLength={500}
                rows={2}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className="mt-1"
              />
            </div>

            <Button type="submit" className="h-11 w-full" disabled={!valid || saving}>
              {saving ? "Saving…" : "Save expense"}
            </Button>
          </form>
        )}
      </SheetContent>
    </Sheet>
  );
}
