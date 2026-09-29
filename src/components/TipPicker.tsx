// The tip choices on a pay screen, and the one piece of state behind them.
//
// Shared by the public pay link (/pay/i/:token) and the portal pay screen, so
// a customer sees the same four buttons and the same arithmetic wherever they
// pay from. The arithmetic itself is src/lib/tips.ts; what is drawn here is a
// PREVIEW of it. The charge is what the server answers when it is sent the
// CHOICE, and the Pay button only ever shows that answer.
//
// Layout: five choices that are three-then-two on a phone and one row from
// `sm` up. Each is a 44px-tall button at every width, not only on touch: the
// percent buttons carry their dollar figure on a second line, and a chip that
// changed height between a phone and a laptop would move the card field under
// the payer's finger as the page reflowed.

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  NO_TIP,
  TIP_PERCENTS,
  customTipCapCents,
  parseTipDollars,
  percentTipCents,
  sameTipChoice,
  type TipChoice,
  type TipPercent,
} from "@/lib/tips";

function money(cents: number, currency = "usd") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format((cents ?? 0) / 100);
}

type Selected = "none" | TipPercent | "custom";

/** What the server answered for the choice it was sent. */
export type TipSyncResult = {
  clientSecret: string;
  amountCents: number;
  dueCents: number;
  tipCents: number;
};

/**
 * The tip the payer has chosen, kept in step with the PaymentIntent.
 *
 * Every change is sent to the server as a CHOICE and the intent's amount comes
 * back. Calls are strictly one at a time: two updates in flight could land at
 * Stripe out of order and leave the intent on the tip the payer moved away
 * from, with the button showing the one they moved to. So a change made while
 * a call is running waits, and only the latest waiting choice is sent after it.
 *
 * `ready` is true only when the last answer is for the choice on screen and
 * nothing is waiting. The Pay button is disabled otherwise, which is the whole
 * guarantee that what is charged is what is shown.
 */
export function useTipSync(
  initial: TipSyncResult | undefined,
  sync: (choice: TipChoice) => Promise<TipSyncResult>,
) {
  const [choice, setChoiceState] = useState<TipChoice | null>(NO_TIP);
  const [synced, setSynced] = useState<{ choice: TipChoice; result: TipSyncResult } | null>(
    initial ? { choice: NO_TIP, result: initial } : null,
  );
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const waiting = useRef<TipChoice | null>(null);
  const syncRef = useRef(sync);
  syncRef.current = sync;

  // The intent query can resolve after this hook mounts.
  useEffect(() => {
    if (initial && !synced) setSynced({ choice: NO_TIP, result: initial });
  }, [initial, synced]);

  const pump = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRunning(true);
    try {
      while (waiting.current) {
        const next = waiting.current;
        waiting.current = null;
        try {
          const result = await syncRef.current(next);
          setSynced({ choice: next, result });
          setError(null);
        } catch (e) {
          setError((e as Error).message || "Could not update the tip.");
        }
      }
    } finally {
      inFlight.current = false;
      setRunning(false);
    }
  }, []);

  const setChoice = useCallback(
    (next: TipChoice | null) => {
      setChoiceState(next);
      if (!next) return;
      waiting.current = next;
      void pump();
    },
    [pump],
  );

  const ready =
    !running &&
    !!choice &&
    !!synced &&
    sameTipChoice(synced.choice, choice) &&
    waiting.current === null;

  return { choice, setChoice, synced: synced?.result, running, ready, error };
}

export function TipPicker({
  dueCents,
  currency = "usd",
  onChange,
  disabled,
}: {
  /** The invoice amount the percentages are taken of. */
  dueCents: number;
  currency?: string;
  /** Called with the choice, or null while a custom amount is not yet valid. */
  onChange: (choice: TipChoice | null) => void;
  disabled?: boolean;
}) {
  const [selected, setSelected] = useState<Selected>("none");
  const [customText, setCustomText] = useState("");
  const [customError, setCustomError] = useState<string | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cap = customTipCapCents(dueCents);

  useEffect(
    () => () => {
      if (debounce.current) clearTimeout(debounce.current);
    },
    [],
  );

  function choose(next: Selected) {
    if (debounce.current) clearTimeout(debounce.current);
    setSelected(next);
    if (next === "none") {
      setCustomError(null);
      onChange(NO_TIP);
    } else if (next === "custom") {
      commitCustom(customText, false);
    } else {
      setCustomError(null);
      onChange({ kind: "percent", percent: next });
    }
  }

  /** Validate the custom box and hand the choice up; `wait` debounces typing. */
  function commitCustom(text: string, wait: boolean) {
    if (debounce.current) clearTimeout(debounce.current);
    const cents = text.trim() === "" ? null : parseTipDollars(text);
    if (cents == null || cents < 1) {
      setCustomError(text.trim() === "" ? null : "Enter an amount like 5.00.");
      onChange(null);
      return;
    }
    if (cents > cap) {
      setCustomError(`A tip can be at most ${money(cap, currency)} on this invoice.`);
      onChange(null);
      return;
    }
    setCustomError(null);
    const apply = () => onChange({ kind: "custom", cents });
    if (wait) {
      onChange(null);
      debounce.current = setTimeout(apply, 500);
    } else {
      apply();
    }
  }

  const options: { key: Selected; label: string; sub?: string }[] = [
    { key: "none", label: "No tip" },
    ...TIP_PERCENTS.map((p) => ({
      key: p as Selected,
      label: `${p}%`,
      sub: money(percentTipCents(dueCents, p), currency),
    })),
    { key: "custom", label: "Custom" },
  ];

  return (
    <fieldset className="min-w-0 space-y-2" disabled={disabled}>
      <legend className="text-sm font-medium">Add a tip</legend>
      <div role="radiogroup" aria-label="Tip" className="grid grid-cols-3 gap-2 sm:grid-cols-5">
        {options.map((o) => {
          const on = selected === o.key;
          return (
            <button
              key={String(o.key)}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => choose(o.key)}
              className={cn(
                "flex min-h-11 min-w-0 flex-col items-center justify-center rounded-md border px-2 py-1 text-sm leading-tight transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                on
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-input bg-background hover:bg-muted",
              )}
            >
              <span className="font-medium">{o.label}</span>
              {o.sub && (
                <span
                  className={cn(
                    "text-xs tabular-nums",
                    on ? "text-primary-foreground/90" : "text-muted-foreground",
                  )}
                >
                  {o.sub}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {selected === "custom" && (
        <div className="min-w-0">
          <label htmlFor="tip-custom" className="text-xs text-muted-foreground">
            Tip amount
          </label>
          <div className="mt-1 flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-sm text-muted-foreground">$</span>
            <input
              id="tip-custom"
              inputMode="decimal"
              autoComplete="off"
              placeholder="5.00"
              value={customText}
              onChange={(e) => {
                setCustomText(e.target.value);
                commitCustom(e.target.value, true);
              }}
              onBlur={(e) => commitCustom(e.target.value, false)}
              aria-invalid={!!customError}
              aria-describedby={customError ? "tip-custom-error" : undefined}
              className="min-h-11 w-full min-w-0 max-w-40 rounded-md border border-input bg-transparent px-3 text-base tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
          {customError && (
            <p id="tip-custom-error" className="mt-1 text-xs text-destructive">
              {customError}
            </p>
          )}
        </div>
      )}
    </fieldset>
  );
}

/** Invoice, tip and total, as the server last answered them. */
export function TipTotals({
  dueCents,
  tipCents,
  amountCents,
  currency = "usd",
  updating,
}: {
  dueCents: number;
  tipCents: number;
  amountCents: number;
  currency?: string;
  updating?: boolean;
}) {
  return (
    <dl className="space-y-1 text-sm">
      <div className="flex items-center justify-between gap-2">
        <dt className="text-muted-foreground">Invoice</dt>
        <dd className="tabular-nums">{money(dueCents, currency)}</dd>
      </div>
      <div className="flex items-center justify-between gap-2">
        <dt className="text-muted-foreground">Tip</dt>
        <dd className="tabular-nums">{money(tipCents, currency)}</dd>
      </div>
      <div className="flex items-center justify-between gap-2 border-t pt-1 font-medium">
        <dt className="flex items-center gap-1.5">
          Total
          {updating && (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-label="Updating total" />
          )}
        </dt>
        <dd className="tabular-nums">{money(amountCents, currency)}</dd>
      </div>
    </dl>
  );
}
