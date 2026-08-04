import { createFileRoute, Link } from "@tanstack/react-router";
import { humanizeRole } from "@/lib/humanize";
import { AiSection, DispatchPanel } from "@/components/ai/AiPanels";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import {
  listVisitsForDay,
  assignRoute,
  optimizeRoute,
  optimizeWeek,
  reoptimizeAll,
  listStaff,
  reassignVisit,
  reorderRoute,
  completeVisitFromOffice,
} from "@/lib/visits.functions";
import { backfillPropertyGeocodes } from "@/lib/properties.functions";
import { RouteMap, buildTechGroups, techColorMap } from "@/components/RouteMap";
import { StatusChip } from "@/components/client-detail/primitives";
import { MobileDayList } from "@/components/schedule/MobileDayList";
import { ScheduleCalendar, calendarWindow } from "@/components/schedule/ScheduleCalendar";
import { VisitDetailDrawer } from "@/components/VisitDetailDrawer";
import { OneOffVisitDialog } from "@/components/OneOffVisitDialog";
import { usePermissions } from "@/hooks/useMyRole";
import {
  Navigation,
  CheckCircle2,
  MapPin,
  Settings2,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay,
  closestCenter,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  rectSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useDroppable } from "@dnd-kit/core";
import { GripVertical } from "lucide-react";

export const Route = createFileRoute("/_authenticated/routes")({
  component: RoutesPage,
});

const UNASSIGNED = "__unassigned__";
type Visit = any;

/** A labelled filter dropdown for the calendar toolbar.
 *
 *  A plain `<select>` rather than the shadcn `Select`: this is a three-item
 *  toolbar control, and the popover variant brings a portal, focus trapping and
 *  a listbox for a choice a native control already makes accessible for free. */
function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="inline-flex items-center gap-1.5 rounded-md border bg-card px-2 py-1">
      <span className="text-muted-foreground">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-transparent text-xs font-medium focus-visible:outline-none"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function toLocalISO(d: Date) {
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60_000).toISOString().slice(0, 10);
}
function todayISO() {
  return toLocalISO(new Date());
}

function RoutesPage() {
  const [day, setDay] = useState(todayISO());
  const [assignStaffId, setAssignStaffId] = useState<string>("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [localColumns, setLocalColumns] = useState<Record<string, Visit[]> | null>(null);

  const [weekDays, setWeekDays] = useState(7);
  const [viewMode, setViewMode] = useState<"map" | "board">(() =>
    typeof localStorage !== "undefined" && localStorage.getItem("routes.viewMode") === "board"
      ? "board"
      : "map",
  );
  const [range, setRange] = useState<"today" | "week" | "month">(() => {
    if (typeof localStorage === "undefined") return "today";
    const v = localStorage.getItem("routes.range");
    return v === "week" || v === "month" ? v : "today";
  });
  const setViewModePersist = (m: "map" | "board") => {
    setViewMode(m);
    try {
      localStorage.setItem("routes.viewMode", m);
    } catch {
      /* private mode */
    }
  };
  const setRangePersist = (r: "today" | "week" | "month") => {
    setRange(r);
    try {
      localStorage.setItem("routes.range", r);
    } catch {
      /* private mode */
    }
  };
  // Gear option: tech lanes as vertical columns or full-width horizontal rows.
  const [boardLayout, setBoardLayout] = useState<"columns" | "rows">(() =>
    typeof localStorage !== "undefined" && localStorage.getItem("routes.boardLayout") === "rows"
      ? "rows"
      : "columns",
  );
  const setBoardLayoutPersist = (l: "columns" | "rows") => {
    setBoardLayout(l);
    try {
      localStorage.setItem("routes.boardLayout", l);
    } catch {
      /* private mode */
    }
  };
  const [hideWeekends, setHideWeekends] = useState<boolean>(
    () =>
      typeof localStorage !== "undefined" && localStorage.getItem("routes.hideWeekends") === "1",
  );
  const setHideWeekendsPersist = (v: boolean) => {
    setHideWeekends(v);
    try {
      localStorage.setItem("routes.hideWeekends", v ? "1" : "0");
    } catch {
      /* private mode */
    }
  };
  /** Move the selected day by one unit of whatever range is showing.
   *
   *  Months step by CALENDAR month, not by 30 days — otherwise stepping
   *  forward from 31 January lands in March, and stepping back and forward
   *  again does not return you where you started. `setDate(1)` first, so the
   *  day-of-month can never overflow a short month on the way through. */
  const shiftDay = (delta: number) => {
    const d = new Date(`${day}T00:00:00`);
    if (range === "month") {
      d.setDate(1);
      d.setMonth(d.getMonth() + delta);
    } else {
      d.setDate(d.getDate() + delta * (range === "week" ? 7 : 1));
    }
    setLocalColumns(null);
    setDay(toLocalISO(d));
  };
  const rangeNoun = range === "month" ? "month" : range === "week" ? "week" : "day";

  const [toolsOpen, setToolsOpen] = useState(false);
  const [detailVisitId, setDetailVisitId] = useState<string | null>(null);
  const [oneOffOpen, setOneOffOpen] = useState(false);
  // Booking a one-off sets a price, so it takes manage_pricing — the same gate
  // createSubscription uses. A dispatcher does not hold it, and the server
  // refuses regardless; hiding the button keeps it from being a form that
  // throws only after it has been filled in.
  const { can: canDo } = usePermissions();
  const canBookOneOff = canDo("manage_pricing");

  const listV = useServerFn(listVisitsForDay);
  const listS = useServerFn(listStaff);
  const assign = useServerFn(assignRoute);
  const optimize = useServerFn(optimizeRoute);
  const optWeek = useServerFn(optimizeWeek);
  const reoptAll = useServerFn(reoptimizeAll);
  const reassign = useServerFn(reassignVisit);

  const reorder = useServerFn(reorderRoute);
  // Office action, not the my-day tech flow: completeVisitFromOffice checks
  // the caller's office role + org and logs the completion on the timeline
  // (the my-day completeVisit is scoped to the tech's OWN assigned visit).
  const doComplete = useServerFn(completeVisitFromOffice);
  const qc = useQueryClient();

  const completeMut = useMutation({
    mutationFn: (visitId: string) => doComplete({ data: { visitId } }),
    onSuccess: () => {
      toast.success("Visit marked complete");
      setLocalColumns(null);
      qc.invalidateQueries({ queryKey: ["visits", day] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // The window the page FETCHES has to be the window the calendar DRAWS.
  //
  // It used to be "selected day + 6 / + 29" while the grid drew from the Monday
  // of that week or the 1st of that month. Pick a Thursday and the first three
  // cells sat outside the query: with counts they read as three quiet days,
  // and with per-visit chips they would read as three days nobody is working.
  // `calendarWindow` is the one definition, and the calendar renders from it.
  const { from: rangeStart, to: rangeEnd } = useMemo(() => {
    if (range === "today") return { from: day, to: day };
    return calendarWindow(day, range === "month" ? "month" : "week");
  }, [range, day]);
  const { data: visitsData } = useQuery({
    queryKey: ["visits", rangeStart, rangeEnd],
    queryFn: () =>
      listV({
        data: { day: rangeStart, ...(rangeEnd !== rangeStart ? { throughDay: rangeEnd } : {}) },
      }),
  });
  const { data: staffData } = useQuery({ queryKey: ["staff"], queryFn: () => listS() });

  const allStaff = staffData?.staff ?? [];
  const assignedIds = new Set(
    (visitsData?.visits ?? []).map((v: any) => v.assigned_staff_id).filter(Boolean),
  );

  // Who may be GIVEN work: field techs, and nothing else.
  //
  // This used to be `s.is_field_tech || assignedIds.has(s.id)`, and that `||`
  // was a one-way door. Holding a single visit — from an import, the demo
  // seeder, or a tech demoted after they were already assigned — earned an
  // office manager a full board column, a drag-and-drop target, and an entry in
  // the "auto-assign / optimize day for tech" select below, from which they
  // could be given a whole day's route. Nothing ever took it away again.
  //
  // Available techs get regular columns; off-duty ones stay visible as muted
  // "Off routes" lanes so a dispatcher sees who is not in play today
  // (finding #12). `routing_available` is deliberately NOT part of eligibility:
  // it means "not in a truck today", and you must still be able to schedule
  // their work for tomorrow.
  const staff = allStaff
    .filter((s: any) => s.is_field_tech)
    .sort((a: any, b: any) => {
      const av = a.routing_available ? 0 : 1;
      const bv = b.routing_available ? 0 : 1;
      if (av !== bv) return av - bv;
      return (a.display_name ?? "").localeCompare(b.display_name ?? "");
    });

  // Who already HOLDS work but is not a field tech. Dropping them from the
  // board entirely would hide real visits — the dispatcher would see a day
  // whose stops do not add up and have nothing to click. So they keep a lane,
  // read-only, labelled with what to do about it. The server now refuses to
  // add to these (assert_runs_routes), so the count can only go down.
  const stranded = allStaff
    .filter((s: any) => !s.is_field_tech && assignedIds.has(s.id))
    .sort((a: any, b: any) => (a.display_name ?? "").localeCompare(b.display_name ?? ""));
  const visits: Visit[] = visitsData?.visits ?? [];

  // One colour per tech, shared with the map. Built from the map's own grouping
  // so a calendar chip and that visit's pin can never end up different colours.
  // Computed from the UNFILTERED list on purpose: filtering to one tech must
  // not repaint everyone else, or a colour would mean different people
  // depending on what you had selected.
  const techColors = useMemo(
    () => techColorMap(visits as any, [...staff, ...stranded] as any),
    [visits, staff, stranded],
  );

  // ── Filters ───────────────────────────────────────────────────────────
  //
  // Week and month only, and deliberately so. The day board is a drag-and-drop
  // surface whose drop handler calls `persistColumn(lane)` — it writes the
  // sequence for every visit in that lane from what it can see. Hand it a
  // filtered lane and the hidden stops are silently dropped out of the
  // ordering. Filtering a read-only calendar is free; filtering that board is a
  // data-corruption bug wearing a convenience feature's clothes.
  const [fTeam, setFTeam] = useState("all");
  const [fStatus, setFStatus] = useState("all");
  const [fType, setFType] = useState("all");
  const filtersActive = fTeam !== "all" || fStatus !== "all" || fType !== "all";

  const shownVisits = useMemo(
    () =>
      (visits as any[]).filter((v) => {
        if (fTeam === "unassigned" && v.assigned_staff_id) return false;
        if (fTeam !== "all" && fTeam !== "unassigned" && v.assigned_staff_id !== fTeam) return false;
        if (fStatus !== "all" && v.status !== fStatus) return false;
        // A visit generated from a subscription is recurring; one booked ad hoc
        // has no subscription behind it.
        if (fType === "recurring" && !v.subscription_id) return false;
        if (fType === "oneoff" && v.subscription_id) return false;
        return true;
      }),
    [visits, fTeam, fStatus, fType],
  );

  const columns = useMemo(() => {
    if (localColumns) return localColumns;
    const cols: Record<string, Visit[]> = { [UNASSIGNED]: [] };
    for (const s of staff) cols[s.id] = [];
    for (const v of visits) {
      const key = v.assigned_staff_id ?? UNASSIGNED;
      if (!cols[key]) cols[key] = [];
      cols[key].push(v);
    }
    for (const k of Object.keys(cols)) {
      cols[k].sort((a, b) => (a.sequence ?? 9999) - (b.sequence ?? 9999));
    }
    return cols;
  }, [visits, staff, localColumns]);

  // Surface implausible-drive / inconsistent-ETA warnings to the dispatcher
  // instead of silently accepting an impossible route (finding #10).
  const warnRoute = (warnings?: Array<{ message: string }>) => {
    for (const w of (warnings ?? []).slice(0, 4)) {
      toast.warning(w.message, { duration: 8000 });
    }
  };
  const assignMut = useMutation({
    mutationFn: () => assign({ data: { staffId: assignStaffId, day, reassign: false } }),
    onSuccess: (r) => {
      toast.success(`Auto-assigned ${r.assigned} visits`);
      warnRoute((r as any).warnings);
      setLocalColumns(null);
      qc.invalidateQueries({ queryKey: ["visits", day] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const optimizeMut = useMutation({
    mutationFn: () => optimize({ data: { staffId: assignStaffId, day, reassign: true } }),
    onSuccess: (r) => {
      toast.success(`Optimized ${r.assigned} stops (nearest-neighbor)`);
      warnRoute((r as any).warnings);
      setLocalColumns(null);
      qc.invalidateQueries({ queryKey: ["visits", day] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const weekMut = useMutation({
    mutationFn: () => optWeek({ data: { startDate: day, days: weekDays } }),
    onSuccess: (r) => {
      const total = (r.results ?? []).reduce((s: number, x: any) => s + (x.assigned ?? 0), 0);
      toast.success(`Optimized ${total} stops across ${weekDays} day(s)`);
      setLocalColumns(null);
      qc.invalidateQueries({ queryKey: ["visits"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const reoptMut = useMutation({
    mutationFn: () => reoptAll({ data: { day } }),
    onSuccess: (r) => {
      toast.success(`Re-optimized ${r.total} stops across ${r.techs} tech(s)`);
      setLocalColumns(null);
      qc.invalidateQueries({ queryKey: ["visits", day] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const geocode = useServerFn(backfillPropertyGeocodes);
  const geocodeMut = useMutation({
    mutationFn: () => geocode({ data: { limit: 100 } }),
    onSuccess: (r) => {
      toast.success(
        `Geocoded ${r.updated} addresses${r.remaining ? ` · ${r.remaining} remaining` : ""}`,
      );
      qc.invalidateQueries({ queryKey: ["visits"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  function findContainer(id: string): string | null {
    if (id in columns) return id;
    for (const [colId, items] of Object.entries(columns)) {
      if (items.some((v) => v.id === id)) return colId;
    }
    return null;
  }

  async function persistColumn(staffKey: string, items: Visit[]) {
    if (staffKey === UNASSIGNED) return;
    try {
      await reorder({
        data: { staffId: staffKey, day, orderedIds: items.map((v) => v.id) },
      });
    } catch (e) {
      toast.error((e as Error).message);
      setLocalColumns(null);
      qc.invalidateQueries({ queryKey: ["visits", day] });
    }
  }

  function onDragStart(e: DragStartEvent) {
    setActiveId(String(e.active.id));
  }

  async function onDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const { active, over } = e;
    if (!over) return;
    const activeIdStr = String(active.id);
    const overIdStr = String(over.id);
    const fromCol = findContainer(activeIdStr);
    const toCol = findContainer(overIdStr) ?? overIdStr;
    if (!fromCol || !toCol) return;

    const next: Record<string, Visit[]> = {};
    for (const [k, v] of Object.entries(columns)) next[k] = [...v];

    const fromItems = next[fromCol];
    const activeIdx = fromItems.findIndex((v) => v.id === activeIdStr);
    if (activeIdx === -1) return;
    const [moved] = fromItems.splice(activeIdx, 1);

    if (fromCol === toCol) {
      const overIdx = fromItems.findIndex((v) => v.id === overIdStr);
      const insertAt = overIdx === -1 ? fromItems.length : overIdx;
      fromItems.splice(insertAt, 0, moved);
      next[toCol] = fromItems;
      setLocalColumns(next);
      await persistColumn(toCol, next[toCol]);
      qc.invalidateQueries({ queryKey: ["visits", day] });
      return;
    }

    const toItems = next[toCol];
    const overIdx = toItems.findIndex((v) => v.id === overIdStr);
    const insertAt = overIdx === -1 ? toItems.length : overIdx;
    moved.assigned_staff_id = toCol === UNASSIGNED ? null : toCol;
    toItems.splice(insertAt, 0, moved);
    next[toCol] = toItems;
    setLocalColumns(next);

    try {
      await reassign({
        data: { visitId: moved.id, staffId: toCol === UNASSIGNED ? null : toCol },
      });
      if (toCol !== UNASSIGNED) await persistColumn(toCol, next[toCol]);
      if (fromCol !== UNASSIGNED) await persistColumn(fromCol, next[fromCol]);
    } catch (err) {
      toast.error((err as Error).message);
    }
    qc.invalidateQueries({ queryKey: ["visits", day] });
  }

  const activeVisit = activeId ? visits.find((v) => v.id === activeId) : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Today</h1>
          <p className="text-sm text-muted-foreground">
            Dispatch, route, map, and mark visits complete, all in one view.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* The emergency button. A one-off used to mean going to the client,
              opening Services, adding a "service", choosing One time, and then
              waiting for the nightly run to put it on the board — which is not
              a thing anyone does while someone is on the phone. */}
          {canBookOneOff && (
            <Button variant="outline" onClick={() => setOneOffOpen(true)}>
              <CalendarClock className="mr-1.5 h-4 w-4" />
              One-off visit
            </Button>
          )}
          {/* Step by whatever you are LOOKING at.
              A date input alone made "show me next week" a calendar-popover
              date-arithmetic exercise: you had to work out which Monday you
              wanted. The arrows move by the active range — a day, a week, or a
              calendar month — so the control matches the view it drives. */}
          <div className="inline-flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              className="h-9 w-9 shrink-0"
              onClick={() => shiftDay(-1)}
              title={`Previous ${rangeNoun}`}
              aria-label={`Previous ${rangeNoun}`}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Input
              type="date"
              value={day}
              onChange={(e) => {
                setLocalColumns(null);
                setDay(e.target.value);
              }}
              className="w-[150px]"
            />
            <Button
              variant="outline"
              size="icon"
              className="h-9 w-9 shrink-0"
              onClick={() => shiftDay(1)}
              title={`Next ${rangeNoun}`}
              aria-label={`Next ${rangeNoun}`}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-9"
              onClick={() => {
                setLocalColumns(null);
                setDay(todayISO());
              }}
              disabled={day === todayISO()}
            >
              Today
            </Button>
          </div>
          {/* Two clean axes instead of five mixed buttons: WHAT you look at
              (Map = map + load + board, Board = board only) and WHEN
              (Today / Week / Month). */}
          <div className="inline-flex rounded-md border bg-card p-0.5 text-xs">
            {(["map", "board"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setViewModePersist(m)}
                className={`px-3 py-1.5 max-md:py-2.5 rounded ${viewMode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                {m === "map" ? "Map" : "Board"}
              </button>
            ))}
          </div>
          <div className="inline-flex rounded-md border bg-card p-0.5 text-xs">
            {(["today", "week", "month"] as const).map((r) => (
              <button
                key={r}
                onClick={() => setRangePersist(r)}
                className={`px-3 py-1.5 max-md:py-2.5 rounded ${range === r ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                {r === "today" ? "Today" : r === "week" ? "Week" : "Month"}
              </button>
            ))}
          </div>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" title="Display options">
                <Settings2 className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 space-y-4">
              <div className="text-xs font-semibold uppercase text-muted-foreground">Display</div>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium">Hide weekends</div>
                  <div className="text-[11px] text-muted-foreground">
                    Skip Sat/Sun in Week and Month views.
                  </div>
                </div>
                <Switch checked={hideWeekends} onCheckedChange={setHideWeekendsPersist} />
              </div>
              <div className="space-y-1.5">
                <div className="text-sm font-medium">Board layout</div>
                <div className="text-[11px] text-muted-foreground">
                  How tech lanes are arranged on the board.
                </div>
                <div className="inline-flex rounded-md border p-0.5 text-xs">
                  <button
                    className={`px-3 py-1 rounded ${boardLayout === "columns" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
                    onClick={() => setBoardLayoutPersist("columns")}
                  >
                    Vertical columns
                  </button>
                  <button
                    className={`px-3 py-1 rounded ${boardLayout === "rows" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
                    onClick={() => setBoardLayoutPersist("rows")}
                  >
                    Horizontal rows
                  </button>
                </div>
              </div>
            </PopoverContent>
          </Popover>
          <Button variant="outline" size="sm" onClick={() => setToolsOpen((v) => !v)}>
            {toolsOpen ? "Hide dispatch tools" : "Dispatch tools"}
          </Button>
        </div>
      </div>

      {/* Dispatch tools: things you DO to the day in front of you.
          The configuration that used to share this drawer — workday hours,
          work days, speed and traffic assumptions — moved to Settings →
          Scheduling. One button held both, so "Planning tools" meant a date
          picker, three optimizers and the definition of a working week, and
          you had to open it to find out which you were about to get.
          The day picker that sat here too is gone: the header already has one,
          and two date inputs on one screen setting the same day is not a
          choice anybody wants to make. */}
      {toolsOpen && (
        <div className="space-y-4 rounded-lg border bg-card p-5">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="tech">Assign or optimize one tech&apos;s day</Label>
              <div className="flex gap-2">
                <select
                  id="tech"
                  value={assignStaffId}
                  onChange={(e) => setAssignStaffId(e.target.value)}
                  className="h-10 flex-1 rounded-md border bg-background px-3 text-sm"
                >
                  <option value="">Select…</option>
                  {staff.map((s: any) => (
                    <option key={s.id} value={s.id}>
                      {s.display_name}
                    </option>
                  ))}
                </select>
                <Button
                  onClick={() => assignMut.mutate()}
                  disabled={!assignStaffId || assignMut.isPending}
                  variant="secondary"
                >
                  Assign
                </Button>
                <Button
                  onClick={() => optimizeMut.mutate()}
                  disabled={!assignStaffId || optimizeMut.isPending}
                >
                  {optimizeMut.isPending ? "…" : "Optimize"}
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Assign gives them {day}&apos;s unassigned stops. Optimize re-sequences what they
                already have, using time windows and traffic from their start address.
              </p>
            </div>

            <div className="space-y-2">
              <Label>Optimize across several days</Label>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  max={31}
                  value={weekDays}
                  onChange={(e) =>
                    setWeekDays(Math.max(1, Math.min(31, Number(e.target.value) || 1)))
                  }
                  className="w-20"
                />
                <span className="text-sm text-muted-foreground">days from {day}</span>
                <Button onClick={() => weekMut.mutate()} disabled={weekMut.isPending}>
                  {weekMut.isPending ? "…" : "Optimize"}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => reoptMut.mutate()}
                  disabled={reoptMut.isPending}
                  title="Recompute sequence for every tech using their remaining stops"
                >
                  {reoptMut.isPending ? "…" : "Re-optimize today"}
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Spreads unassigned visits round-robin by zone, then optimizes each tech&apos;s day.
                Balance moves stops off anyone whose day runs past the workday end.
              </p>
            </div>
          </div>


          <div className="border-t pt-4">
            <AiSection
              title="AI dispatch"
              description="Suggest value-aware reassignments for a day."
            >
              <DispatchPanel />
            </AiSection>
          </div>

          {/* Pointer, not a second control — the same shape the timezone move
              left behind, so nobody goes looking for these on the old screen. */}
          <p className="border-t pt-4 text-[11px] text-muted-foreground">
            Workday hours, work days and travel assumptions live in{" "}
            <Link to="/settings/scheduling" className="underline underline-offset-2">
              Settings → Scheduling
            </Link>
            .
          </p>
        </div>
      )}

      {range !== "today" && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <FilterSelect
            label="Type"
            value={fType}
            onChange={setFType}
            options={[
              { value: "all", label: "All work" },
              { value: "recurring", label: "Recurring" },
              { value: "oneoff", label: "One-off" },
            ]}
          />
          <FilterSelect
            label="Team"
            value={fTeam}
            onChange={setFTeam}
            options={[
              { value: "all", label: "Everyone" },
              ...staff.map((s: any) => ({ value: s.id, label: s.display_name })),
              { value: "unassigned", label: "Unassigned" },
            ]}
          />
          <FilterSelect
            label="Status"
            value={fStatus}
            onChange={setFStatus}
            options={[
              { value: "all", label: "Any status" },
              { value: "scheduled", label: "Scheduled" },
              { value: "in_progress", label: "In progress" },
              { value: "completed", label: "Completed" },
              { value: "skipped", label: "Skipped" },
            ]}
          />
          {filtersActive && (
            <>
              <span className="text-muted-foreground">
                {shownVisits.length} of {visits.length} visits
              </span>
              <button
                onClick={() => {
                  setFType("all");
                  setFTeam("all");
                  setFStatus("all");
                }}
                className="rounded border px-2 py-1 hover:bg-muted"
              >
                Clear
              </button>
            </>
          )}
        </div>
      )}

      {range !== "today" && (
        <div
          className={
            viewMode === "map"
              ? "grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start"
              : ""
          }
        >
          <ScheduleCalendar
            day={day}
            range={range === "month" ? "month" : "week"}
            visits={shownVisits as any}
            techColors={techColors}
            hideWeekends={hideWeekends}
            onPickDay={(d) => {
              setLocalColumns(null);
              setDay(d);
              setRangePersist("today");
            }}
            onOpenVisit={setDetailVisitId}
          />
          {viewMode === "map" && (
            // Sticky so the map stays put while a long month scrolls past it.
            <div className="lg:sticky lg:top-4">
              <MapPanel
                // The same filtered list the calendar is drawing. Two panes
                // showing different subsets of the same window would be worse
                // than one pane.
                visits={shownVisits}
                staff={staff}
                onOpenVisit={setDetailVisitId}
                onGeocode={() => geocodeMut.mutate()}
                geocoding={geocodeMut.isPending}
                // Week/month is a coverage view: per-day sequences repeat, so
                // ordered polylines/numbers only draw for a single day.
                drawRoutes={false}
              />
            </div>
          )}
        </div>
      )}

      {/* Today: the board is a full-width drag-and-drop surface with a lane per
          tech, so the map stays above it rather than competing for width. */}
      {range === "today" && viewMode === "map" && (
        <>
          <MapPanel
            visits={visits}
            staff={staff}
            onOpenVisit={setDetailVisitId}
            onGeocode={() => geocodeMut.mutate()}
            geocoding={geocodeMut.isPending}
            drawRoutes
          />
          {/* Tech load is a FIELD-worker report (C3/I4): only capability-flagged
              field workers are route runners. Non-field roles stay on the board
              below (so a mis-assigned visit can be dragged off them) but never
              appear in the load analytics. */}
          <HeatmapPanel visits={visits} staff={staff.filter((s: any) => s.is_field_tech)} />
        </>
      )}

      {/* Mobile Phase 2: below `md` the dnd board is replaced by a tap-through
          day list (per-tech rows → VisitDetailDrawer). This comment used to
          claim reassignment and reschedule happen via "the drawer's existing
          controls"; the drawer has neither, and saying so here is how the same
          wrong claim got repeated into MobileDayList and into its user-facing
          footer. Mobile is observe + close-out; moving work between techs or
          between days is desktop-only (Q-12).
          Rendered at EVERY range (QA: week/month left phones with no visit
          list at all) — always the selected day's visits. */}
      <div className="md:hidden">
        <MobileDayList
          visits={range === "today" ? visits : visits.filter((v: any) => v.scheduled_on === day)}
          staff={staff}
          onOpen={setDetailVisitId}
        />
      </div>

      {range === "today" && (
        <div className="max-md:hidden">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
          >
            <div
              className={
                boardLayout === "rows"
                  ? "grid gap-4 grid-cols-1"
                  : "grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
              }
            >
              <Column
                id={UNASSIGNED}
                title="Unassigned"
                items={columns[UNASSIGNED] ?? []}
                tone="muted"
                layout={boardLayout}
                onComplete={(id) => completeMut.mutate(id)}
                completingId={completeMut.isPending ? (completeMut.variables as string) : null}
                onOpen={setDetailVisitId}
              />
              {staff.map((s: any) => {
                const offRoutes = s.is_field_tech && !s.routing_available;
                return (
                  <Column
                    key={s.id}
                    id={s.id}
                    title={s.display_name}
                    subtitle={s.role ? humanizeRole(s.role) : undefined}
                    offRoutes={offRoutes}
                    items={columns[s.id] ?? []}
                    layout={boardLayout}
                    onComplete={(id) => completeMut.mutate(id)}
                    completingId={completeMut.isPending ? (completeMut.variables as string) : null}
                    onOpen={setDetailVisitId}
                  />
                );
              })}
              {/* Non-techs who still hold work. Last, read-only, and only ever
                  rendered when they actually have visits — so a healthy org
                  never sees this at all. */}
              {stranded.map((s: any) => (
                <Column
                  key={s.id}
                  id={s.id}
                  title={s.display_name}
                  notRoutable
                  items={columns[s.id] ?? []}
                  layout={boardLayout}
                  onComplete={(id) => completeMut.mutate(id)}
                  completingId={completeMut.isPending ? (completeMut.variables as string) : null}
                  onOpen={setDetailVisitId}
                />
              ))}
            </div>
            <DragOverlay>
              {activeVisit ? <VisitCardView visit={activeVisit} dragging /> : null}
            </DragOverlay>
          </DndContext>
        </div>
      )}
      <OneOffVisitDialog
        open={oneOffOpen}
        onOpenChange={setOneOffOpen}
        onCreated={() => {
          setLocalColumns(null);
          qc.invalidateQueries({ queryKey: ["visits"] });
        }}
      />

      <VisitDetailDrawer
        visitId={detailVisitId}
        onOpenChange={(o) => !o && setDetailVisitId(null)}
      />
    </div>
  );
}


/** Toggleable weekday chips for the org's operating days (0=Sun..6=Sat). */
function MapPanel({
  visits,
  staff,
  onOpenVisit,
  onGeocode,
  geocoding,
  drawRoutes = true,
}: {
  visits: any[];
  staff: any[];
  onOpenVisit?: (id: string) => void;
  onGeocode?: () => void;
  geocoding?: boolean;
  drawRoutes?: boolean;
}) {
  const groups = useMemo(() => buildTechGroups(visits as any, staff as any), [visits, staff]);
  const mappable = visits.filter(
    (v: any) => v.properties?.latitude != null && v.properties?.longitude != null,
  ).length;
  const missing = visits.length - mappable;
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Map</h2>
          <p className="text-[11px] text-muted-foreground">
            {mappable} of {visits.length} visits on map. Click a pin or a card to view details.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {onGeocode && missing > 0 && (
            <Button size="sm" variant="outline" onClick={onGeocode} disabled={geocoding}>
              <MapPin className="mr-1 h-3.5 w-3.5" />
              {geocoding ? "Geocoding…" : `Geocode ${missing} address${missing === 1 ? "" : "es"}`}
            </Button>
          )}
          {groups.map((g) => (
            <div key={g.staffId ?? "u"} className="flex items-center gap-1 text-[11px]">
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ background: g.color }}
              />
              <span>{g.name}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="relative">
        <RouteMap groups={groups} height={420} onVisitClick={onOpenVisit} drawRoutes={drawRoutes} />
        {mappable === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-md bg-background/70 text-xs text-muted-foreground">
            <span>No coordinates yet. Geocode your properties to plot them.</span>
            {onGeocode && (
              <Button size="sm" variant="outline" onClick={onGeocode} disabled={geocoding}>
                <MapPin className="mr-1 h-3.5 w-3.5" />
                {geocoding ? "Geocoding…" : "Geocode addresses"}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Finding #28 + punch list #13: a multi-day overview so office staff can see
// upcoming volume, overloaded days, and gaps across a week, rolling 4 weeks,
// or a true calendar month — with weekends optionally hidden.

function Column({
  id,
  title,
  subtitle,
  items,
  tone,
  offRoutes,
  notRoutable,
  onComplete,
  completingId,
  onOpen,
  layout = "columns",
}: {
  id: string;
  title: string;
  subtitle?: string;
  items: any[];
  tone?: "muted";
  offRoutes?: boolean;
  /** Holds visits but is not a field tech. Read-only: the server refuses new
   *  assignments here, so accepting a drop would only produce an error toast. */
  notRoutable?: boolean;
  onComplete?: (visitId: string) => void;
  completingId?: string | null;
  onOpen?: (visitId: string) => void;
  layout?: "columns" | "rows";
}) {
  const { setNodeRef, isOver } = useDroppable({ id, disabled: notRoutable });
  const totalCents = items.reduce((sum, v) => sum + (v.subscriptions?.price_cents ?? 0), 0);
  return (
    <div
      ref={setNodeRef}
      className={`rounded-lg border ${tone === "muted" ? "bg-muted/30" : offRoutes ? "bg-muted/40 opacity-70" : "bg-card"} ${
        isOver ? "ring-2 ring-primary" : ""
      }`}
    >
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            <span className="truncate">{title}</span>
            {offRoutes && (
              <Badge variant="outline" className="border-amber-400 text-amber-700 text-[10px]">
                Off routes
              </Badge>
            )}
            {notRoutable && (
              <Badge variant="outline" className="border-rose-400 text-rose-700 text-[10px]">
                Doesn&apos;t run routes
              </Badge>
            )}
          </div>
          {notRoutable ? (
            // Say what to do, not just what is wrong. Both remedies are real and
            // the dispatcher can reach either from here.
            <div className="text-xs text-rose-700">
              Still holding work — drag it to a tech, or turn on “Runs routes” for
              them in Settings → Team.
            </div>
          ) : (
            subtitle && <div className="text-xs text-muted-foreground capitalize">{subtitle}</div>
          )}
        </div>
        <div className="text-right">
          <Badge variant="secondary">{items.length}</Badge>
          {totalCents > 0 && (
            <div className="mt-0.5 text-[10px] text-muted-foreground">
              ${(totalCents / 100).toFixed(0)}
            </div>
          )}
        </div>
      </div>
      <SortableContext
        items={items.map((v) => v.id)}
        strategy={layout === "rows" ? rectSortingStrategy : verticalListSortingStrategy}
      >
        <div
          className={
            layout === "rows"
              ? "flex min-h-[80px] flex-wrap gap-2 p-2 [&>*]:w-72"
              : "min-h-[80px] space-y-2 p-2"
          }
        >
          {items.map((v, i) => (
            <SortableVisitCard
              key={v.id}
              visit={v}
              seq={i + 1}
              onComplete={onComplete}
              completing={completingId === v.id}
              onOpen={onOpen}
            />
          ))}
          {items.length === 0 && (
            <div className="py-6 text-center text-xs text-muted-foreground">Drop visits here</div>
          )}
        </div>
      </SortableContext>
    </div>
  );
}

function SortableVisitCard({
  visit,
  seq,
  onComplete,
  completing,
  onOpen,
}: {
  visit: Visit;
  seq: number;
  onComplete?: (id: string) => void;
  completing?: boolean;
  onOpen?: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: visit.id,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };
  return (
    <div ref={setNodeRef} style={style} {...attributes}>
      <VisitCardView
        visit={visit}
        seq={seq}
        dragHandle={listeners}
        onComplete={onComplete}
        completing={completing}
        onOpen={onOpen}
      />
    </div>
  );
}

function directionsUrl(p: any): string | null {
  if (!p) return null;
  if (p.latitude != null && p.longitude != null) {
    return `https://www.google.com/maps/dir/?api=1&destination=${p.latitude},${p.longitude}&travelmode=driving`;
  }
  const parts = [p.street, p.city, p.postal_code].filter(Boolean).join(", ");
  if (!parts) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(parts)}&travelmode=driving`;
}

function VisitCardView({
  visit,
  seq,
  dragging,
  dragHandle,
  onComplete,
  completing,
  onOpen,
}: {
  visit: Visit;
  seq?: number;
  dragging?: boolean;
  dragHandle?: any;
  onComplete?: (id: string) => void;
  completing?: boolean;
  onOpen?: (id: string) => void;
}) {
  const p = visit.properties;
  const dirUrl = directionsUrl(p);
  const canComplete =
    onComplete && (visit.status === "scheduled" || visit.status === "in_progress");
  return (
    <div
      className={`rounded-md border bg-background p-2 text-xs shadow-sm ${dragging ? "shadow-lg" : ""} ${onOpen ? "cursor-pointer hover:border-primary/40 hover:bg-muted/40" : ""}`}
      onClick={(e) => {
        if (!onOpen) return;
        const t = e.target as HTMLElement;
        if (t.closest("a,button")) return;
        onOpen(visit.id);
      }}
    >
      <div className="flex items-start gap-2">
        <button
          {...(dragHandle ?? {})}
          className="mt-0.5 cursor-grab touch-none text-muted-foreground hover:text-foreground"
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {seq != null && <span className="text-muted-foreground">#{seq}</span>}
            <span className="truncate font-medium">{visit.clients?.display_name ?? "-"}</span>
          </div>
          {p && (
            <div className="truncate text-muted-foreground">
              {p.street}, {p.city} {p.postal_code}
            </div>
          )}
          {(visit.eta_start || visit.travel_min != null) && (
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
              {visit.eta_start && (
                <span>
                  ETA{" "}
                  {new Date(visit.eta_start).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              )}
              {visit.travel_km != null && <span>· {Number(visit.travel_km).toFixed(1)} km</span>}
              {visit.travel_min != null && (
                <span>· {Math.round(Number(visit.travel_min))} min drive</span>
              )}
            </div>
          )}
          {(() => {
            // The window lives on the service now; fall back to the legacy
            // property window only when the service has none at all.
            const sub = (visit as any).subscriptions;
            const useSub = !!(sub?.earliest_time || sub?.latest_time);
            const s = (useSub ? sub.earliest_time : p?.earliest_service_time)?.slice(0, 5);
            const e = (useSub ? sub.latest_time : p?.latest_service_time)?.slice(0, 5);
            if (!s && !e) return null;
            const label = s && e ? `${s}-${e}` : s ? `${s} onward` : `until ${e}`;
            return <div className="mt-0.5 text-[10px] text-muted-foreground">Window {label}</div>;
          })()}
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {visit.zones?.name && (
              <Badge variant="outline" className="h-4 px-1 text-[10px]">
                {visit.zones.name}
              </Badge>
            )}
            <StatusChip status={visit.status} className="h-4 px-1 text-[10px]" />
            {visit.window_violated && (
              <Badge variant="destructive" className="h-4 px-1 text-[10px]">
                Late
              </Badge>
            )}
          </div>
          {(dirUrl || canComplete) && !dragging && (
            <div className="mt-2 flex flex-wrap gap-1">
              {dirUrl && (
                <a
                  href={dirUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 rounded border px-2 py-1 text-[11px] hover:bg-muted"
                >
                  <Navigation className="h-3 w-3" /> Directions
                </a>
              )}
              {canComplete && (
                <button
                  type="button"
                  onClick={() => onComplete!(visit.id)}
                  disabled={completing}
                  className="inline-flex items-center gap-1 rounded border border-emerald-600/40 bg-emerald-600/10 px-2 py-1 text-[11px] text-emerald-700 hover:bg-emerald-600/20 disabled:opacity-50 dark:text-emerald-400"
                >
                  <CheckCircle2 className="h-3 w-3" /> {completing ? "…" : "Complete"}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function HeatmapPanel({ visits, staff }: { visits: any[]; staff: any[] }) {
  const perTech = staff.map((s: any) => {
    const mine = visits.filter((v) => v.assigned_staff_id === s.id);
    const done = mine.filter((v) => v.status === "completed").length;
    const skipped = mine.filter((v) => v.status === "skipped").length;
    const inProgress = mine.filter((v) => v.status === "in_progress").length;
    const remaining = mine.filter((v) => v.status === "scheduled").length;
    const late = mine.filter((v) => v.window_violated).length;
    // IMP-10: subscription LIST PRICE for the day's assigned work, not money
    // collected — it knows nothing about payment, discounts, credits or
    // refunds. Named bookedValue rather than revenue so a dispatch board figure
    // can't be mistaken for a financial one; the same formula on /analytics is
    // labelled the same way.
    const bookedValue = mine.reduce((sum, v) => sum + (v.subscriptions?.price_cents ?? 0), 0);
    const withEta = mine
      .map((v) => v.eta_end)
      .filter(Boolean)
      .map((s) => new Date(s as string).getTime());
    const projectedEnd = withEta.length ? new Date(Math.max(...withEta)) : null;
    return {
      staff: s,
      total: mine.length,
      done,
      skipped,
      inProgress,
      remaining,
      late,
      bookedValue,
      projectedEnd,
    };
  });
  const unassigned = visits.filter((v) => !v.assigned_staff_id).length;
  const maxTotal = Math.max(1, ...perTech.map((t) => t.total));

  const zoneMap = new Map<string, number>();
  for (const v of visits) {
    const name = v.zones?.name ?? "No zone";
    zoneMap.set(name, (zoneMap.get(name) ?? 0) + 1);
  }
  const zones = Array.from(zoneMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  const maxZone = Math.max(1, ...zones.map(([, n]) => n));

  if (staff.length === 0 && visits.length === 0) return null;
  return (
    <div className="grid gap-4 rounded-lg border bg-card p-5 md:grid-cols-2">
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Tech load</h2>
          {unassigned > 0 && (
            <Badge variant="destructive" className="text-[10px]">
              {unassigned} unassigned
            </Badge>
          )}
        </div>
        <div className="space-y-2">
          {perTech.length === 0 && (
            <div className="text-xs text-muted-foreground">No techs configured.</div>
          )}
          {perTech.map((t) => {
            const pct = Math.round((t.total / maxTotal) * 100);
            const donePct = t.total ? Math.round((t.done / t.total) * 100) : 0;
            return (
              <div key={t.staff.id} className="text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{t.staff.display_name}</span>
                  <span className="text-muted-foreground">
                    {t.done}/{t.total} · ${(t.bookedValue / 100).toFixed(0)}
                    {t.late > 0 && <span className="ml-2 text-destructive">{t.late} late</span>}
                    {t.projectedEnd && (
                      <span className="ml-2">
                        ends{" "}
                        {t.projectedEnd.toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    )}
                  </span>
                </div>
                <div className="mt-1 h-2 w-full overflow-hidden rounded bg-muted">
                  <div className="h-full bg-primary/30" style={{ width: `${pct}%` }}>
                    <div className="h-full bg-primary" style={{ width: `${donePct}%` }} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div>
        <h2 className="mb-2 text-sm font-semibold">Zone density</h2>
        {zones.length === 0 ? (
          <div className="text-xs text-muted-foreground">No visits on this day.</div>
        ) : (
          <div className="space-y-2">
            {zones.map(([name, count]) => (
              <div key={name} className="text-xs">
                <div className="flex justify-between">
                  <span>{name}</span>
                  <span className="text-muted-foreground">{count}</span>
                </div>
                <div className="mt-1 h-2 w-full overflow-hidden rounded bg-muted">
                  <div
                    className="h-full bg-amber-500/70"
                    style={{ width: `${Math.round((count / maxZone) * 100)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
