import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import {
  getWeatherForZones,
  getZoneVisitsOnDay,
  rescheduleVisits,
  autoRebalanceForecast,
  getStaffWorkload,
} from "@/lib/weather.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/weather")({
  component: WeatherPage,
});

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
function plusDaysIso(iso: string, n: number) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function WeatherPage() {
  const getWeather = useServerFn(getWeatherForZones);
  const [fromDate, setFromDate] = useState(todayIso());
  const [toDate, setToDate] = useState(plusDaysIso(todayIso(), 6));

  const { data, isFetching, refetch } = useQuery({
    queryKey: ["weather", fromDate, toDate],
    queryFn: () => getWeather({ data: { fromDate, toDate } }),
  });

  const [target, setTarget] = useState<{ zoneId: string; zoneName: string; date: string } | null>(null);

  const days = useMemo(() => {
    const out: string[] = [];
    let cur = fromDate;
    while (cur <= toDate) {
      out.push(cur);
      cur = plusDaysIso(cur, 1);
    }
    return out;
  }, [fromDate, toDate]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Weather</h1>
        <p className="text-sm text-muted-foreground">
          Forecast per zone. Risky days are flagged so you can bulk-reschedule visits before they blow up on the field.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-4">
        <div>
          <Label htmlFor="f">From</Label>
          <Input id="f" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="t">To</Label>
          <Input id="t" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </div>
        <Button variant="outline" onClick={() => refetch()} disabled={isFetching}>
          {isFetching ? "Loading…" : "Refresh"}
        </Button>
        <AutoRebalance fromDate={fromDate} toDate={toDate} />
      </div>

      <WorkloadPanel />

      {data?.zones.length === 0 && (
        <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
          No zones yet. Add zones (with latitude/longitude) to see forecasts.
        </div>
      )}

      <div className="space-y-4">
        {(data?.zones ?? []).map((z) => (
          <div key={z.id} className="rounded-lg border bg-card p-4">
            <div className="mb-3 flex items-baseline justify-between">
              <div>
                <div className="font-semibold">{z.name}</div>
                <div className="text-xs text-muted-foreground">
                  {z.postal_prefix ? `Prefix ${z.postal_prefix} · ` : ""}
                  {z.latitude != null
                    ? `${z.latitude.toFixed(3)}, ${z.longitude?.toFixed(3)}`
                    : "no coordinates — add lat/lon on Zones page"}
                </div>
              </div>
            </div>

            {z.days.length === 0 ? (
              <div className="text-xs text-muted-foreground">No forecast available.</div>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {z.days.map((d) => (
                  <button
                    key={d.date}
                    type="button"
                    onClick={() =>
                      d.visit_count > 0 && setTarget({ zoneId: z.id, zoneName: z.name, date: d.date })
                    }
                    disabled={d.visit_count === 0}
                    className={`rounded-md border p-3 text-left transition ${
                      d.risky ? "border-destructive bg-destructive/5" : "bg-background"
                    } ${d.visit_count === 0 ? "opacity-70" : "hover:border-primary hover:bg-accent"}`}
                  >
                    <div className="flex items-baseline justify-between text-xs text-muted-foreground">
                      <span>{d.date}</span>
                      <span>
                        {Math.round(d.temp_min)}° / {Math.round(d.temp_max)}°
                      </span>
                    </div>
                    <div className="mt-1 text-sm">
                      {d.precip_mm.toFixed(1)}mm · {d.precip_prob}% · wind {Math.round(d.wind_max)}
                    </div>
                    <div className="mt-1 flex items-center justify-between text-xs">
                      <span className={d.risky ? "font-medium text-destructive" : "text-muted-foreground"}>
                        {d.risky ? d.reasons.join(" · ") : "clear"}
                      </span>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs">
                        {d.visit_count} visit{d.visit_count === 1 ? "" : "s"}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {target && (
        <RescheduleDialog
          zoneId={target.zoneId}
          zoneName={target.zoneName}
          fromDay={target.date}
          onClose={() => setTarget(null)}
        />
      )}
    </div>
  );
}

function RescheduleDialog({
  zoneId,
  zoneName,
  fromDay,
  onClose,
}: {
  zoneId: string;
  zoneName: string;
  fromDay: string;
  onClose: () => void;
}) {
  const getVisits = useServerFn(getZoneVisitsOnDay);
  const rmove = useServerFn(rescheduleVisits);
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["zone-visits", zoneId, fromDay],
    queryFn: () => getVisits({ data: { zoneId, date: fromDay } }),
  });
  const [newDate, setNewDate] = useState(plusDaysIso(fromDay, 1));
  const [note, setNote] = useState("Weather-related reschedule");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const visits = data?.visits ?? [];
  const allChecked = visits.length > 0 && selected.size === visits.length;

  const mut = useMutation({
    mutationFn: () =>
      rmove({
        data: { visitIds: Array.from(selected), newDate, note: note || undefined },
      }),
    onSuccess: (r) => {
      toast.success(`Rescheduled ${r.moved} visit(s)`);
      if (r.errors.length) toast.error(r.errors[0]);
      qc.invalidateQueries({ queryKey: ["weather"] });
      qc.invalidateQueries({ queryKey: ["zone-visits", zoneId] });
      onClose();
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-lg border bg-card p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">Reschedule — {zoneName}</h2>
        <p className="text-sm text-muted-foreground">Visits on {fromDay}</p>

        <div className="mt-4 max-h-64 overflow-auto rounded border">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/50 text-left">
              <tr>
                <th className="w-8 px-2 py-1">
                  <input
                    type="checkbox"
                    checked={allChecked}
                    onChange={(e) =>
                      setSelected(e.target.checked ? new Set(visits.map((v) => v.id)) : new Set())
                    }
                  />
                </th>
                <th className="px-2 py-1">Client</th>
                <th className="px-2 py-1">Status</th>
              </tr>
            </thead>
            <tbody>
              {visits.map((v) => (
                <tr key={v.id} className="border-b last:border-0">
                  <td className="px-2 py-1">
                    <input
                      type="checkbox"
                      checked={selected.has(v.id)}
                      onChange={(e) => {
                        const s = new Set(selected);
                        if (e.target.checked) s.add(v.id);
                        else s.delete(v.id);
                        setSelected(s);
                      }}
                    />
                  </td>
                  <td className="px-2 py-1">{v.client_name}</td>
                  <td className="px-2 py-1 text-muted-foreground">{v.status}</td>
                </tr>
              ))}
              {visits.length === 0 && (
                <tr>
                  <td colSpan={3} className="p-4 text-center text-muted-foreground">
                    No reschedulable visits.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="nd">New date</Label>
            <Input id="nd" type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="nt">Note</Label>
            <Input id="nt" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => mut.mutate()}
            disabled={mut.isPending || selected.size === 0 || !newDate}
          >
            {mut.isPending ? "Moving…" : `Reschedule ${selected.size}`}
          </Button>
        </div>
        {mut.error && <p className="mt-2 text-sm text-destructive">{(mut.error as Error).message}</p>}
      </div>
    </div>
  );
}
