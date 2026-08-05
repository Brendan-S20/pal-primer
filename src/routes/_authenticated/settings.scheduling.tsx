// Settings → Scheduling.
//
// ── WHY THIS PAGE EXISTS ──────────────────────────────────────────────────
//
// These controls used to live on /routes, inside a collapsed-by-default panel
// labelled "Planning tools" that also held seven ACTIONS — assign a tech,
// optimize a day, optimize a week, re-optimize, balance, generate visits, AI
// dispatch. One button, two entirely different kinds of thing behind it: what
// the business IS (a workday, a set of working days, how fast a truck moves)
// and what to DO right now.
//
// Configuration you set once every few months does not belong on the screen
// you use every morning, behind a disclosure nobody opens. It belongs where
// every other org setting already is, which is here.
//
// The timezone control took this same route earlier (IMP-8) and for the same
// reason, leaving a read-only pointer behind on /routes. This follows it.

import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { getDispatchSettings, updateDispatchSettings } from "@/lib/visits.functions";
import { US_TIMEZONES, DEFAULT_TIMEZONE } from "@/lib/route-window";
import { WorkDaysPicker } from "@/components/schedule/WorkDaysPicker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/_authenticated/settings/scheduling")({
  component: SchedulingSettings,
});

function SchedulingSettings() {
  const getSettings = useServerFn(getDispatchSettings);
  const updSettings = useServerFn(updateDispatchSettings);
  const qc = useQueryClient();

  const { data } = useQuery({ queryKey: ["dispatch-settings"], queryFn: () => getSettings() });
  const settings: any = data?.settings ?? {
    workday_start: "08:00",
    workday_end: "17:00",
    avg_speed_kmh: 30,
    traffic_profile: "normal",
  };

  /** The date the horizon currently reaches, spelled out.
   *
   *  A number of days is not a date, and "90" does not answer "can I promise
   *  this customer a slot in October?". Computed rather than stored: it is a
   *  function of today, so a stored copy would be wrong by morning. */
  const horizonLabel = (() => {
    const d = new Date();
    d.setDate(d.getDate() + (settings.auto_generate_days_ahead ?? 90));
    return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  })();

  const mut = useMutation({
    mutationFn: (patch: any) => updSettings({ data: patch }),
    onSuccess: () => {
      toast.success("Scheduling settings saved");
      // The routes board reads these for ETAs and capacity, so it has to be
      // told rather than left showing figures derived from the old values.
      qc.invalidateQueries({ queryKey: ["dispatch-settings"] });
      qc.invalidateQueries({ queryKey: ["visits"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Scheduling</h2>
        <p className="text-sm text-muted-foreground">
          The working day these routes are planned around, and the travel assumptions used to
          estimate arrival times.
        </p>
      </div>

      <section className="rounded-lg border bg-card p-5">
        <h3 className="text-sm font-semibold">The working day</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Arrival windows start at the workday start, and a day that runs past the end is flagged as
          overloaded.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <Label className="text-xs">Workday start</Label>
            <Input
              type="time"
              defaultValue={settings.workday_start?.slice(0, 5) ?? "08:00"}
              onBlur={(e) => mut.mutate({ workday_start: e.target.value })}
            />
          </div>
          <div>
            <Label className="text-xs">Workday end</Label>
            <Input
              type="time"
              defaultValue={settings.workday_end?.slice(0, 5) ?? "17:00"}
              onBlur={(e) => mut.mutate({ workday_end: e.target.value })}
            />
          </div>
        </div>
        <div className="mt-4">
          <Label className="text-xs">Work days</Label>
          <WorkDaysPicker
            value={(settings.work_days as number[] | null) ?? [0, 1, 2, 3, 4, 5, 6]}
            onChange={(days) => mut.mutate({ work_days: days })}
            disabled={mut.isPending}
          />
          <p className="mt-1 text-2xs text-muted-foreground">
            New visits are only scheduled on these days. A client&apos;s explicit preferred weekdays
            still win — an agreed Saturday stays a Saturday.
          </p>
        </div>
      </section>

      <section className="rounded-lg border bg-card p-5">
        <h3 className="text-sm font-semibold">How far ahead the schedule is built</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Every night we fill the calendar out to this many days from today, from each client&apos;s
          recurring plan. It rolls forward on its own — there is nothing to press.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <Label className="text-xs">Days ahead</Label>
            <Input
              type="number"
              min={1}
              max={365}
              defaultValue={settings.auto_generate_days_ahead ?? 90}
              onBlur={(e) => {
                const v = Number(e.target.value);
                // Refuse locally rather than round-tripping to a raise. The
                // same 1–365 bound lives on the column, the RPC and the input
                // validator; this is the one that can explain itself.
                if (!Number.isFinite(v) || v < 1 || v > 365) {
                  toast.error("Choose between 1 and 365 days");
                  e.target.value = String(settings.auto_generate_days_ahead ?? 90);
                  return;
                }
                if (v !== (settings.auto_generate_days_ahead ?? 90)) {
                  mut.mutate({ auto_generate_days_ahead: v });
                }
              }}
            />
            <p className="mt-1 text-2xs text-muted-foreground">
              90 is a good default — a quarter to plan and sell against. Longer suits annual
              contracts; shorter means less to redo when prices or frequencies change.
            </p>
          </div>
          <div className="rounded-md border bg-muted/30 p-3">
            <p className="text-xs font-medium">Currently filled through</p>
            <p className="mt-0.5 text-sm tabular-nums">{horizonLabel}</p>
            <p className="mt-1 text-2xs text-muted-foreground">
              Clients whose plan has an end date stop on that date, and one-off visits never
              repeat — changing this number does not change either.
            </p>
          </div>
        </div>
        <label className="mt-4 flex items-start gap-2 border-t pt-4 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            defaultChecked={Boolean(settings.notify_schedule_horizon)}
            onChange={(e) => mut.mutate({ notify_schedule_horizon: e.target.checked })}
          />
          <span>
            <span className="font-medium">Tell me when the schedule moves into a new week</span>
            <span className="block text-xs text-muted-foreground">
              A note in your notifications saying what date the calendar now runs to. Off by
              default. It exists because a schedule that fills itself is invisible — working
              perfectly looks identical to nothing happening — and this used to be confirmed by
              pressing a button. Sent once a week at most, never nightly.
            </span>
          </span>
        </label>
      </section>

      <section className="rounded-lg border bg-card p-5">
        <h3 className="text-sm font-semibold">Travel assumptions</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Used to estimate drive time between stops when sequencing a route. They do not change what
          is scheduled, only the predicted arrival times and which routes look overloaded.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <Label className="text-xs">Average speed (km/h)</Label>
            <Input
              type="number"
              min={5}
              max={120}
              defaultValue={settings.avg_speed_kmh ?? 30}
              onBlur={(e) => mut.mutate({ avg_speed_kmh: Number(e.target.value) })}
            />
          </div>
          <div>
            <Label className="text-xs">Traffic profile</Label>
            <select
              defaultValue={settings.traffic_profile ?? "normal"}
              onChange={(e) => mut.mutate({ traffic_profile: e.target.value })}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              <option value="light">Light (faster)</option>
              <option value="normal">Normal</option>
              <option value="heavy">Heavy (slower)</option>
            </select>
          </div>
          <div className="sm:col-span-2">
            <Label className="text-xs">Longest drive to a single stop (minutes)</Label>
            <Input
              type="number"
              min={15}
              max={1440}
              defaultValue={settings.max_drive_minutes ?? 240}
              onBlur={(e) => mut.mutate({ max_drive_minutes: Number(e.target.value) })}
            />
            <p className="mt-1 text-2xs text-muted-foreground">
              An assignment implying a longer drive than this is flagged as implausible on the
              board. It is a warning, not a limit — nothing is blocked.
            </p>
          </div>
        </div>
      </section>

      <section className="rounded-lg border bg-card p-5">
        <h3 className="text-sm font-semibold">Time zone</h3>
        {/* A pointer, not a second control. Timezone defines "today" for the
            customer portal, the missed-visit job and the end-of-day close-out
            as well as for routing — so it has one home, and this is not it. */}
        <p className="mt-2 text-sm">
          {US_TIMEZONES.find((tz) => tz.value === (settings.timezone ?? DEFAULT_TIMEZONE))?.label ??
            settings.timezone ??
            DEFAULT_TIMEZONE}
        </p>
        <p className="mt-1 text-2xs text-muted-foreground">
          Arrival windows are anchored to the workday start in this time zone. It also decides what
          counts as &ldquo;today&rdquo; for the customer portal and the end-of-day close-out, so it
          is set once in{" "}
          <Link to="/settings/preferences" className="underline underline-offset-2">
            Settings → Preferences
          </Link>
          .
        </p>
      </section>
    </div>
  );
}
