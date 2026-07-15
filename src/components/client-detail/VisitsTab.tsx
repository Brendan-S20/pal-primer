// Visits tab (spec): scheduled window and actual timing are separate,
// clearly labeled things. Missing timestamps say so instead of blurring
// estimates into facts. Rows open a detail drawer (QA follow-up 2.3) with
// permission-gated timestamp correction; >10 visits group Upcoming/Past
// with status + property filters.
import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { correctVisitTimestamps } from "@/lib/visits.functions";
import { formatDay, formatTime, formatClock } from "@/lib/format";
import { MetaChip, StatusChip } from "@/components/client-detail/primitives";
import { EditDrawer, DrawerFooter } from "@/components/client-detail/EditDrawer";

function fmtWindow(v: any): string {
  if (v.eta_start && v.eta_end) return `${formatTime(v.eta_start)} - ${formatTime(v.eta_end)}`;
  const early = v.properties?.earliest_service_time;
  const late = v.properties?.latest_service_time;
  if (early && late) return `${formatClock(early)} - ${formatClock(late)}`;
  if (early) return `After ${formatClock(early)}`;
  if (late) return `Before ${formatClock(late)}`;
  return "Anytime";
}

function durationMin(v: any): number | null {
  if (!v.started_at || !v.completed_at) return null;
  const ms = new Date(v.completed_at).getTime() - new Date(v.started_at).getTime();
  if (ms <= 0) return null;
  return Math.round(ms / 60000);
}

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function VisitsTab({
  visits,
  isLoading,
  clientId,
  subscriptions = [],
  canCorrect = false,
}: {
  visits: any[];
  isLoading: boolean;
  clientId: string;
  subscriptions?: any[];
  canCorrect?: boolean;
}) {
  const [statusFilter, setStatusFilter] = useState("all");
  const [propertyFilter, setPropertyFilter] = useState("all");
  const [detailVisit, setDetailVisit] = useState<any | null>(null);

  const serviceById = useMemo(
    () => new Map(subscriptions.map((s: any) => [s.id, s])),
    [subscriptions],
  );

  const properties = useMemo(() => {
    const set = new Map<string, string>();
    for (const v of visits) if (v.property_id && v.properties?.street) set.set(v.property_id, v.properties.street);
    return [...set.entries()];
  }, [visits]);

  const filtered = visits.filter(
    (v: any) =>
      (statusFilter === "all" || v.status === statusFilter) &&
      (propertyFilter === "all" || v.property_id === propertyFilter),
  );

  const today = todayISO();
  const grouped = visits.length > 10;
  const upcoming = filtered
    .filter((v: any) => v.scheduled_on >= today && v.status === "scheduled")
    .sort((a: any, b: any) => (a.scheduled_on < b.scheduled_on ? -1 : 1));
  const past = filtered.filter((v: any) => !(v.scheduled_on >= today && v.status === "scheduled"));

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (visits.length === 0)
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        No visits yet. They appear here once a service starts generating them.
      </div>
    );

  return (
    <div className="space-y-4">
      {grouped && (
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label htmlFor="vf-status" className="text-xs text-muted-foreground">
              Status
            </Label>
            <select
              id="vf-status"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="block h-9 rounded-md border bg-background px-2 text-sm"
            >
              <option value="all">All statuses</option>
              <option value="scheduled">Scheduled</option>
              <option value="in_progress">In progress</option>
              <option value="completed">Completed</option>
              <option value="skipped">Skipped</option>
              <option value="canceled">Canceled</option>
            </select>
          </div>
          {properties.length > 1 && (
            <div>
              <Label htmlFor="vf-prop" className="text-xs text-muted-foreground">
                Property
              </Label>
              <select
                id="vf-prop"
                value={propertyFilter}
                onChange={(e) => setPropertyFilter(e.target.value)}
                className="block h-9 rounded-md border bg-background px-2 text-sm"
              >
                <option value="all">All properties</option>
                {properties.map(([id, street]) => (
                  <option key={id} value={id}>
                    {street}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}

      {grouped ? (
        <>
          <VisitGroup title={`Upcoming (${upcoming.length})`} visits={upcoming} onOpen={setDetailVisit} serviceById={serviceById} />
          <VisitGroup title={`Past (${past.length})`} visits={past} onOpen={setDetailVisit} serviceById={serviceById} />
        </>
      ) : (
        <VisitTable visits={filtered} onOpen={setDetailVisit} serviceById={serviceById} />
      )}

      <VisitDetailDrawer
        visit={detailVisit}
        onClose={() => setDetailVisit(null)}
        clientId={clientId}
        serviceById={serviceById}
        canCorrect={canCorrect}
      />
    </div>
  );
}

function VisitGroup({
  title,
  visits,
  onOpen,
  serviceById,
}: {
  title: string;
  visits: any[];
  onOpen: (v: any) => void;
  serviceById: Map<string, any>;
}) {
  return (
    <section>
      <h3 className="mb-2 text-sm font-medium text-muted-foreground">{title}</h3>
      {visits.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
          Nothing here with the current filters.
        </p>
      ) : (
        <VisitTable visits={visits} onOpen={onOpen} serviceById={serviceById} />
      )}
    </section>
  );
}

function VisitTable({
  visits,
  onOpen,
  serviceById,
}: {
  visits: any[];
  onOpen: (v: any) => void;
  serviceById: Map<string, any>;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border bg-card">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-4 py-2.5 font-medium">Date</th>
            <th className="px-4 py-2.5 font-medium">Scheduled window</th>
            <th className="px-4 py-2.5 font-medium">Actual start</th>
            <th className="px-4 py-2.5 font-medium">Actual completion</th>
            <th className="px-4 py-2.5 font-medium">Duration</th>
            <th className="px-4 py-2.5 font-medium">Status</th>
            <th className="px-4 py-2.5 font-medium">Service</th>
            <th className="px-4 py-2.5 font-medium">Property</th>
            <th className="px-4 py-2.5 font-medium">Tech</th>
          </tr>
        </thead>
        <tbody>
          {visits.map((v: any) => {
            const done = v.status === "completed";
            const inProgress = v.status === "in_progress";
            const dur = durationMin(v);
            const service = v.subscription_id ? serviceById.get(v.subscription_id) : null;
            return (
              <tr
                key={v.id}
                onClick={() => onOpen(v)}
                className="cursor-pointer border-b last:border-0 hover:bg-muted/40"
              >
                <td className="whitespace-nowrap px-4 py-2.5">
                  {formatDay(v.scheduled_on)}
                  {v.rescheduled_from && (
                    <span className="ml-1 text-xs text-muted-foreground">
                      (moved from {formatDay(v.rescheduled_from)})
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground">{fmtWindow(v)}</td>
                <td className="whitespace-nowrap px-4 py-2.5">
                  {v.started_at ? (
                    formatTime(v.started_at)
                  ) : done || inProgress ? (
                    <span className="text-xs italic text-muted-foreground">Arrival not recorded</span>
                  ) : (
                    <span className="text-muted-foreground">Not started</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5">
                  {v.completed_at ? (
                    formatTime(v.completed_at)
                  ) : done ? (
                    <span className="text-xs italic text-muted-foreground">
                      Completion not recorded
                    </span>
                  ) : (
                    <span className="text-muted-foreground">Not completed</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5">
                  {dur != null ? `${dur} min` : <span className="text-muted-foreground">Not recorded</span>}
                </td>
                <td className="px-4 py-2.5">
                  <StatusChip status={v.status} />
                  {v.status === "skipped" && (v.skip_reason_code || v.skip_reason) && (
                    <span className="ml-1 text-xs text-muted-foreground">
                      {String(v.skip_reason_code ?? v.skip_reason).replace(/_/g, " ")}
                    </span>
                  )}
                  {v.is_deepclean && <MetaChip className="ml-1">Deep clean</MetaChip>}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground">
                  {service ? `${service.frequency === "one_time" ? "One time" : "Recurring"} service` : "-"}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground">
                  {v.properties?.street ?? "-"}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground">
                  {v.staff?.display_name ?? "Unassigned"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Detail drawer with permission-gated timestamp correction ───────────────

function toLocalInput(ts: string | null): string {
  if (!ts) return "";
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function VisitDetailDrawer({
  visit: v,
  onClose,
  clientId,
  serviceById,
  canCorrect,
}: {
  visit: any | null;
  onClose: () => void;
  clientId: string;
  serviceById: Map<string, any>;
  canCorrect: boolean;
}) {
  const qc = useQueryClient();
  const correctFn = useServerFn(correctVisitTimestamps);
  const [correcting, setCorrecting] = useState(false);
  const [startedAt, setStartedAt] = useState("");
  const [completedAt, setCompletedAt] = useState("");
  const [reason, setReason] = useState("");

  const mut = useMutation({
    mutationFn: () =>
      correctFn({
        data: {
          visitId: v.id,
          startedAt: fromLocalInput(startedAt),
          completedAt: fromLocalInput(completedAt),
          reason: reason.trim(),
        },
      }),
    onSuccess: () => {
      toast.success("Timestamps corrected");
      setCorrecting(false);
      setReason("");
      qc.invalidateQueries({ queryKey: ["client-visit-history", clientId] });
      qc.invalidateQueries({ queryKey: ["client-activity", clientId] });
      onClose();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  if (!v) return null;
  const service = v.subscription_id ? serviceById.get(v.subscription_id) : null;
  const dur = durationMin(v);

  return (
    <EditDrawer
      open={!!v}
      onClose={onClose}
      title={`Visit on ${formatDay(v.scheduled_on)}`}
      size="sm"
      dirty={correcting && (!!reason || !!startedAt || !!completedAt)}
    >
      <div className="space-y-4 text-sm">
        <dl className="space-y-2">
          <div className="flex items-center justify-between">
            <dt className="text-muted-foreground">Status</dt>
            <dd>
              <StatusChip status={v.status} />
            </dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-muted-foreground">Scheduled window</dt>
            <dd>{fmtWindow(v)}</dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-muted-foreground">Actual start</dt>
            <dd>{v.started_at ? formatTime(v.started_at) : "Arrival not recorded"}</dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-muted-foreground">Actual completion</dt>
            <dd>{v.completed_at ? formatTime(v.completed_at) : "Completion not recorded"}</dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-muted-foreground">Duration</dt>
            <dd>{dur != null ? `${dur} min` : "Not recorded"}</dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-muted-foreground">Technician</dt>
            <dd>{v.staff?.display_name ?? "Unassigned"}</dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-muted-foreground">Property</dt>
            <dd>{v.properties?.street ?? "-"}</dd>
          </div>
          {service && (
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">Service</dt>
              <dd>${(service.price_cents / 100).toFixed(2)} /visit</dd>
            </div>
          )}
          {(v.skip_reason_code || v.skip_reason) && (
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">Skip reason</dt>
              <dd>{String(v.skip_reason_code ?? v.skip_reason).replace(/_/g, " ")}</dd>
            </div>
          )}
        </dl>

        {canCorrect && (v.status === "completed" || v.status === "in_progress") && (
          <div className="rounded-md border bg-muted/20 p-3">
            {!correcting ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setStartedAt(toLocalInput(v.started_at));
                  setCompletedAt(toLocalInput(v.completed_at));
                  setCorrecting(true);
                }}
              >
                Correct timestamps
              </Button>
            ) : (
              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (reason.trim()) mut.mutate();
                }}
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="vc-start" className="text-xs">
                      Actual start
                    </Label>
                    <Input
                      id="vc-start"
                      type="datetime-local"
                      value={startedAt}
                      onChange={(e) => setStartedAt(e.target.value)}
                    />
                  </div>
                  <div>
                    <Label htmlFor="vc-end" className="text-xs">
                      Actual completion
                    </Label>
                    <Input
                      id="vc-end"
                      type="datetime-local"
                      value={completedAt}
                      onChange={(e) => setCompletedAt(e.target.value)}
                    />
                  </div>
                </div>
                <div>
                  <Label htmlFor="vc-reason" className="text-xs">
                    Reason for correction
                  </Label>
                  <Input
                    id="vc-reason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="e.g. tech forgot to tap Complete"
                    required
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Corrections are recorded on the Activity timeline with before and after values.
                </p>
                <div className="flex gap-2">
                  <Button type="submit" size="sm" disabled={mut.isPending || !reason.trim()}>
                    {mut.isPending ? "Saving…" : "Save correction"}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setCorrecting(false)}>
                    Cancel
                  </Button>
                </div>
              </form>
            )}
          </div>
        )}

        <DrawerFooter>
          <span />
        </DrawerFooter>
      </div>
    </EditDrawer>
  );
}
