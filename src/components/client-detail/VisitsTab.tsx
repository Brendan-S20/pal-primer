import i18n from "@/lib/i18n";
import { warnLessonClashes } from "@/components/training/lessonClashWarning";
// Visits tab (spec): scheduled window and actual timing are separate,
// clearly labeled things. Missing timestamps say so instead of blurring
// estimates into facts. Rows open a detail drawer (QA follow-up 2.3) with
// permission-gated timestamp correction; >10 visits group Upcoming/Past
// with status + property filters.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { CalendarClock, CalendarOff, ChevronLeft, ChevronRight, Scissors, X } from "lucide-react";
import { usePermissions } from "@/hooks/useMyRole";
import { useServiceLines } from "@/components/CommercialOnly";
import { BookGroomDialog } from "@/components/BookGroomDialog";
import { OneOffVisitDialog } from "@/components/OneOffVisitDialog";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useRowSelection } from "@/hooks/useRowSelection";
import {
  correctVisitTimestamps,
  completeVisitFromOffice,
  rescheduleVisitFromOffice,
  cancelVisitFromOffice,
  reassignVisit,
  listStaff,
} from "@/lib/visits.functions";
import { listClientHolds } from "@/lib/clients.functions";
import { notifyCanceledWalks } from "@/lib/walk-notify.functions";
import { formatDay, formatTime, formatClock } from "@/lib/format";
import { useOrgTimezone } from "@/hooks/useOrgToday";
import { formatVisitDuration } from "@/lib/visit-lifecycle";
import { officeSkipReason } from "@/lib/skip-rules.functions";
import { MetaChip, StatusChip } from "@/components/client-detail/primitives";
import { RowActions } from "@/components/RowActions";
import { EditDrawer, DrawerFooter } from "@/components/client-detail/EditDrawer";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { CompletedVisitActions } from "@/components/CompletedVisitActions";
import {
  ClientCalledAtField,
  clientCalledAtIso,
  nowAsCalledAt,
} from "@/components/training/ClientCalledAtField";

/** A skip's reason as words: a code through the office's labels, free text
 *  (from before reasons were codes) as it was typed. */
function skipReasonText(v: { skip_reason_code?: string | null; skip_reason?: string | null }) {
  return v.skip_reason_code ? officeSkipReason(v.skip_reason_code) : (v.skip_reason ?? "");
}

function fmtWindow(v: any, tz: string): string {
  // ETAs are instants and read on the ORG's clock; the service/property
  // windows below are `time` columns (wall clock, no zone) and stay as-is.
  if (v.eta_start && v.eta_end)
    return `${formatTime(v.eta_start, tz)} - ${formatTime(v.eta_end, tz)}`;
  // The arrival window lives on the service (UX round 4); the property
  // window is a legacy fallback for rows whose service has none.
  const sub = v.subscriptions;
  const useSub = !!(sub?.earliest_time || sub?.latest_time);
  const early = useSub ? sub.earliest_time : v.properties?.earliest_service_time;
  const late = useSub ? sub.latest_time : v.properties?.latest_service_time;
  if (early && late) return `${formatClock(early)} - ${formatClock(late)}`;
  if (early) return `After ${formatClock(early)}`;
  if (late) return `Before ${formatClock(late)}`;
  return "Anytime";
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
  const tz = useOrgTimezone();
  const [statusFilter, setStatusFilter] = useState("all");
  const [propertyFilter, setPropertyFilter] = useState("all");
  // The open visit by id, read from the list on every render, so a change
  // made in the popup (Reopen, Mark missed) shows there once the list
  // refetches, without closing it.
  const [detailVisitId, setDetailVisitId] = useState<string | null>(null);
  const detailVisit = detailVisitId ? (visits.find((x) => x.id === detailVisitId) ?? null) : null;
  const setDetailVisit = (v: any | null) => setDetailVisitId(v?.id ?? null);
  const [view, setView] = useState<"list" | "calendar">("list");
  // The client-scoped entry to the one-off booking. This is the surface that
  // makes OneOffVisitDialog's `clientId` prop mean anything — it shipped with
  // the prop and nothing passing it, which is the built-and-uncalled pattern
  // the dead-machinery check exists for, in TypeScript where that check cannot
  // see it.
  const [oneOffOpen, setOneOffOpen] = useState(false);
  const [groomOpen, setGroomOpen] = useState(false);
  const { can } = usePermissions();
  const canBookOneOff = can("manage_pricing");
  const { lines } = useServiceLines();
  const runsGrooming = lines.includes("mobile_grooming");

  // Vacation hold banner (QA round 8): an active or upcoming hold explains
  // why no visits exist in a range. Managed from the header's ••• menu.
  const listHoldsFn = useServerFn(listClientHolds);
  const { data: holdsData } = useQuery({
    queryKey: ["client-holds", clientId],
    queryFn: () => listHoldsFn({ data: { clientId } }),
  });
  const activeHold = useMemo(() => {
    const today = todayISO();
    const holds = ((holdsData as any)?.holds ?? []) as any[];
    return (
      holds
        .filter((h) => h.ends_on >= today)
        .sort((a, b) => (a.starts_on < b.starts_on ? -1 : 1))[0] ?? null
    );
  }, [holdsData]);

  const serviceById = useMemo(
    () => new Map(subscriptions.map((s: any) => [s.id, s])),
    [subscriptions],
  );

  const properties = useMemo(() => {
    const set = new Map<string, string>();
    for (const v of visits)
      if (v.property_id && v.properties?.street) set.set(v.property_id, v.properties.street);
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

  // ── Bulk actions over upcoming scheduled visits ──────────────────────────
  // Cancel and reassign loop the SAME office server fns the detail drawer
  // uses (cancelVisitFromOffice / reassignVisit) — no new visit semantics.
  // Selection is offered only when the caller can perform office actions.
  const qc = useQueryClient();
  const { confirm, dialog: bulkConfirmDialog } = useConfirmDialog();
  const bulkCancelFn = useServerFn(cancelVisitFromOffice);
  const notifyWalksFn = useServerFn(notifyCanceledWalks);
  const runsWalks = useServiceLines().lines.includes("dog_walking");
  const bulkReassignFn = useServerFn(reassignVisit);
  const bulkStaffFn = useServerFn(listStaff);

  const upcomingIds = upcoming.map((v: any) => v.id as string);
  const sel = useRowSelection(upcomingIds, `${statusFilter}|${propertyFilter}`);

  const [bulkAction, setBulkAction] = useState<"cancel" | "reassign" | null>(null);
  const [bulkCancelCode, setBulkCancelCode] = useState("other");
  const [bulkCancelReason, setBulkCancelReason] = useState("");
  const [bulkStaffId, setBulkStaffId] = useState("");

  const bulkStaffQ = useQuery({
    queryKey: ["org-staff"],
    queryFn: () => bulkStaffFn(),
    enabled: canCorrect && bulkAction === "reassign",
    staleTime: 60_000,
  });
  const bulkStaff = (((bulkStaffQ.data as any)?.staff ?? []) as any[]).filter(
    (s: any) => s.is_field_tech !== false,
  );

  const afterBulk = (r: { ok: number; failed: number }, verb: string) => {
    if (r.failed) toast.error(`${verb} ${r.ok} of ${r.ok + r.failed} visits, ${r.failed} failed`);
    else toast.success(`${verb} ${r.ok} visit${r.ok === 1 ? "" : "s"}`);
    sel.clear();
    setBulkAction(null);
    setBulkCancelReason("");
    setBulkStaffId("");
    qc.invalidateQueries({ queryKey: ["client-visit-history", clientId] });
    qc.invalidateQueries({ queryKey: ["client-activity", clientId] });
  };

  const bulkCancelM = useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(
        ids.map((visitId) =>
          bulkCancelFn({
            data: {
              visitId,
              reason: bulkCancelReason.trim(),
              code: bulkCancelCode as any,
              // A walk's client gets one email for the whole set, below.
              notifyClient: !runsWalks,
            },
          }),
        ),
      );
      const canceled = ids.filter((_, i) => results[i].status === "fulfilled");
      if (runsWalks && canceled.length > 0) {
        await notifyWalksFn({ data: { visitIds: canceled } }).catch(() => undefined);
      }
      const ok = results.filter((r) => r.status === "fulfilled").length;
      return { ok, failed: results.length - ok };
    },
    onSuccess: (r) => afterBulk(r, "Canceled"),
    onError: (e) => toast.error((e as Error).message),
  });

  const bulkReassignM = useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(
        ids.map((visitId) => bulkReassignFn({ data: { visitId, staffId: bulkStaffId || null } })),
      );
      for (const r of results) if (r.status === "fulfilled") warnLessonClashes(r.value);
      const ok = results.filter((r) => r.status === "fulfilled").length;
      const clash = results.find((r) => r.status === "fulfilled" && r.value.clash);
      return {
        ok,
        failed: results.length - ok,
        clash: clash?.status === "fulfilled" ? clash.value.clash : null,
      };
    },
    onSuccess: (r) => {
      afterBulk(r, bulkStaffId ? "Reassigned" : "Unassigned");
      if (r.clash) toast.warning(r.clash);
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const selection: TableSelection | undefined =
    canCorrect && upcomingIds.length > 0
      ? {
          canSelect: (v: any) => v.status === "scheduled" && v.scheduled_on >= today,
          isSelected: sel.isSelected,
          onToggle: sel.toggle,
          allSelected: sel.allSelected,
          onToggleAll: sel.toggleAll,
        }
      : undefined;

  const holdBanner = activeHold ? (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
      <CalendarOff className="h-4 w-4 shrink-0" />
      <span>
        {activeHold.starts_on > today
          ? `Vacation hold ${formatDay(activeHold.starts_on)} to ${formatDay(activeHold.ends_on)}`
          : `On hold until ${formatDay(activeHold.ends_on)}`}
        {". No visits are scheduled or generated in that range."}
        {activeHold.reason ? ` Reason: ${activeHold.reason}.` : ""}
      </span>
    </div>
  ) : null;

  const booked = () => {
    qc.invalidateQueries({ queryKey: ["client-visit-history", clientId] });
    qc.invalidateQueries({ queryKey: ["client-activity", clientId] });
  };
  const bookButtons = canBookOneOff ? (
    <div className="flex flex-wrap items-center gap-2">
      {runsGrooming && (
        <Button size="sm" variant="outline" onClick={() => setGroomOpen(true)}>
          <Scissors className="me-1.5 h-4 w-4 shrink-0" />
          Book a groom
        </Button>
      )}
      <Button size="sm" variant="outline" onClick={() => setOneOffOpen(true)}>
        <CalendarClock className="me-1.5 h-4 w-4 shrink-0" />
        Book a visit
      </Button>
    </div>
  ) : null;
  const bookDialogs = (
    <>
      <OneOffVisitDialog
        open={oneOffOpen}
        onOpenChange={setOneOffOpen}
        clientId={clientId}
        onCreated={booked}
      />
      {runsGrooming && (
        <BookGroomDialog
          open={groomOpen}
          onOpenChange={setGroomOpen}
          clientId={clientId}
          onCreated={booked}
        />
      )}
    </>
  );

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (visits.length === 0)
    return (
      <div className="space-y-4">
        {holdBanner}
        <div className="flex flex-wrap items-center justify-end gap-2">{bookButtons}</div>
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          No visits yet. They appear here once a service starts generating them.
        </div>
        {bookDialogs}
      </div>
    );

  return (
    <div className="space-y-4">
      {holdBanner}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="mr-auto flex flex-wrap items-end gap-3">
          {grouped && (
            <>
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
                  <option value="missed">Missed</option>
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
            </>
          )}
        </div>
        {bookButtons}
        <div className="flex items-center gap-1" role="group" aria-label="View">
          <Button
            size="sm"
            variant={view === "list" ? "default" : "outline"}
            aria-pressed={view === "list"}
            onClick={() => setView("list")}
          >
            List
          </Button>
          <Button
            size="sm"
            variant={view === "calendar" ? "default" : "outline"}
            aria-pressed={view === "calendar"}
            onClick={() => setView("calendar")}
          >
            Calendar
          </Button>
        </div>
      </div>

      {bookDialogs}

      {bulkConfirmDialog}

      {/* Bulk action bar — appears once upcoming visits are checked */}
      {canCorrect && sel.count > 0 && view !== "calendar" && (
        <div className="space-y-3 rounded-xl border bg-accent/40 px-4 py-2 text-sm shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">
              {sel.count} visit{sel.count === 1 ? "" : "s"} selected
            </span>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant={bulkAction === "reassign" ? "default" : "outline"}
                onClick={() => setBulkAction(bulkAction === "reassign" ? null : "reassign")}
              >
                Reassign to tech…
              </Button>
              <Button
                size="sm"
                variant={bulkAction === "cancel" ? "destructive" : "outline"}
                className={bulkAction === "cancel" ? undefined : "text-destructive"}
                onClick={() => setBulkAction(bulkAction === "cancel" ? null : "cancel")}
              >
                Cancel visits…
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  sel.clear();
                  setBulkAction(null);
                }}
              >
                Clear
              </Button>
            </div>
          </div>

          {bulkAction === "reassign" && (
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                bulkReassignM.mutate(sel.selectedIds);
              }}
            >
              <div>
                <Label htmlFor="bulk-staff" className="text-xs">
                  Technician
                </Label>
                <select
                  id="bulk-staff"
                  value={bulkStaffId}
                  onChange={(e) => setBulkStaffId(e.target.value)}
                  className="block h-9 w-56 rounded-md border bg-background px-2 text-sm"
                >
                  <option value="">Unassigned</option>
                  {bulkStaff.map((s: any) => (
                    <option key={s.id} value={s.id}>
                      {s.display_name}
                    </option>
                  ))}
                </select>
              </div>
              <Button type="submit" size="sm" disabled={bulkReassignM.isPending}>
                {bulkReassignM.isPending
                  ? "Reassigning…"
                  : `Reassign ${sel.count} visit${sel.count === 1 ? "" : "s"}`}
              </Button>
            </form>
          )}

          {bulkAction === "cancel" && (
            <form
              className="space-y-2"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!bulkCancelReason.trim()) return;
                if (
                  await confirm({
                    title: `Cancel ${sel.count} visit${sel.count === 1 ? "" : "s"}?`,
                    description:
                      "Each visit is recorded as skipped with this reason; the org's skip-billing rules decide whether any charge applies.",
                    destructive: true,
                    confirmLabel: `Cancel ${sel.count} visit${sel.count === 1 ? "" : "s"}`,
                  })
                )
                  bulkCancelM.mutate(sel.selectedIds);
              }}
            >
              <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <Label htmlFor="bulk-cancel-code" className="text-xs">
                    Reason code
                  </Label>
                  <select
                    id="bulk-cancel-code"
                    value={bulkCancelCode}
                    onChange={(e) => setBulkCancelCode(e.target.value)}
                    className="block h-9 w-full rounded-md border bg-background px-2 text-sm"
                  >
                    {SKIP_CODES.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor="bulk-cancel-reason" className="text-xs">
                    Reason
                  </Label>
                  <Input
                    id="bulk-cancel-reason"
                    value={bulkCancelReason}
                    onChange={(e) => setBulkCancelReason(e.target.value)}
                    placeholder="Required"
                    required
                  />
                </div>
              </div>
              <Button
                type="submit"
                size="sm"
                variant="destructive"
                disabled={bulkCancelM.isPending || !bulkCancelReason.trim()}
              >
                {bulkCancelM.isPending
                  ? "Canceling…"
                  : `Cancel ${sel.count} visit${sel.count === 1 ? "" : "s"}`}
              </Button>
            </form>
          )}
        </div>
      )}

      {view === "calendar" ? (
        <VisitCalendar visits={filtered} onOpen={setDetailVisit} />
      ) : grouped ? (
        <>
          <VisitGroup
            title={`Upcoming (${upcoming.length})`}
            visits={upcoming}
            onOpen={setDetailVisit}
            serviceById={serviceById}
            selection={selection}
          />
          <VisitGroup
            title={`Past (${past.length})`}
            visits={past}
            onOpen={setDetailVisit}
            serviceById={serviceById}
          />
        </>
      ) : (
        <VisitTable
          visits={filtered}
          onOpen={setDetailVisit}
          serviceById={serviceById}
          selection={selection}
        />
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

/** Selection wiring passed down to a VisitTable (bulk actions on upcoming
 * scheduled visits). Rows failing canSelect render an empty checkbox cell. */
type TableSelection = {
  canSelect: (v: any) => boolean;
  isSelected: (id: string) => boolean;
  onToggle: (id: string, next: boolean) => void;
  allSelected: boolean;
  onToggleAll: () => void;
};

function VisitGroup({
  title,
  visits,
  onOpen,
  serviceById,
  selection,
}: {
  title: string;
  visits: any[];
  onOpen: (v: any) => void;
  serviceById: Map<string, any>;
  selection?: TableSelection;
}) {
  return (
    <section>
      <h3 className="mb-2 text-sm font-medium text-muted-foreground">{title}</h3>
      {visits.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
          Nothing here with the current filters.
        </p>
      ) : (
        <VisitTable
          visits={visits}
          onOpen={onOpen}
          serviceById={serviceById}
          selection={selection}
        />
      )}
    </section>
  );
}

function VisitTable({
  visits,
  onOpen,
  serviceById,
  selection,
}: {
  visits: any[];
  onOpen: (v: any) => void;
  serviceById: Map<string, any>;
  selection?: TableSelection;
}) {
  const tz = useOrgTimezone();
  return (
    <div className="relative overflow-x-auto rounded-lg border bg-card shadow-sm">
      <table className="w-full text-sm min-w-[990px]">
        <thead>
          <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
            {selection && (
              <th className="w-10 px-4 py-2.5">
                <Checkbox
                  checked={selection.allSelected}
                  onCheckedChange={selection.onToggleAll}
                  aria-label="Select all upcoming visits"
                />
              </th>
            )}
            <th className="px-4 py-2.5 font-medium">Date</th>
            <th className="px-4 py-2.5 font-medium">Scheduled window</th>
            <th className="px-4 py-2.5 font-medium">Actual start</th>
            <th className="px-4 py-2.5 font-medium">Actual completion</th>
            <th className="px-4 py-2.5 font-medium">Duration</th>
            <th className="px-4 py-2.5 font-medium">Status</th>
            <th className="px-4 py-2.5 font-medium">Service</th>
            <th className="px-4 py-2.5 font-medium">Property</th>
            <th className="px-4 py-2.5 font-medium">Tech</th>
            <th className="w-24 px-4 py-2.5 text-right font-medium">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {visits.map((v: any) => {
            const done = v.status === "completed";
            const inProgress = v.status === "in_progress";
            const durText = formatVisitDuration(v.started_at, v.completed_at);
            const service = v.subscription_id ? serviceById.get(v.subscription_id) : null;
            return (
              <tr
                key={v.id}
                onClick={() => onOpen(v)}
                className="cursor-pointer border-b last:border-0 hover:bg-muted/40"
              >
                {selection && (
                  <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                    {selection.canSelect(v) ? (
                      <Checkbox
                        checked={selection.isSelected(v.id)}
                        onCheckedChange={(next) => selection.onToggle(v.id, !!next)}
                        aria-label={`Select visit on ${formatDay(v.scheduled_on)}`}
                      />
                    ) : null}
                  </td>
                )}
                <td className="px-4 py-2.5">
                  <div className="whitespace-nowrap">
                    {formatDay(v.scheduled_on)}
                    {v.rescheduled_from && (
                      <span className="ms-1 text-xs text-muted-foreground">
                        (moved from {formatDay(v.rescheduled_from)})
                      </span>
                    )}
                  </div>
                  {v.groom_summary && (
                    <div className="mt-0.5 max-w-64 whitespace-normal text-xs text-muted-foreground [overflow-wrap:anywhere]">
                      {v.groom_summary}
                      {v.duration_min ? ` · ${v.duration_min} min` : ""}
                    </div>
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground">
                  {fmtWindow(v, tz)}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5">
                  {v.started_at ? (
                    formatTime(v.started_at, tz)
                  ) : done || inProgress ? (
                    <span className="text-xs italic text-muted-foreground">
                      Arrival not recorded
                    </span>
                  ) : (
                    <span className="text-muted-foreground">Not started</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5">
                  {v.completed_at ? (
                    formatTime(v.completed_at, tz)
                  ) : done ? (
                    <span className="text-xs italic text-muted-foreground">
                      Completion not recorded
                    </span>
                  ) : (
                    <span className="text-muted-foreground">Not completed</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5">
                  {/* BUG-9: "Needs review" means the timestamps contradict each
                      other (known-bad), which is a different thing from a
                      timestamp simply never being recorded. Amber so it reads as
                      an item of work rather than an absence. */}
                  {durText === "Needs review" ? (
                    <span
                      className="text-amber-600 dark:text-amber-400"
                      title="Start and completion were recorded as the same instant, so the real duration is unknown. This visit needs a human to confirm what happened."
                    >
                      Needs review
                    </span>
                  ) : durText === "Not recorded" ? (
                    <span className="text-muted-foreground">Not recorded</span>
                  ) : (
                    durText
                  )}
                </td>
                <td className="px-4 py-2.5">
                  <StatusChip label={i18n.t(`status.${v.status}`, { defaultValue: "Visit" })} status={v.status} />
                  {v.status === "skipped" && (v.skip_reason_code || v.skip_reason) && (
                    <span className="ml-1 text-xs text-muted-foreground">
                      {skipReasonText(v)}
                    </span>
                  )}
                  {v.is_deepclean && <MetaChip className="ml-1">Deep clean</MetaChip>}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground">
                  {service
                    ? `${service.frequency === "one_time" ? "One time" : "Recurring"} service`
                    : "-"}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground">
                  {v.properties?.street ?? "-"}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground">
                  {v.staff?.display_name ?? "Unassigned"}
                </td>
                <td className="px-4 py-2.5 text-right">
                  {/* Visit actions (complete / reschedule / reassign / cancel)
                      are permission-gated inside the detail drawer, so the
                      row offers View plus an explicit Open item — same
                      destination as the row click. */}
                  <RowActions
                    view={{
                      label: `View visit on ${formatDay(v.scheduled_on)}`,
                      onSelect: () => onOpen(v),
                    }}
                    actions={[{ label: "Open visit", onSelect: () => onOpen(v) }]}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Calendar view ───────────────────────────────────────────────────────────

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Same tones StatusChip uses for visit statuses (chips here must be buttons,
// so the span-based StatusChip does not fit).
const CHIP_TONES: Record<string, string> = {
  scheduled: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  in_progress: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  completed: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  missed: "bg-orange-500/15 text-orange-700 dark:text-orange-400",
  skipped: "bg-muted text-muted-foreground",
  canceled: "bg-destructive/15 text-destructive",
};

/** Local YYYY-MM-DD key for a Date (no UTC parsing pitfalls). */
function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function statusLabel(s: string): string {
  const words = String(s).replace(/[_-]/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

function VisitCalendar({ visits, onOpen }: { visits: any[]; onOpen: (v: any) => void }) {
  const tz = useOrgTimezone();
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });

  const byDay = useMemo(() => {
    const map = new Map<string, any[]>();
    for (const v of visits) {
      // scheduled_on is a date-only string; compare by string, never new Date(s).
      const key = String(v.scheduled_on ?? "").slice(0, 10);
      if (!key) continue;
      const list = map.get(key);
      if (list) list.push(v);
      else map.set(key, [v]);
    }
    return map;
  }, [visits]);

  const weeks = useMemo(() => {
    // First cell is the Sunday on or before the 1st; always render 6 weeks.
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const start = new Date(first.getFullYear(), first.getMonth(), 1 - first.getDay());
    const rows: Date[][] = [];
    for (let w = 0; w < 6; w++) {
      const row: Date[] = [];
      for (let d = 0; d < 7; d++) {
        row.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + d));
      }
      rows.push(row);
    }
    return rows;
  }, [month]);

  const todayKey = todayISO();
  const monthLabel = month.toLocaleString([], { month: "long", year: "numeric" });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          aria-label="Previous month"
          onClick={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
        >
          <ChevronLeft className="h-4 w-4 shrink-0" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          aria-label="Next month"
          onClick={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
        >
          <ChevronRight className="h-4 w-4 shrink-0" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            const now = new Date();
            setMonth(new Date(now.getFullYear(), now.getMonth(), 1));
          }}
        >
          Today
        </Button>
        <span className="ml-1 text-sm font-medium">{monthLabel}</span>
      </div>

      <div className="relative overflow-x-auto rounded-lg border bg-card shadow-sm">
        <table role="grid" className="w-full min-w-[560px] table-fixed text-sm">
          <thead>
            <tr className="border-b">
              {WEEKDAYS.map((d) => (
                <th
                  key={d}
                  scope="col"
                  className="px-1.5 py-2 text-center text-xs font-medium uppercase tracking-wide text-muted-foreground"
                >
                  {d}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weeks.map((week, wi) => (
              <tr key={wi} className="border-b last:border-0">
                {week.map((day) => {
                  const key = dateKey(day);
                  const inMonth = day.getMonth() === month.getMonth();
                  const isToday = key === todayKey;
                  const dayVisits = byDay.get(key) ?? [];
                  const shown = dayVisits.slice(0, 3);
                  const hiddenCount = dayVisits.length - shown.length;
                  return (
                    <td key={key} className="border-r p-1 align-top last:border-r-0">
                      <div className="min-h-[5.5rem] space-y-1">
                        <span
                          className={cn(
                            "inline-flex h-6 w-6 items-center justify-center rounded-full text-xs",
                            !inMonth && "text-muted-foreground/50",
                            isToday && "font-semibold text-primary ring-1 ring-primary",
                          )}
                        >
                          {day.getDate()}
                        </span>
                        {shown.map((v: any) => (
                          <button
                            key={v.id}
                            type="button"
                            onClick={() => onOpen(v)}
                            title={`${v.properties?.street ?? "Visit"} - ${fmtWindow(v, tz)}`}
                            aria-label={`${statusLabel(v.status)} visit at ${v.properties?.street ?? "unknown property"} on ${formatDay(v.scheduled_on)}`}
                            className={cn(
                              "block w-full truncate rounded-md px-1.5 py-0.5 text-left text-xs font-medium",
                              CHIP_TONES[v.status] ?? "bg-muted text-muted-foreground",
                            )}
                          >
                            {v.properties?.street ??
                              (v.eta_start ? formatTime(v.eta_start, tz) : "Visit")}
                          </button>
                        ))}
                        {hiddenCount > 0 && (
                          <button
                            type="button"
                            onClick={() => onOpen(dayVisits[3])}
                            title={`${hiddenCount} more ${hiddenCount === 1 ? "visit" : "visits"} on ${formatDay(key)}`}
                            className="block w-full truncate rounded-md px-1.5 py-0.5 text-left text-xs text-muted-foreground hover:bg-muted"
                          >
                            +{hiddenCount} more
                          </button>
                        )}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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

const SKIP_CODES: Array<{ value: string; label: string }> = [
  { value: "client_cancelled_late", label: "Client canceled late" },
  { value: "gate_locked", label: "Gate locked" },
  { value: "dog_outside", label: "Dog outside" },
  { value: "weather", label: "Weather" },
  { value: "our_fault", label: "Our fault" },
  { value: "access_blocked", label: "Access blocked" },
  { value: "unsafe_conditions", label: "Unsafe conditions" },
  { value: "other", label: "Other" },
];

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
  const tz = useOrgTimezone();
  const qc = useQueryClient();
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
  const correctFn = useServerFn(correctVisitTimestamps);
  const [correcting, setCorrecting] = useState(false);
  const [startedAt, setStartedAt] = useState("");
  const [completedAt, setCompletedAt] = useState("");
  const [reason, setReason] = useState("");

  // Office actions (QA round 8): complete / reschedule / cancel / reassign.
  const [action, setAction] = useState<"reschedule" | "cancel" | "reassign" | null>(null);
  const [newDate, setNewDate] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  const [cancelCode, setCancelCode] = useState("other");
  // On a training package lesson: when the client called to cancel.
  const [calledAt, setCalledAt] = useState("");
  const [newStaffId, setNewStaffId] = useState("");

  const completeFn = useServerFn(completeVisitFromOffice);
  const rescheduleFn = useServerFn(rescheduleVisitFromOffice);
  const cancelFn = useServerFn(cancelVisitFromOffice);
  const reassignFn = useServerFn(reassignVisit);
  const listStaffFn = useServerFn(listStaff);

  const scheduled = v?.status === "scheduled";
  // A missed visit is recoverable (B6 finding 2): it can be retroactively
  // completed if it was actually serviced, or rescheduled for a make-up.
  const missed = v?.status === "missed";
  const { data: staffData } = useQuery({
    queryKey: ["org-staff"],
    queryFn: () => listStaffFn(),
    enabled: canCorrect && scheduled,
    staleTime: 60_000,
  });
  const staff = ((staffData as any)?.staff ?? []).filter((s: any) => s.is_field_tech !== false);

  const afterAction = (msg: string, clash?: string | null) => {
    toast.success(msg);
    if (clash) toast.warning(clash);
    setAction(null);
    setNewDate("");
    setCancelReason("");
    setNewStaffId("");
    qc.invalidateQueries({ queryKey: ["client-visit-history", clientId] });
    qc.invalidateQueries({ queryKey: ["client-activity", clientId] });
    onClose();
  };

  const completeMut = useMutation({
    mutationFn: () => completeFn({ data: { visitId: v.id } }),
    onSuccess: () => afterAction("Visit marked completed"),
    onError: (e) => toast.error((e as Error).message),
  });
  const rescheduleMut = useMutation({
    mutationFn: () => rescheduleFn({ data: { visitId: v.id, newDate } }),
    onSuccess: (r) => {
      warnLessonClashes(r);
      afterAction("Visit rescheduled", r.clash);
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const cancelMut = useMutation({
    mutationFn: () =>
      cancelFn({
        data: {
          visitId: v.id,
          reason: cancelReason.trim(),
          code: cancelCode as any,
          clientCancelledAt: v.client_package_id ? clientCalledAtIso(calledAt) : null,
        },
      }),
    onSuccess: () => afterAction("Visit canceled"),
    onError: (e) => toast.error((e as Error).message),
  });
  const reassignMut = useMutation({
    mutationFn: () => reassignFn({ data: { visitId: v.id, staffId: newStaffId || null } }),
    onSuccess: (r) => {
      warnLessonClashes(r);
      afterAction(newStaffId ? "Visit reassigned" : "Visit unassigned", r.clash);
    },
    onError: (e) => toast.error((e as Error).message),
  });

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
  const durText = formatVisitDuration(v.started_at, v.completed_at);
  // Missed visits can be retroactively completed (it was serviced) or
  // rescheduled (make-up) — the only recovery from the terminal state.
  const canComplete =
    v.status === "scheduled" || v.status === "in_progress" || v.status === "missed";
  const canReschedule = scheduled || missed;

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
              <StatusChip label={i18n.t(`status.${v.status}`, { defaultValue: "Visit" })} status={v.status} />
            </dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-muted-foreground">Scheduled window</dt>
            <dd>{fmtWindow(v, tz)}</dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-muted-foreground">Actual start</dt>
            <dd>{v.started_at ? formatTime(v.started_at, tz) : "Arrival not recorded"}</dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-muted-foreground">Actual completion</dt>
            <dd>{v.completed_at ? formatTime(v.completed_at, tz) : "Completion not recorded"}</dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-muted-foreground">Duration</dt>
            <dd>{durText}</dd>
          </div>
          {v.duration_min ? (
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">Appointment length</dt>
              <dd className="shrink-0">{v.duration_min} min</dd>
            </div>
          ) : null}
          {v.groom_summary && (
            <div>
              <dt className="text-muted-foreground">Groom</dt>
              <dd className="mt-0.5 min-w-0 [overflow-wrap:anywhere]">{v.groom_summary}</dd>
            </div>
          )}
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
              <dd>{skipReasonText(v)}</dd>
            </div>
          )}
        </dl>

        {confirmDialog}

        {canCorrect && (canComplete || canReschedule) && (
          <div className="space-y-3 rounded-md border bg-muted/20 p-3">
            {missed && (
              <p className="text-xs text-muted-foreground">
                This visit was marked missed. If it was serviced, mark it completed; otherwise
                reschedule a make-up.
              </p>
            )}
            <div className="flex flex-wrap items-center gap-1.5">
              {canComplete && (
                <Button
                  size="sm"
                  disabled={completeMut.isPending}
                  onClick={async () => {
                    if (
                      await confirm({
                        title: "Mark this visit completed?",
                        description:
                          "It's recorded as completed now; adjust the exact times afterward with Correct timestamps if needed. Completed visits are billable.",
                        confirmLabel: "Mark completed",
                      })
                    )
                      completeMut.mutate();
                  }}
                >
                  {completeMut.isPending ? "Completing…" : "Mark completed"}
                </Button>
              )}
              {canReschedule && (
                <Button
                  size="sm"
                  variant={action === "reschedule" ? "default" : "outline"}
                  onClick={() => setAction(action === "reschedule" ? null : "reschedule")}
                >
                  Reschedule…
                </Button>
              )}
              {scheduled && (
                <>
                  <Button
                    size="sm"
                    variant={action === "reassign" ? "default" : "outline"}
                    onClick={() => setAction(action === "reassign" ? null : "reassign")}
                  >
                    Reassign…
                  </Button>
                  <Button
                    size="sm"
                    variant={action === "cancel" ? "destructive" : "outline"}
                    className={action === "cancel" ? undefined : "text-destructive"}
                    onClick={() => {
                      setCalledAt(nowAsCalledAt());
                      setAction(action === "cancel" ? null : "cancel");
                    }}
                  >
                    Cancel visit…
                  </Button>
                </>
              )}
            </div>

            {action === "reschedule" && canReschedule && (
              <form
                className="space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (newDate) rescheduleMut.mutate();
                }}
              >
                <div>
                  <Label htmlFor="va-date" className="text-xs">
                    New date
                  </Label>
                  <Input
                    id="va-date"
                    type="date"
                    className="w-44"
                    value={newDate}
                    onChange={(e) => setNewDate(e.target.value)}
                    required
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Moving the visit clears its route assignment for the day; dispatch re-assigns it.
                </p>
                <Button type="submit" size="sm" disabled={rescheduleMut.isPending || !newDate}>
                  {rescheduleMut.isPending ? "Moving…" : "Move visit"}
                </Button>
              </form>
            )}

            {action === "reassign" && scheduled && (
              <form
                className="space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  reassignMut.mutate();
                }}
              >
                <div>
                  <Label htmlFor="va-staff" className="text-xs">
                    Technician
                  </Label>
                  <select
                    id="va-staff"
                    value={newStaffId}
                    onChange={(e) => setNewStaffId(e.target.value)}
                    className="block h-9 w-56 rounded-md border bg-background px-2 text-sm"
                  >
                    <option value="">Unassigned</option>
                    {staff.map((s: any) => (
                      <option key={s.id} value={s.id}>
                        {s.display_name}
                      </option>
                    ))}
                  </select>
                </div>
                <Button
                  type="submit"
                  size="sm"
                  disabled={reassignMut.isPending || newStaffId === (v.assigned_staff_id ?? "")}
                >
                  {reassignMut.isPending ? "Reassigning…" : "Reassign visit"}
                </Button>
              </form>
            )}

            {action === "cancel" && scheduled && (
              <form
                className="space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (cancelReason.trim()) cancelMut.mutate();
                }}
              >
                <div className="grid gap-2 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="va-code" className="text-xs">
                      Reason code
                    </Label>
                    <select
                      id="va-code"
                      value={cancelCode}
                      onChange={(e) => setCancelCode(e.target.value)}
                      className="block h-9 w-full rounded-md border bg-background px-2 text-sm"
                    >
                      {SKIP_CODES.map((c) => (
                        <option key={c.value} value={c.value}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <Label htmlFor="va-reason" className="text-xs">
                      Reason
                    </Label>
                    <Input
                      id="va-reason"
                      value={cancelReason}
                      onChange={(e) => setCancelReason(e.target.value)}
                      placeholder="Required"
                      required
                    />
                  </div>
                </div>
                {v.client_package_id && (
                  <ClientCalledAtField id="va-called-at" value={calledAt} onChange={setCalledAt} />
                )}
                <p className="text-xs text-muted-foreground">
                  The visit is recorded as skipped with this reason; the org's skip-billing rules
                  decide whether any charge applies.
                </p>
                <Button
                  type="submit"
                  size="sm"
                  variant="destructive"
                  disabled={cancelMut.isPending || !cancelReason.trim()}
                >
                  {cancelMut.isPending ? "Canceling…" : "Cancel visit"}
                </Button>
              </form>
            )}
          </div>
        )}

        {v.status === "completed" && (
          <div className="rounded-md border bg-muted/20 p-3">
            <CompletedVisitActions visit={v} />
          </div>
        )}

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
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setCorrecting(false)}
                  >
                    <X className="mr-1 h-3.5 w-3.5 shrink-0" /> Cancel
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
