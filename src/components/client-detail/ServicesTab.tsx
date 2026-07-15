// Services tab (spec: subscriptions are "Services" in the UI). Read-only
// rows with lifecycle actions — edit in a drawer, pause/resume, end with an
// effective date + reason, delete only when the service never started. The
// creation form stays hidden until "Add Service".
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { CalendarClock, Pause, Play, Plus, Square, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  createSubscription,
  updateSubscription,
  pauseSubscription,
  resumeSubscription,
  endSubscription,
  deleteDraftSubscription,
} from "@/lib/subscriptions.functions";
import {
  subscriptionToFormValues,
  blankSubscriptionFormValues,
  scheduleChoiceFromRecord,
  scheduleChoiceToFields,
  formatFrequency,
  type ScheduleChoice,
  type SubscriptionFormValues,
} from "@/lib/subscription-form";
import { EditDrawer, DrawerFooter } from "@/components/client-detail/EditDrawer";
import { PrepayInline } from "@/components/client-detail/billing-panels";
import { generatePrepaidInvoice } from "@/lib/invoices.functions";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function ServicesTab({
  clientId,
  client,
  properties,
  subscriptions,
  zones,
  visits,
  canBill,
}: {
  clientId: string;
  client: any;
  properties: any[];
  subscriptions: any[];
  zones: any[];
  visits: any[];
  canBill: boolean;
}) {
  const qc = useQueryClient();
  const [drawerSub, setDrawerSub] = useState<any | null | "new">(null);
  const [endingSub, setEndingSub] = useState<any | null>(null);

  const pauseFn = useServerFn(pauseSubscription);
  const resumeFn = useServerFn(resumeSubscription);
  const deleteFn = useServerFn(deleteDraftSubscription);
  const prepayFn = useServerFn(generatePrepaidInvoice);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["subs", clientId] });
    qc.invalidateQueries({ queryKey: ["client-visits", clientId] });
    qc.invalidateQueries({ queryKey: ["client-visit-history", clientId] });
    qc.invalidateQueries({ queryKey: ["client-activity", clientId] });
  };

  const pauseMut = useMutation({
    mutationFn: (id: string) => pauseFn({ data: { subscriptionId: id } }),
    onSuccess: () => {
      toast.success("Service paused. Future visits removed.");
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const resumeMut = useMutation({
    mutationFn: (id: string) => resumeFn({ data: { subscriptionId: id } }),
    onSuccess: () => {
      toast.success("Service resumed. Schedule regenerated.");
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteFn({ data: { subscriptionId: id } }),
    onSuccess: () => {
      toast.success("Service deleted");
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const prepayMut = useMutation({
    mutationFn: (v: { subscriptionId: string; visitCount: number }) => prepayFn({ data: v }),
    onSuccess: (r: any) => {
      toast.success("Prepaid invoice created");
      qc.invalidateQueries({ queryKey: ["credit", clientId] });
      window.location.href = `/invoices/${r.invoiceId}`;
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const today = todayISO();
  const nextVisitBySub = useMemo(() => {
    const map = new Map<string, string>();
    for (const v of visits) {
      if (v.status !== "scheduled" || !v.scheduled_on || v.scheduled_on < today) continue;
      const sid = (v as any).subscription_id;
      if (!sid) continue;
      const cur = map.get(sid);
      if (!cur || v.scheduled_on < cur) map.set(sid, v.scheduled_on);
    }
    return map;
  }, [visits, today]);

  const streetById = new Map(properties.map((p: any) => [p.id, p.street]));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">
          {subscriptions.length} service{subscriptions.length === 1 ? "" : "s"}
        </h2>
        {properties.length > 0 && (
          <Button size="sm" onClick={() => setDrawerSub("new")}>
            <Plus className="mr-1 h-4 w-4" /> Add Service
          </Button>
        )}
      </div>

      {subscriptions.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          {properties.length === 0
            ? "Add a property first, then set up service."
            : "No services yet. Add one to start generating visits."}
        </div>
      ) : (
        <ul className="space-y-3">
          {subscriptions.map((s: any) => {
            const ended = s.ends_on && s.ends_on < today;
            const paused = s.status === "paused";
            const started = s.started_on && s.started_on <= today;
            const nextVisit = nextVisitBySub.get(s.id);
            return (
              <li key={s.id} className="rounded-lg border bg-card p-4 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{formatFrequency(s)}</span>
                      {streetById.get(s.property_id) && (
                        <span className="text-muted-foreground">
                          at {streetById.get(s.property_id)}
                        </span>
                      )}
                      <span className="font-medium">${(s.price_cents / 100).toFixed(2)}</span>
                      <span className="text-muted-foreground">
                        {s.account_type === "residential"
                          ? `${s.dog_count} dog${s.dog_count === 1 ? "" : "s"}`
                          : `${s.unit_count} unit${s.unit_count === 1 ? "" : "s"}`}
                      </span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {ended ? (
                        <Badge variant="outline">Ended {s.ends_on}</Badge>
                      ) : paused ? (
                        <Badge variant="outline" className="border-amber-500/50 text-amber-700 dark:text-amber-400">
                          Paused
                        </Badge>
                      ) : (
                        <Badge variant="secondary">{s.status}</Badge>
                      )}
                      <Badge variant={s.billing_cadence === "prepaid" ? "default" : "secondary"}>
                        {s.billing_cadence}
                      </Badge>
                      <span>
                        {s.frequency === "one_time" ? "Visit on" : "Started"} {s.started_on}
                        {s.ends_on && !ended ? ` · ends ${s.ends_on}` : ""}
                      </span>
                      {s.preferred_weekdays?.length ? (
                        <span>{s.preferred_weekdays.map((d: number) => WEEKDAYS[d]).join(" ")}</span>
                      ) : null}
                      {!ended && !paused && (
                        <span className="inline-flex items-center gap-1">
                          <CalendarClock className="h-3 w-3" />
                          {nextVisit ? `Next visit ${nextVisit}` : "No upcoming visit scheduled"}
                        </span>
                      )}
                      {ended && s.end_reason && <span>Reason: {s.end_reason}</span>}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    {canBill && s.billing_cadence === "prepaid" && s.status === "active" && (
                      <PrepayInline
                        disabled={prepayMut.isPending}
                        onSubmit={(n: number) =>
                          prepayMut.mutate({ subscriptionId: s.id, visitCount: n })
                        }
                      />
                    )}
                    <Button size="sm" variant="outline" onClick={() => setDrawerSub(s)}>
                      Edit
                    </Button>
                    {!ended && s.status === "active" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => pauseMut.mutate(s.id)}
                        disabled={pauseMut.isPending}
                      >
                        <Pause className="mr-1 h-3.5 w-3.5" /> Pause
                      </Button>
                    )}
                    {paused && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => resumeMut.mutate(s.id)}
                        disabled={resumeMut.isPending}
                      >
                        <Play className="mr-1 h-3.5 w-3.5" /> Resume
                      </Button>
                    )}
                    {!ended && started && (
                      <Button size="sm" variant="outline" onClick={() => setEndingSub(s)}>
                        <Square className="mr-1 h-3.5 w-3.5" /> End
                      </Button>
                    )}
                    {!started && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        onClick={() => {
                          if (window.confirm("Delete this service? Only allowed before it starts."))
                            deleteMut.mutate(s.id);
                        }}
                        disabled={deleteMut.isPending}
                      >
                        <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete
                      </Button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <ServiceDrawer
        open={drawerSub !== null}
        onClose={() => setDrawerSub(null)}
        clientId={clientId}
        client={client}
        properties={properties}
        zones={zones}
        subscription={drawerSub === "new" ? null : drawerSub}
        onSaved={invalidate}
      />

      <EndServiceDialog
        subscription={endingSub}
        onClose={() => setEndingSub(null)}
        onEnded={invalidate}
      />
    </div>
  );
}

// ── Add / edit service drawer ───────────────────────────────────────────────

const SCHEDULE_CHOICES: Array<{ value: ScheduleChoice; label: string; hint: string }> = [
  { value: "weekly", label: "Weekly", hint: "Same day every week." },
  { value: "every_n_weeks", label: "Every N weeks", hint: "A fixed number of weeks between visits (every 4 weeks is not the same as monthly)." },
  { value: "twice_weekly", label: "Twice weekly", hint: "Two visits per week on chosen days." },
  { value: "monthly", label: "Monthly (calendar)", hint: "Repeats on the calendar date, e.g. the 15th of each month." },
  { value: "every_x_days", label: "Every X days", hint: "A fixed number of days between visits." },
  { value: "one_time", label: "One time", hint: "A single visit on the chosen date." },
];

function ServiceDrawer({
  open,
  onClose,
  clientId,
  client,
  properties,
  zones,
  subscription,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  clientId: string;
  client: any;
  properties: any[];
  zones: any[];
  subscription: any | null;
  onSaved: () => void;
}) {
  const createFn = useServerFn(createSubscription);
  const updateFn = useServerFn(updateSubscription);

  const initial: SubscriptionFormValues & { choice: ScheduleChoice } = useMemo(() => {
    if (subscription) {
      return {
        ...subscriptionToFormValues(subscription),
        intervalWeeks:
          subscription.frequency === "biweekly"
            ? "2"
            : subscription.interval_weeks
              ? String(subscription.interval_weeks)
              : "",
        choice: scheduleChoiceFromRecord(subscription),
      };
    }
    return { ...blankSubscriptionFormValues({ properties }), choice: "weekly" as ScheduleChoice };
  }, [subscription, properties]);

  const [form, setForm] = useState(initial);
  useEffect(() => {
    if (open) setForm(initial);
  }, [open, initial]);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const accountType = (client?.account_type ?? "residential") as "residential" | "commercial";

  const saveMut = useMutation({
    mutationFn: () => {
      const sched = scheduleChoiceToFields(form.choice, {
        intervalWeeks: form.intervalWeeks ? parseInt(form.intervalWeeks, 10) : undefined,
        intervalDays: form.intervalDays ? parseInt(form.intervalDays, 10) : undefined,
      });
      const common = {
        propertyId: form.propertyId,
        frequency: sched.frequency as any,
        intervalWeeks: sched.intervalWeeks,
        intervalDays: sched.intervalDays,
        priceCents: Math.round(parseFloat(form.priceDollars) * 100),
        dogCount: accountType === "residential" ? parseInt(form.dogCount, 10) : undefined,
        unitCount: accountType === "commercial" ? parseInt(form.unitCount, 10) : undefined,
        zoneId: form.zoneId || undefined,
        billingCadence: form.billingCadence,
        startedOn: form.startedOn || undefined,
        endsOn: form.endsOn || null,
        preferredWeekdays: form.preferredWeekdays.length ? form.preferredWeekdays : undefined,
      };
      const run = subscription
        ? updateFn({ data: { subscriptionId: subscription.id, ...common } })
        : createFn({ data: { clientId, accountType, ...common } });
      return run.then(() => ({ ok: true }));
    },
    onSuccess: () => {
      toast.success(subscription ? "Service saved" : "Service added");
      onSaved();
      onClose();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const choiceMeta = SCHEDULE_CHOICES.find((c) => c.value === form.choice)!;

  return (
    <EditDrawer
      open={open}
      onClose={onClose}
      title={subscription ? "Edit service" : "Add service"}
      size="md"
      dirty={dirty}
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (form.propertyId) saveMut.mutate();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>Property</Label>
            <select
              value={form.propertyId}
              onChange={(e) => set("propertyId", e.target.value)}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              required
            >
              <option value="">Select…</option>
              {properties.map((p: any) => (
                <option key={p.id} value={p.id}>
                  {p.street}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label>Schedule</Label>
            <select
              value={form.choice}
              onChange={(e) => set("choice", e.target.value as ScheduleChoice)}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              {SCHEDULE_CHOICES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-muted-foreground">{choiceMeta.hint}</p>
          </div>
        </div>

        {form.choice === "every_n_weeks" && (
          <div>
            <Label htmlFor="sd-nweeks">Weeks between visits</Label>
            <Input
              id="sd-nweeks"
              type="number"
              min="2"
              max="26"
              className="w-32"
              value={form.intervalWeeks || "2"}
              onChange={(e) => set("intervalWeeks", e.target.value)}
              required
            />
          </div>
        )}
        {form.choice === "every_x_days" && (
          <div>
            <Label htmlFor="sd-xdays">Days between visits</Label>
            <Input
              id="sd-xdays"
              type="number"
              min="1"
              max="90"
              className="w-32"
              value={form.intervalDays || "7"}
              onChange={(e) => set("intervalDays", e.target.value)}
              required
            />
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <Label>Price ($ per visit)</Label>
            <Input
              type="number"
              min="0"
              step="0.01"
              value={form.priceDollars}
              onChange={(e) => set("priceDollars", e.target.value)}
              required
            />
          </div>
          {accountType === "residential" ? (
            <div>
              <Label>Dogs</Label>
              <Input
                type="number"
                min="1"
                value={form.dogCount}
                onChange={(e) => set("dogCount", e.target.value)}
              />
            </div>
          ) : (
            <div>
              <Label>Units</Label>
              <Input
                type="number"
                min="1"
                value={form.unitCount}
                onChange={(e) => set("unitCount", e.target.value)}
              />
            </div>
          )}
          <div>
            <Label>Billing</Label>
            <select
              value={form.billingCadence}
              onChange={(e) => set("billingCadence", e.target.value as "postpaid" | "prepaid")}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              <option value="postpaid">Postpaid</option>
              <option value="prepaid">Prepaid</option>
            </select>
          </div>
        </div>

        <div>
          <Label>Zone (pricing)</Label>
          <select
            value={form.zoneId}
            onChange={(e) => set("zoneId", e.target.value)}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          >
            <option value="">-</option>
            {zones.map((z: any) => (
              <option key={z.id} value={z.id}>
                {z.name}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="sd-start">
              {form.choice === "one_time" ? "Visit date" : "Start date"}
            </Label>
            <Input
              id="sd-start"
              type="date"
              value={form.startedOn}
              onChange={(e) => set("startedOn", e.target.value)}
              required
            />
          </div>
          <div>
            <Label htmlFor="sd-end">End date (optional)</Label>
            <Input
              id="sd-end"
              type="date"
              value={form.endsOn}
              min={form.startedOn || undefined}
              onChange={(e) => set("endsOn", e.target.value)}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Visits stop generating after this date. Leave blank for ongoing service.
            </p>
          </div>
        </div>

        {form.choice !== "one_time" && form.choice !== "monthly" && (
          <div>
            <Label>Preferred weekdays (optional)</Label>
            <div className="mt-1 flex flex-wrap gap-2">
              {WEEKDAYS.map((d, i) => {
                const on = form.preferredWeekdays.includes(i);
                return (
                  <button
                    key={i}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      set(
                        "preferredWeekdays",
                        on
                          ? form.preferredWeekdays.filter((x) => x !== i)
                          : [...form.preferredWeekdays, i].sort(),
                      )
                    }
                    className={`rounded-md border px-3 py-1 text-xs ${on ? "border-primary bg-primary text-primary-foreground" : "bg-background"}`}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {form.choice === "twice_weekly"
                ? "Twice-weekly needs two days (e.g. Mon + Thu)."
                : "Visits land on the first selected day."}
            </p>
          </div>
        )}

        <DrawerFooter onCancel={onClose}>
          <Button type="submit" disabled={saveMut.isPending || !form.propertyId}>
            {saveMut.isPending ? "Saving…" : subscription ? "Save changes" : "Add service"}
          </Button>
        </DrawerFooter>
      </form>
    </EditDrawer>
  );
}

// ── End service dialog (drawer, small) ──────────────────────────────────────

function EndServiceDialog({
  subscription,
  onClose,
  onEnded,
}: {
  subscription: any | null;
  onClose: () => void;
  onEnded: () => void;
}) {
  const endFn = useServerFn(endSubscription);
  const [effectiveDate, setEffectiveDate] = useState(todayISO());
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (subscription) {
      setEffectiveDate(todayISO());
      setReason("");
      setNotes("");
    }
  }, [subscription]);

  const mut = useMutation({
    mutationFn: () =>
      endFn({
        data: {
          subscriptionId: subscription.id,
          effectiveDate,
          reason: reason.trim(),
          notes: notes.trim() || undefined,
        },
      }),
    onSuccess: () => {
      toast.success("Service ended");
      onEnded();
      onClose();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <EditDrawer
      open={!!subscription}
      onClose={onClose}
      title="End service"
      description="Ended services keep their history. Scheduled visits after the effective date are removed."
      size="sm"
      dirty={!!reason || !!notes}
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          mut.mutate();
        }}
      >
        <div>
          <Label htmlFor="end-date">Effective date</Label>
          <Input
            id="end-date"
            type="date"
            value={effectiveDate}
            onChange={(e) => setEffectiveDate(e.target.value)}
            required
          />
          <p className="mt-1 text-xs text-muted-foreground">
            The last day service applies. Future visits past it are removed automatically.
          </p>
        </div>
        <div>
          <Label htmlFor="end-reason">Reason</Label>
          <Input
            id="end-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Moving, cost, seasonal…"
            required
          />
        </div>
        <div>
          <Label htmlFor="end-notes">Notes (optional)</Label>
          <Textarea id="end-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <DrawerFooter onCancel={onClose}>
          <Button type="submit" variant="destructive" disabled={mut.isPending || !reason.trim()}>
            {mut.isPending ? "Ending…" : "End service"}
          </Button>
        </DrawerFooter>
      </form>
    </EditDrawer>
  );
}
