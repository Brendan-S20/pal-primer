// What each schedule costs against a weekly visit (#572, F-07).
//
// organizations.frequency_multipliers was read by every quote and by the
// public signup page, and no screen showed it. So twice weekly's 1.8 was
// applied to each of its two visits, 3.6x the weekly plan, and an owner had
// no way to see it or change it. This card is that number, editable, with
// what it means per visit beside it.
//
// Twice weekly is the one row whose number covers two visits, so its row says
// both: the week's total the owner types, and the per-visit price it gives.
//
// Layout at 320px: each row is a label block that takes what is left and an
// input plus a result that keep their width; when they do not fit beside the
// label, the row wraps rather than squeezing the label.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { getStandardPricing, updateFrequencyMultipliers } from "@/lib/subscriptions.functions";
import {
  DEFAULT_FREQUENCY_MULTIPLIERS,
  MAX_MULTIPLIER,
  MIN_MULTIPLIER,
  MULTIPLIER_FREQUENCIES,
  VISITS_PER_CYCLE,
  formatMultiplier,
  type MultiplierFrequency,
} from "@/lib/frequency-multipliers";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const ROWS: Record<MultiplierFrequency, { label: string; hint: string }> = {
  weekly: { label: "Weekly", hint: "1 visit a week. The baseline." },
  twice_weekly: { label: "Twice weekly", hint: "2 visits a week. The number is the week's total." },
  biweekly: { label: "Every 2 weeks", hint: "1 visit every 2 weeks." },
  monthly: { label: "Monthly", hint: "1 visit a month." },
};

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

type Draft = Record<MultiplierFrequency, string>;

function storedOrDefault(
  stored: Record<string, number> | undefined,
  f: MultiplierFrequency,
): number {
  const n = Number(stored?.[f]);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FREQUENCY_MULTIPLIERS[f];
}

function parse(raw: string): number | null {
  const n = Number(raw.trim());
  return raw.trim() !== "" && Number.isFinite(n) && n >= MIN_MULTIPLIER && n <= MAX_MULTIPLIER
    ? n
    : null;
}

export function FrequencyPricingCard() {
  const qc = useQueryClient();
  const getFn = useServerFn(getStandardPricing);
  const updateFn = useServerFn(updateFrequencyMultipliers);
  const { data } = useQuery({ queryKey: ["std-pricing"], queryFn: () => getFn() });
  const [draft, setDraft] = useState<Partial<Draft>>({});

  const value = (f: MultiplierFrequency) =>
    draft[f] ?? formatMultiplier(storedOrDefault(data?.frequencyMultipliers, f));
  const parsed = Object.fromEntries(
    MULTIPLIER_FREQUENCIES.map((f) => [f, parse(value(f))]),
  ) as Record<MultiplierFrequency, number | null>;
  const invalid = MULTIPLIER_FREQUENCIES.filter((f) => parsed[f] == null);
  const base = data?.basePriceCents ?? null;

  const mut = useMutation({
    mutationFn: () => updateFn({ data: parsed as Record<MultiplierFrequency, number> }),
    onSuccess: () => {
      toast.success("Schedule pricing saved");
      setDraft({});
      qc.invalidateQueries({ queryKey: ["std-pricing"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Card className="p-5">
      <h2 className="text-sm font-medium">Price by schedule</h2>
      <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
        Each number is what one cycle of the schedule costs, counted in weekly visits. Twice weekly
        covers both visits in the week, so 1.8 makes each visit 0.9 of a weekly visit. Quotes and
        your signup page use these. Plans you already sold keep their price.
      </p>
      <form
        className="mt-4 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (invalid.length === 0) mut.mutate();
        }}
      >
        {MULTIPLIER_FREQUENCIES.map((f) => {
          const n = parsed[f];
          const visits = VISITS_PER_CYCLE[f];
          const perVisit = n == null ? null : n / visits;
          return (
            <div
              key={f}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t pt-3 first:border-t-0 first:pt-0"
            >
              <div className="min-w-0 flex-1 basis-48">
                <Label htmlFor={`freq-mult-${f}`} className="text-sm">
                  {ROWS[f].label}
                </Label>
                <p className="text-xs text-muted-foreground">{ROWS[f].hint}</p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <div className="flex items-center gap-1">
                  <span className="text-sm text-muted-foreground">x</span>
                  <Input
                    id={`freq-mult-${f}`}
                    type="number"
                    inputMode="decimal"
                    min={MIN_MULTIPLIER}
                    max={MAX_MULTIPLIER}
                    step="0.05"
                    className="w-24"
                    aria-invalid={n == null}
                    value={value(f)}
                    onChange={(e) => setDraft((d) => ({ ...d, [f]: e.target.value }))}
                  />
                </div>
                <div className="w-36 text-xs text-muted-foreground">
                  {perVisit == null ? (
                    <span className="text-destructive">
                      Between {MIN_MULTIPLIER} and {MAX_MULTIPLIER}
                    </span>
                  ) : base != null ? (
                    <>
                      {money(Math.round(base * perVisit))} a visit
                      {visits > 1 && (
                        <span className="block">{money(Math.round(base * n!))} a week</span>
                      )}
                    </>
                  ) : (
                    <>x{formatMultiplier(perVisit)} per visit</>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
          <p className="min-w-0 flex-1 basis-48 text-xs text-muted-foreground">
            {base != null
              ? `Examples use your standard price of ${money(base)} for one dog.`
              : "Set a standard price above to see examples in dollars."}
          </p>
          <Button
            type="submit"
            size="sm"
            disabled={mut.isPending || invalid.length > 0 || Object.keys(draft).length === 0}
          >
            {mut.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Card>
  );
}
