import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CloudSun, Droplets } from "lucide-react";
import { getWeatherForZones } from "@/lib/weather.functions";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";

// Shapes returned by getWeatherForZones (see src/lib/weather.functions.ts).
type DayCell = {
  date: string;
  precip_mm: number;
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

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function plusDaysIso(iso: string, n: number) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
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
  const tooltip = [
    day.date,
    `${Math.round(day.temp_min)}° to ${Math.round(day.temp_max)}°`,
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
      <span className="text-2xs font-semibold tabular-nums">{Math.round(day.temp_max)}°</span>
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

  // This week: today through today+6. Memoized so the query key is stable for
  // the life of the mount (it naturally rolls over on next mount).
  const { fromDate, toDate } = useMemo(() => {
    const from = todayIso();
    return { fromDate: from, toDate: plusDaysIso(from, 6) };
  }, []);

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
          className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
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
              No zones yet — add zones with coordinates to see forecasts.
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
