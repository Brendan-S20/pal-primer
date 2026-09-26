import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CloudSun, Droplets } from "lucide-react";
import { getWeatherForZones } from "@/lib/weather.functions";
import { useOrgToday } from "@/hooks/useOrgToday";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";

// Shapes returned by getWeatherForZones (see src/lib/weather.functions.ts).
type DayCell = {
  date: string;
  precip_in: number;
  precip_prob: number;
  wind_max: number;
  temp_max: number;
  temp_min: number;
  weathercode: number;
  risky: boolean;
  reasons: string[];
  visit_count: number;
};

type ZoneForecast = {
  id: string;
  name: string;
  postal_prefix: string | null;
  latitude: number | null;
  longitude: number | null;
  status: "ok" | "no_coords" | "error";
  error: string | null;
  stale: boolean;
  days: DayCell[];
};

function plusDaysIso(iso: string, n: number) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  // Shift by the local offset before slicing: `toISOString` speaks UTC, and
  // slicing a UTC render of a local midnight names yesterday anywhere east
  // of Greenwich.
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60_000).toISOString().slice(0, 10);
}

// Zones are often stacked on top of each other (neighborhoods of the same
// town share a forecast). Dedupe into "main areas": greedy clustering where a
// zone joins a cluster when its center is within ~0.15° (~10 miles) of the
// cluster's first zone. One card per cluster, labeled by that first zone.
const CLUSTER_DEGREES = 0.15;

function clusterZones(zones: ZoneForecast[]): ZoneForecast[][] {
  const clusters: ZoneForecast[][] = [];
  for (const z of zones) {
    const hit = clusters.find((c) => {
      const a = c[0];
      if (a.latitude == null || a.longitude == null || z.latitude == null || z.longitude == null)
        return false;
      return (
        Math.hypot(a.latitude - z.latitude, a.longitude - z.longitude) <= CLUSTER_DEGREES
      );
    });
    if (hit) hit.push(z);
    else clusters.push([z]);
  }
  return clusters;
}

function weekdayInitial(iso: string): string {
  return new Date(iso + "T00:00:00").toLocaleDateString(undefined, { weekday: "narrow" });
}

function DayColumn({ day }: { day: DayCell }) {
  // The tooltip spells the unit out on both ends. The column below can afford
  // it only once, and a bare "36" is exactly what sent a Texas dispatcher
  // looking for a coat on a 97-degree day.
  const tooltip = [
    day.date,
    `${Math.round(day.temp_min)}°F to ${Math.round(day.temp_max)}°F`,
    `${day.precip_prob}% precip`,
    ...(day.risky ? day.reasons : []),
  ].join(" · ");
  return (
    <div
      title={tooltip}
      className={`flex flex-col items-center rounded px-0.5 py-1 text-center ${
        day.risky ? "bg-destructive/10 text-destructive" : ""
      }`}
    >
      <span className="text-3xs font-medium uppercase opacity-70">
        {weekdayInitial(day.date)}
      </span>
      {/* The unit rides on the high only. Repeating °F under it would double
          the column's width for a number the reader has already been told the
          unit of one line above. */}
      <span className="text-2xs font-semibold tabular-nums">{Math.round(day.temp_max)}°F</span>
      <span className="text-3xs tabular-nums opacity-60">{Math.round(day.temp_min)}°</span>
      <span className="flex h-3 items-center justify-center">
        {day.precip_prob >= 50 && <Droplets className="h-3 w-3 opacity-80" />}
      </span>
    </div>
  );
}

function AreaCard({ cluster }: { cluster: ZoneForecast[] }) {
  const lead = cluster[0];
  const extra = cluster.length - 1;
  return (
    <div className="rounded-md border bg-card p-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-xs font-medium">{lead.name}</span>
        <span className="flex shrink-0 items-center gap-1.5 text-3xs text-muted-foreground">
          {extra > 0 && <span>+{extra} more</span>}
          {lead.stale && <span title="Showing a cached forecast">cached</span>}
        </span>
      </div>
      {lead.days.length > 0 ? (
        <div className="mt-1.5 grid grid-cols-7 gap-0.5">
          {lead.days.slice(0, 7).map((d) => (
            <DayColumn key={d.date} day={d} />
          ))}
        </div>
      ) : (
        <p className="mt-1.5 text-2xs text-muted-foreground">No forecast available.</p>
      )}
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-2" aria-label="Loading forecast">
      {[0, 1].map((i) => (
        <div key={i} className="animate-pulse rounded-md border p-2">
          <div className="h-3 w-24 rounded bg-muted" />
          <div className="mt-2 grid grid-cols-7 gap-0.5">
            {Array.from({ length: 7 }).map((_, j) => (
              <div key={j} className="h-10 rounded bg-muted" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function WeatherPopover() {
  const [open, setOpen] = useState(false);

  // This week: today through today+6 — the ORG's today. The old anchor was
  // `toISOString().slice(0, 10)`, the UTC day, which is tomorrow every US
  // evening: the forecast window started a day late for exactly the person
  // checking tomorrow's weather at the end of a shift. No memo: these are
  // strings, the query key compares them by value, and computing them each
  // render is what lets the window follow the org loading and midnight
  // rolling over instead of freezing the first render's guess.
  const fromDate = useOrgToday();
  const toDate = plusDaysIso(fromDate, 6);

  const getWeather = useServerFn(getWeatherForZones);
  const query = useQuery({
    queryKey: ["weather-popover", fromDate, toDate],
    queryFn: () => getWeather({ data: { fromDate, toDate } }),
    // Only fetch once the popover is actually opened.
    enabled: open,
    staleTime: 10 * 60_000,
  });

  const zones = ((query.data as { zones: ZoneForecast[] } | undefined)?.zones ?? []) as ZoneForecast[];
  const okZones = zones.filter((z) => z.status === "ok");
  const failedCount = zones.length - okZones.length;
  const clusters = useMemo(() => clusterZones(okZones), [query.data]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Weather forecast"
          // 32.0px measured at 360px: `p-2` around a 16px glyph. The third
          // header control to be sized by its padding, after the Help link and
          // the bell — both of which are now a 16px glyph centred in a 44px
          // box. This matches them exactly, so the header reads the same and
          // only the part a thumb can miss changed.
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <CloudSun className="h-4 w-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-[340px] max-w-[calc(100vw-1rem)] p-0">
        <div className="border-b px-3 py-2">
          <span className="text-sm font-medium">This week's forecast</span>
        </div>
        <div className="max-h-[min(60vh,420px)] space-y-2 overflow-y-auto p-3">
          {query.isLoading && open ? (
            <LoadingSkeleton />
          ) : query.isError ? (
            <div className="space-y-2 py-2 text-center">
              <p className="text-sm text-muted-foreground">
                {query.error instanceof Error
                  ? query.error.message
                  : "Couldn't load the forecast."}
              </p>
              <Button size="sm" variant="outline" onClick={() => query.refetch()}>
                Retry
              </Button>
            </div>
          ) : zones.length === 0 ? (
            <p className="py-2 text-center text-sm text-muted-foreground">
              No zones yet. Add zones with coordinates to see forecasts.
            </p>
          ) : (
            <>
              {clusters.map((c) => (
                <AreaCard key={c[0].id} cluster={c} />
              ))}
              {failedCount > 0 && (
                <p className="text-2xs text-muted-foreground">
                  Couldn't load {failedCount} zone{failedCount === 1 ? "" : "s"} (missing
                  coordinates or weather service error).
                </p>
              )}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
