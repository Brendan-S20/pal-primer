import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { analyzeDayWeather } from "@/lib/weather-day.functions";
import { rescheduleVisits, undoReschedule } from "@/lib/weather.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { CloudRain, Loader2, Wind, Thermometer } from "lucide-react";

function nextDayISO(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

type Analysis = {
  day: string;
  total_visits: number;
  flagged_count: number;
  flagged_visit_ids: string[];
  zones: Array<{
    zone_id: string;
    name: string;
    risky: boolean;
    reasons: string[];
    visit_count: number;
    flagged_visit_ids: string[];
    precip_prob?: number;
    wind_max?: number;
    temp_max?: number;
  }>;
};

export function WeatherStrip({ day }: { day: string }) {
  const qc = useQueryClient();
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [rescheduleDate, setRescheduleDate] = useState(() => nextDayISO(day));

  const analyzeFn = useServerFn(analyzeDayWeather);
  const rescheduleFn = useServerFn(rescheduleVisits);
  const undoFn = useServerFn(undoReschedule);

  const analyze = useMutation({
    mutationFn: () => analyzeFn({ data: { day } }),
    onSuccess: (r) => {
      setAnalysis(r as Analysis);
      setRescheduleDate(nextDayISO(day));
      qc.invalidateQueries({ queryKey: ["visits", day] });
      qc.invalidateQueries({ queryKey: ["dashboard-summary"] });
      if (r.flagged_count > 0) {
        toast.warning(`${r.flagged_count} visit${r.flagged_count === 1 ? "" : "s"} flagged for weather`);
      } else {
        toast.success("No weather risk detected");
      }
    },
    onError: (e: any) => toast.error(e.message),
  });

  const reschedule = useMutation({
    // The server returns the authoritative per-visit moves (from → to), so no
    // browser-side snapshot query is needed; undo goes through the dedicated
    // undoReschedule fn with those exact moves. Targets may differ from the
    // picked date: the server shifts them off blackouts/non-working days
    // (preferred weekdays win), same as visit generation.
    mutationFn: () =>
      rescheduleFn({
        data: {
          visitIds: analysis?.flagged_visit_ids ?? [],
          newDate: rescheduleDate,
          note: "Weather-flagged auto-reschedule",
        },
      }),
    onSuccess: (r) => {
      const moves = r.moves ?? [];
      if (r.errors?.length) {
        toast.error(
          `${r.errors.length} visit${r.errors.length === 1 ? "" : "s"} couldn't be moved: ${r.errors[0]}`,
        );
      }
      const targets = [...new Set(moves.map((m) => m.to))];
      const where =
        targets.length === 1
          ? targets[0] === rescheduleDate
            ? targets[0]
            : `${targets[0]} (shifted to a working day)`
          : `${targets.length} working days`;
      toast.success(`Moved ${r.moved} visit${r.moved === 1 ? "" : "s"} to ${where}`, {
        duration: 8000,
        action: moves.length
          ? {
              label: "Undo",
              onClick: async () => {
                try {
                  const back = await undoFn({ data: { moves } });
                  if (back.errors?.length) toast.error(back.errors[0]);
                  toast.success(`Restored ${back.restored} visit${back.restored === 1 ? "" : "s"}`);
                } catch (e: any) {
                  toast.error(e.message);
                }
                qc.invalidateQueries({ queryKey: ["visits"] });
                qc.invalidateQueries({ queryKey: ["dashboard-summary"] });
              },
            }
          : undefined,
      });
      setAnalysis(null);
      qc.invalidateQueries({ queryKey: ["visits"] });
      qc.invalidateQueries({ queryKey: ["dashboard-summary"] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <CloudRain className="h-4 w-4" />
          Weather for {day}
          {analysis && (
            <Badge variant={analysis.flagged_count > 0 ? "destructive" : "secondary"}>
              {analysis.flagged_count} flagged
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          {analysis && analysis.flagged_count > 0 && (
            <>
              <Input
                type="date"
                value={rescheduleDate}
                min={day}
                onChange={(e) => setRescheduleDate(e.target.value)}
                className="h-8 w-[150px]"
              />
              <Button
                size="sm"
                variant="destructive"
                onClick={() => reschedule.mutate()}
                disabled={reschedule.isPending || rescheduleDate <= day}
              >
                {reschedule.isPending ? "Moving…" : `Reschedule ${analysis.flagged_count} →`}
              </Button>
            </>
          )}
          <Button size="sm" variant="outline" onClick={() => analyze.mutate()} disabled={analyze.isPending}>
            {analyze.isPending ? (
              <>
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> Checking…
              </>
            ) : analysis ? (
              "Re-check"
            ) : (
              "Check weather"
            )}
          </Button>
        </div>
      </div>

      {analyze.isError && !analyze.isPending && (
        <p className="mt-2 text-xs text-destructive">
          Couldn't check the weather ({(analyze.error as Error)?.message ?? "service error"}).{" "}
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={() => analyze.mutate()}
          >
            Retry
          </button>
        </p>
      )}

      {analysis && analysis.zones.length > 0 && (
        <ul className="mt-3 grid gap-1.5 text-xs sm:grid-cols-2 lg:grid-cols-3">
          {analysis.zones.map((z) => (
            <li
              key={z.zone_id}
              className={`flex items-center justify-between gap-2 rounded border px-2 py-1.5 ${
                z.risky
                  ? "border-destructive/40 bg-destructive/5 text-destructive"
                  : "border-transparent bg-muted/40"
              }`}
            >
              <div className="min-w-0">
                <div className="truncate font-medium">{z.name}</div>
                <div className="truncate text-[11px] opacity-80">
                  {z.risky ? z.reasons.join(" · ") : z.reasons[0] ?? "clear"}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2 text-[11px] opacity-80">
                {z.precip_prob != null && (
                  <span className="inline-flex items-center gap-0.5">
                    <CloudRain className="h-3 w-3" />
                    {z.precip_prob}%
                  </span>
                )}
                {z.wind_max != null && (
                  <span className="inline-flex items-center gap-0.5">
                    <Wind className="h-3 w-3" />
                    {Math.round(z.wind_max)}
                  </span>
                )}
                {z.temp_max != null && (
                  <span className="inline-flex items-center gap-0.5">
                    <Thermometer className="h-3 w-3" />
                    {Math.round(z.temp_max)}°
                  </span>
                )}
                <Badge variant="outline" className="ml-1">
                  {z.visit_count}
                </Badge>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
