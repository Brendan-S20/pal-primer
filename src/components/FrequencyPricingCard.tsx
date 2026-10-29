// Price by cadence (#572, F-07). The per-visit multipliers every pet-waste
// price is multiplied by were a column nobody could see or change, and the
// shipped twice-weekly 1.8 billed that plan at 3.6x the weekly one. This card
// shows each cadence as what a visit and what a week cost against the weekly
// price, and lets the owner change them. Weekly is the price itself.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { getStandardPricing, updateFrequencyMultipliers } from "@/lib/subscriptions.functions";
import {
  MULTIPLIER_MAX,
  MULTIPLIER_MIN,
  TWICE_WEEKLY_MAX,
  VISITS_PER_WEEK,
  multipliersProblem,
  withDefaults,
  type FrequencyKey,
} from "@/lib/frequency-multipliers";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const ROWS: { key: FrequencyKey; label: string; hint: string }[] = [
  {
    key: "weekly",
    label: "Weekly",
    hint: "Your zone or standard price. Every other cadence is set against it.",
  },
  { key: "twice_weekly", label: "Twice a week", hint: "Two visits a week. At most 1x a visit." },
  { key: "biweekly", label: "Every 2 weeks", hint: "More waste builds up between visits." },
  { key: "monthly", label: "Monthly", hint: "About one visit every 4 weeks." },
];

const times = (n: number) => `${Number(n.toFixed(2))}x`;
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function FrequencyPricingCard() {
  const qc = useQueryClient();
  const getFn = useServerFn(getStandardPricing);
  const updateFn = useServerFn(updateFrequencyMultipliers);
  const { data } = useQuery({ queryKey: ["std-pricing"], queryFn: () => getFn() });
  const saved = withDefaults(data?.frequencyMultipliers);

  const [draft, setDraft] = useState<Partial<Record<FrequencyKey, string>>>({});
  const text = (k: FrequencyKey) => draft[k] ?? String(saved[k]);
  const values = {
    weekly: 1,
    twice_weekly: parseFloat(text("twice_weekly")),
    biweekly: parseFloat(text("biweekly")),
    monthly: parseFloat(text("monthly")),
  };
  const problem = multipliersProblem(values);
  const example = data?.basePriceCents ?? null;

  const mut = useMutation({
    mutationFn: () =>
      updateFn({
        data: {
          biweekly: values.biweekly,
          twice_weekly: values.twice_weekly,
          monthly: values.monthly,
        },
      }),
    onSuccess: () => {
      toast.success("Cadence pricing saved");
      setDraft({});
      qc.invalidateQueries({ queryKey: ["std-pricing"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Card className="p-5">
      <h2 className="text-sm font-medium">Price by how often</h2>
      <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
        Each cadence is priced per visit as a multiple of the weekly price. The week column is what
        a client pays for a whole week on that plan.
        {example != null && ` Dollar amounts use your standard price of ${money(example)}.`} Plans
        already sold keep their price. Reports shows any that differ from these.
      </p>
      <form
        className="mt-4 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!problem) mut.mutate();
        }}
      >
        {ROWS.map((row) => {
          const v = values[row.key];
          const ok = Number.isFinite(v) && v > 0;
          const week = ok ? v * VISITS_PER_WEEK[row.key] : null;
          return (
            <div
              key={row.key}
              className="flex flex-wrap items-center justify-between gap-3 border-t pt-3 first:border-t-0 first:pt-0"
            >
              <div className="min-w-0 flex-1 basis-48">
                <Label htmlFor={`freq-${row.key}`} className="text-sm">
                  {row.label}
                </Label>
                <p className="text-xs text-muted-foreground">{row.hint}</p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-3">
                {row.key === "weekly" ? (
                  <span id={`freq-${row.key}`} className="w-24 text-sm tabular-nums">
                    1x
                  </span>
                ) : (
                  <Input
                    id={`freq-${row.key}`}
                    type="number"
                    inputMode="decimal"
                    min={MULTIPLIER_MIN}
                    max={row.key === "twice_weekly" ? TWICE_WEEKLY_MAX : MULTIPLIER_MAX}
                    step="0.05"
                    className="w-24"
                    value={text(row.key)}
                    onChange={(e) => setDraft((d) => ({ ...d, [row.key]: e.target.value }))}
                  />
                )}
                <dl className="grid w-40 grid-cols-[auto_1fr] gap-x-2 text-xs tabular-nums">
                  <dt className="text-muted-foreground">Visit</dt>
                  <dd>
                    {ok ? times(v) : "-"}
                    {ok && example != null && ` (${money(Math.round(example * v))})`}
                  </dd>
                  <dt className="text-muted-foreground">Week</dt>
                  <dd data-testid={`freq-week-${row.key}`}>
                    {week != null ? times(week) : "-"}
                    {week != null && example != null && ` (${money(Math.round(example * week))})`}
                  </dd>
                </dl>
              </div>
            </div>
          );
        })}
        {problem && <p className="text-xs text-destructive">{problem}</p>}
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={!!problem || mut.isPending}>
            {mut.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Card>
  );
}
