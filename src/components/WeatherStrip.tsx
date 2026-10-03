import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { analyzeDayWeather } from "@/lib/weather-day.functions";
import { rescheduleVisits, undoReschedule } from "@/lib/weather.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { CloudRain, Loader2, Wind } from "lucide-react";

/** Does this forecast day carry PRECIPITATION risk — rain or snow — as
 *  opposed to some other kind of risk?
 *
 *  Exported because the page that mounts the strip has to answer it before it
 *  offers the strip at all, and the answer belongs next to the thing it
 *  gates. `getWeatherForZones` (read-only) supplies the day; `analyzeDayWeather`
 *  (which WRITES `weather_flagged` / `weather_note` onto visit rows) must not
 *  be involved in deciding whether to draw a button, and is not.
 *
 *  ── WHY THIS READS `reasons` AND NOT THE NUMBERS ──────────────────────────
 *
 *  `assessRisk` in weather.functions.ts owns the thresholds — 0.2in, 70%,
 *  25mph, weathercode >= 95, 23°F — and it already published its verdict as
 *  `risky` plus a list of human reasons. Re-deriving "is it going to rain"
 *  from `precip_in >= 0.2` here would copy those numbers into a second file,
 *  where the next threshold change would silently stop agreeing with the
 *  first. So `risky` stays the source of truth for "is this day a problem",
 *  and the only judgement made here is which KIND of problem it is.
 *
 *  The reasons separate cleanly enough to make that judgement:
 *
 *      `0.31" rain`      precipitation
 *      `80% chance`      precipitation (chance OF precipitation)
 *      `thunderstorm`    precipitation
 *      `wind 31 mph`     not precipitation
 *      `hard freeze`     not precipitation — this is temperature, and
 *                        "temperature isn't much of a worry" is exactly what
 *                        the owner said when asking for this
 *
 *  So the test is subtractive: risky, and at least one reason that is not wind
 *  and not a freeze. Subtractive on purpose — an unrecognised future reason
 *  counts AS precipitation and shows the icon. A spurious icon on a windy day
 *  is a small annoyance; a missing icon on a day it snows is the owner losing
 *  the warning this whole change exists to deliver, so the failure mode points
 *  that way deliberately.
 *
 *  ── SNOW ─────────────────────────────────────────────────────────────────
 *
 *  There is no snow reason to match, and its absence is not an oversight.
 *  Open-Meteo's `precipitation_sum` is water equivalent and INCLUDES snowfall,
 *  so snow arrives inside `0.31" rain` and `80% chance` already — mislabelled
 *  in the wording, present in the number. Adding a separate snow trigger would
 *  mean introducing a threshold (snow is roughly 10:1 by depth, so 0.2in of
 *  water is a couple of inches of snow and light snow clears none of these
 *  bars), and inventing a threshold for what a crew will go out in is not a
 *  decision to make in passing while moving a button. If it turns out light
 *  snow needs to flag, that is a change to `assessRisk`, made deliberately,
 *  and this function inherits it for free. */
export function hasPrecipitationRisk(day: {
  risky: boolean;
  reasons: string[];
}): boolean {
  if (!day.risky) return false;
  return day.reasons.some((r) => !NON_PRECIPITATION_REASON.test(r.trim()));
}

/** The two reasons `assessRisk` can raise that are not about water falling out
 *  of the sky. Anchored at the start so a reason merely CONTAINING the word —
 *  a hypothetical "rain and wind" — is still read as precipitation. */
const NON_PRECIPITATION_REASON = /^(wind\b|hard freeze$)/i;

function nextDayISO(iso: string): string {
  // Noon anchor, not midnight: `toISOString` speaks UTC, and slicing a UTC
  // render of a local MIDNIGHT names the previous day anywhere east of
  // Greenwich. Noon stays inside the same date for every real offset.
  const d = new Date(iso + "T12:00:00");
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
      // Said before the success toast, because it is the part that needs acting
      // on: a customer who was not told is a locked gate on a day nobody comes.
      if (r.notifyFailed) {
        toast.warning(
          `${r.notifyFailed} client${r.notifyFailed === 1 ? " was" : "s were"} not emailed about the change. Call ${r.notifyFailed === 1 ? "them" : "those"} before the day.`,
          { duration: 15000 },
        );
      }
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
          <CloudRain className="h-4 w-4 shrink-0" />
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
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin shrink-0" /> Checking…
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
                <div className="truncate text-2xs opacity-80">
                  {z.risky ? z.reasons.join(" · ") : z.reasons[0] ?? "clear"}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2 text-2xs opacity-80">
                {z.precip_prob != null && (
                  <span className="inline-flex items-center gap-0.5">
                    <CloudRain className="h-3 w-3 shrink-0" />
                    {z.precip_prob}%
                  </span>
                )}
                {/* Wind used to be a bare number — an icon followed by "23",
                    in a product whose users are American and whose forecast
                    was arriving in km/h. An icon says what is being measured,
                    not in what, so the unit is spelled out beside it.

                    The high temperature stood here too and no longer does.
                    "Temperature isn't much of a worry" — the owner reads this
                    strip to answer "can the crew work today", and on a route
                    that is a question about rain, snow and wind. A number that
                    changes nothing about the answer is a number competing with
                    the ones that do, in a row that has to fit a phone. */}
                {z.wind_max != null && (
                  <span className="inline-flex items-center gap-0.5">
                    <Wind className="h-3 w-3 shrink-0" />
                    {Math.round(z.wind_max)} mph
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
