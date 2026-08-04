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
  bulkAssignVisits,
  bulkRescheduleVisits,
  getStaffUpcomingLoad,
  redistributeStaffWork,
} from "@/lib/visits.functions";
import { backfillPropertyGeocodes } from "@/lib/properties.functions";
import { RouteMap, buildTechGroups, techColorMap } from "@/components/RouteMap";
import { BASE_STYLES, storedBaseStyle, storeBaseStyle, type TileVariant } from "@/lib/map-tiles";
import { StatusChip } from "@/components/client-detail/primitives";
import { listTimeOff } from "@/lib/users.functions";
import { MobileDayList } from "@/components/schedule/MobileDayList";
import { StaffRoutingDialog } from "@/components/routes/StaffRoutingDialog";
import { LaneStrip } from "@/components/routes/LaneStrip";
import { AutoRoutingPanel } from "@/components/routes/AutoRoutingPanel";
import { ScheduleCalendar, calendarWindow } from "@/components/schedule/ScheduleCalendar";
import { VisitDetailDrawer } from "@/components/VisitDetailDrawer";
import { OneOffVisitDialog } from "@/components/OneOffVisitDialog";
import { usePermissions } from "@/hooks/useMyRole";
import { setStaffRouting } from "@/lib/users.functions";
import {
  Navigation,
  CheckCircle2,
  MapPin,
  Settings2,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Users,
  CalendarOff,
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
  /** Compact halves the padding and drops the per-card second line.
   *
   *  Not a cosmetic preference: on a 1440px laptop the comfortable board fits
   *  about five stops per lane before scrolling, and a dispatcher checking
   *  "does Tuesday work" is comparing whole lanes, not reading addresses. The
   *  same screen shows eleven compact. */
  const [density, setDensity] = useState<"comfortable" | "compact">(() =>
    typeof localStorage !== "undefined" && localStorage.getItem("routes.density") === "compact"
      ? "compact"
      : "comfortable",
  );
  const setDensityPersist = (d: "comfortable" | "compact") => {
    setDensity(d);
    try {
      localStorage.setItem("routes.density", d);
    } catch {
      /* private mode */
    }
  };
  const compact = density === "compact";

  /** Map beside the board rather than stacked above it.
   *
   *  Stacked, the board starts below the fold on every laptop, so the two
   *  things you are comparing — a pin and the lane it belongs to — are never
   *  on screen together, which is most of what the linked hover is for.
   *  Off below `lg`, where side-by-side would give each half ~380px. */
  const [sideBySide, setSideBySide] = useState<boolean>(
    () =>
      typeof localStorage === "undefined" || localStorage.getItem("routes.sideBySide") !== "0",
  );
  const setSideBySidePersist = (v: boolean) => {
    setSideBySide(v);
    try {
      localStorage.setItem("routes.sideBySide", v ? "1" : "0");
    } catch {
      /* private mode */
    }
  };

  /** Tech load, hidden by default once you have seen it.
   *
   *  It answers "is anybody overloaded", which is a question you ask
   *  occasionally — but it sat between the map and the board permanently,
   *  pushing the thing you came for further down every single visit. */
  const [showLoad, setShowLoad] = useState<boolean>(
    () => typeof localStorage !== "undefined" && localStorage.getItem("routes.showLoad") === "1",
  );
  const setShowLoadPersist = (v: boolean) => {
    setShowLoad(v);
    try {
      localStorage.setItem("routes.showLoad", v ? "1" : "0");
    } catch {
      /* private mode */
    }
  };

  const [routingDialogStaff, setRoutingDialogStaff] = useState<any>(null);

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

  // ── Multi-select ──────────────────────────────────────────────────────
  //
  // Dispatch could move one visit at a time, by dragging it. Reassigning a
  // tech's Tuesday was fourteen drags.
  //
  // Selection is by visit ID, never by lane contents. The bulk server calls
  // take the id list explicitly for the same reason `persistColumn` must not:
  // a lane is a view, and acting on "everything in this lane" silently means
  // something different the moment a filter is on.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastPickedId, setLastPickedId] = useState<string | null>(null);
  const selectionActive = selected.size > 0;

  const toggleSelect = (id: string, e: React.MouseEvent) => {
    setSelected((prev) => {
      const next = new Set(prev);
      // Shift-click fills the span between the last pick and this one, over
      // the visits as currently ORDERED on screen — which is what "everything
      // between these two" means to someone looking at the board.
      if (e.shiftKey && lastPickedId && lastPickedId !== id) {
        const order = visitsInBoardOrder();
        const a = order.indexOf(lastPickedId);
        const b = order.indexOf(id);
        if (a !== -1 && b !== -1) {
          for (const vid of order.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(vid);
          return next;
        }
      }
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
    setLastPickedId(id);
  };
  const clearSelection = () => {
    setSelected(new Set());
    setLastPickedId(null);
  };

  // Selection is scoped to what is on screen. Carrying it across a day or
  // range change would leave the action bar offering to reassign visits the
  // user can no longer see — and the bulk calls take ids, so it would work.
  useEffect(() => {
    setSelected(new Set());
    setLastPickedId(null);
  }, [day, range]);

  const [baseStyle, setBaseStyle] = useState<TileVariant>(() => storedBaseStyle());
  const setBaseStylePersist = (v: TileVariant) => {
    setBaseStyle(v);
    storeBaseStyle(v);
  };

  // One hovered visit, shared by the board, the calendar and the map.
  //
  // Hovering a card used to leave the map inert and hovering a pin said
  // nothing about which day or whose route it belonged to — two panes showing
  // the same visits, neither able to tell you which was which.
  const [hoveredVisitId, setHoveredVisitId] = useState<string | null>(null);

  const [toolsOpen, setToolsOpen] = useState(false);
  const [detailVisitId, setDetailVisitId] = useState<string | null>(null);
  const [oneOffOpen, setOneOffOpen] = useState(false);
  // Booking a one-off sets a price, so it takes manage_pricing — the same gate
  // createSubscription uses. A dispatcher does not hold it, and the server
  // refuses regardless; hiding the button keeps it from being a form that
  // throws only after it has been filled in.
  const { can: canDo } = usePermissions();
  const canBookOneOff = canDo("manage_pricing");
  // "You shouldn't have to go to settings to say who's a tech." Naming the
  // crew is the same permission as editing the crew — `setStaffRouting` takes
  // `manage_users` and will refuse regardless, so a dispatcher gets no switch
  // rather than a switch that throws.
  const canManageCrew = canDo("manage_users");

  const listV = useServerFn(listVisitsForDay);
  const listS = useServerFn(listStaff);
  const setRouting = useServerFn(setStaffRouting);
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

  /** Every visible visit id, in the order the board draws them.
   *
   *  Shift-click means "everything between these two as I see them", so the
   *  span has to be computed over the RENDERED order — unassigned first, then
   *  each lane in board order — not over the raw fetch order. */
  const visitsInBoardOrder = () => {
    const ids: string[] = [];
    for (const v of columns[UNASSIGNED] ?? []) ids.push(v.id);
    for (const st of staff) for (const v of columns[st.id] ?? []) ids.push(v.id);
    for (const st of stranded) for (const v of columns[st.id] ?? []) ids.push(v.id);
    return ids;
  };

  const bulkAssignFn = useServerFn(bulkAssignVisits);
  const bulkRescheduleFn = useServerFn(bulkRescheduleVisits);
  const loadFn = useServerFn(getStaffUpcomingLoad);
  const redistributeFn = useServerFn(redistributeStaffWork);

  const afterBulk = () => {
    setLocalColumns(null);
    clearSelection();
    qc.invalidateQueries({ queryKey: ["visits"] });
  };

  const bulkAssignMut = useMutation({
    mutationFn: (staffId: string | null) =>
      bulkAssignFn({ data: { visitIds: [...selected], staffId } }),
    onSuccess: (r: any, staffId) => {
      toast.success(
        staffId
          ? `Assigned ${r.moved} visit${r.moved === 1 ? "" : "s"}`
          : `Unassigned ${r.moved} visit${r.moved === 1 ? "" : "s"}`,
      );
      afterBulk();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const bulkRescheduleMut = useMutation({
    mutationFn: (toDate: string) =>
      bulkRescheduleFn({ data: { visitIds: [...selected], toDate } }),
    onSuccess: (r: any) => {
      // `skipped` is not an error and is never swallowed: a weekly client moved
      // exactly a week already has a visit there, and silence would read as
      // "all moved".
      if (r.skipped > 0) {
        toast.warning(
          `Moved ${r.moved}. Left ${r.skipped} alone — those clients already have a visit that day.`,
          { duration: 9000 },
        );
      } else {
        toast.success(`Moved ${r.moved} visit${r.moved === 1 ? "" : "s"}`);
      }
      afterBulk();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  /** Take a tech off the board: show what they are holding, then offer to move
   *  it. Never silent — moving somebody's whole schedule on a checkbox is a
   *  surprise, not a safeguard. */
  const [coverFor, setCoverFor] = useState<{ id: string; name: string } | null>(null);
  const coverQuery = useQuery({
    queryKey: ["staff-load", coverFor?.id],
    queryFn: () => loadFn({ data: { staffId: coverFor!.id } }),
    enabled: Boolean(coverFor),
  });
  const redistributeMut = useMutation({
    mutationFn: () => redistributeFn({ data: { staffId: coverFor!.id } }),
    onSuccess: (r: any) => {
      toast.success(`Moved ${r.moved} visit${r.moved === 1 ? "" : "s"} to the rest of the crew`);
      setCoverFor(null);
      setLocalColumns(null);
      qc.invalidateQueries({ queryKey: ["visits"] });
      qc.invalidateQueries({ queryKey: ["staff"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  /** Who runs routes, set from the board.
   *
   *  This flag decides whether somebody gets a lane, a drop target and an
   *  entry in every assign control on this page — and until now the only
   *  place to set it was Settings → Team, two navigations away from the board
   *  where you notice it's wrong. You notice it *here*: a new hire has no
   *  column, or somebody who left the trucks still has one.
   *
   *  `setStaffRouting` writes `is_field_tech_overridden` alongside the flag,
   *  so the nightly role reconciliation never undoes a deliberate choice made
   *  from this popover. */
  const routingMut = useMutation({
    mutationFn: (v: { staffId: string; isFieldTech: boolean }) =>
      setRouting({ data: { staffId: v.staffId, isFieldTech: v.isFieldTech } }),
    onSuccess: (_r, v) => {
      toast.success(v.isFieldTech ? "Added to the routing crew" : "Taken off the routing crew");
      // The board's lanes ARE this list, so it has to redraw. Visits too:
      // a stranded lane stops being stranded the moment the flag flips.
      qc.invalidateQueries({ queryKey: ["staff"] });
      qc.invalidateQueries({ queryKey: ["visits"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

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
  const listTimeOffFn = useServerFn(listTimeOff);
  const timeOffQ = useQuery({
    queryKey: ["time-off", rangeStart, rangeEnd],
    queryFn: () => listTimeOffFn({ data: { from: rangeStart, to: rangeEnd } }),
  });
  /** Off on the SELECTED day. Ranges are inclusive of both ends, matching
   *  `is_staff_off` in SQL — the badge and the guard have to agree or the
   *  board says someone is available while the server refuses to assign
   *  them. */
  const offToday = useMemo(() => {
    const out = new Set<string>();
    for (const t of timeOffQ.data?.timeOff ?? []) {
      if (day >= t.starts_on && day <= t.ends_on) out.add(t.staff_id);
    }
    return out;
  }, [timeOffQ.data, day]);

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
                <div className="text-sm font-medium">Density</div>
                <div className="text-[11px] text-muted-foreground">
                  Compact fits roughly twice as many stops per lane before scrolling.
                </div>
                <div className="inline-flex rounded-md border p-0.5 text-xs">
                  {(["comfortable", "compact"] as const).map((d) => (
                    <button
                      key={d}
                      className={`px-3 py-1 rounded capitalize ${density === d ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
                      onClick={() => setDensityPersist(d)}
                    >
                      {d}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium">Map beside the board</div>
                  <div className="text-[11px] text-muted-foreground">
                    Keeps a pin and its lane on screen together. Stacks below 1280px.
                  </div>
                </div>
                <Switch checked={sideBySide} onCheckedChange={setSideBySidePersist} />
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
          {canManageCrew && (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" title="Who runs routes">
                  <Users className="h-4 w-4" />
                  <span className="ml-1.5 max-sm:hidden">Crew</span>
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-80 p-0">
                <div className="border-b px-3 py-2">
                  <div className="text-sm font-medium">Who runs routes</div>
                  <div className="text-[11px] text-muted-foreground">
                    Everyone switched on here gets a lane on the board and can be assigned
                    work. Everyone else stays in the office.
                  </div>
                </div>
                <div className="max-h-72 overflow-y-auto">
                  {allStaff.length === 0 ? (
                    <div className="px-3 py-4 text-xs text-muted-foreground">
                      Nobody on the team yet.{" "}
                      <Link to="/settings/users" className="underline">
                        Invite someone
                      </Link>
                      .
                    </div>
                  ) : (
                    allStaff.map((s: any) => (
                      <div
                        key={s.id}
                        className="flex items-center justify-between gap-3 border-b px-3 py-2 last:border-0"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-sm">{s.display_name}</div>
                          <div className="text-[11px] text-muted-foreground capitalize">
                            {s.role ? humanizeRole(s.role) : "—"}
                            {/* Only ever shown for someone being switched OFF,
                                where it is the consequence rather than trivia:
                                their lane is about to disappear with work
                                still in it. */}
                            {s.is_field_tech && assignedIds.has(s.id) ? (
                              <span> · holds work today</span>
                            ) : null}
                            {offToday.has(s.id) ? (
                              <span className="text-amber-600"> · off today</span>
                            ) : null}
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-[11px]"
                            onClick={() => setRoutingDialogStaff(s)}
                            title="Time off and route endpoints"
                          >
                            <CalendarOff className="h-3.5 w-3.5" />
                          </Button>
                          <Switch
                            checked={Boolean(s.is_field_tech)}
                            disabled={routingMut.isPending}
                            onCheckedChange={(next) =>
                              routingMut.mutate({ staffId: s.id, isFieldTech: next })
                            }
                            aria-label={`${s.display_name} runs routes`}
                          />
                        </div>
                      </div>
                    ))
                  )}
                </div>
                <div className="border-t px-3 py-2 text-[11px] text-muted-foreground">
                  Switching somebody off doesn&apos;t move their visits — use{" "}
                  <strong>Cover</strong> on their lane for that.
                </div>
              </PopoverContent>
            </Popover>
          )}
          <Button variant="outline" size="sm" onClick={() => setToolsOpen((v) => !v)}>
            {toolsOpen ? "Hide auto-routing" : "Auto-routing"}
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
        <AutoRoutingPanel
          day={day}
          staff={staff}
          onApplied={() => setLocalColumns(null)}
        />
      )}

      {toolsOpen && (
        <div className="space-y-4 rounded-lg border bg-card p-5">
          <div className="text-xs font-medium text-muted-foreground">
            One tech, one day
          </div>
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
        <LaneStrip
          from={rangeStart}
          to={rangeEnd}
          visits={shownVisits as any}
          staff={staff}
          timeOff={timeOffQ.data?.timeOff ?? []}
          techColors={techColors}
          hideWeekends={hideWeekends}
          compact={compact}
          onPickDay={(d) => {
            setLocalColumns(null);
            setDay(d);
            setRangePersist("today");
          }}
        />
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
            hoveredVisitId={hoveredVisitId}
            onHoverVisit={setHoveredVisitId}
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
                baseStyle={baseStyle}
                onBaseStyle={setBaseStylePersist}
                hoveredVisitId={hoveredVisitId}
                onHoverVisit={setHoveredVisitId}
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

      {/* Today: map and board side by side by default.
          Stacked, the board began below the fold on every laptop, so a pin and
          the lane it belongs to were never visible together — which is most of
          what hovering one to light the other is for. */}
      {range === "today" && (
        <div
          className={
            sideBySide && viewMode === "map"
              ? "grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] xl:items-start"
              : "space-y-4"
          }
        >
          {viewMode === "map" && (
          <div className={sideBySide ? "xl:sticky xl:top-4" : ""}>
            <MapPanel
              baseStyle={baseStyle}
              onBaseStyle={setBaseStylePersist}
              hoveredVisitId={hoveredVisitId}
              onHoverVisit={setHoveredVisitId}
              visits={visits}
              staff={staff}
              onOpenVisit={setDetailVisitId}
              onGeocode={() => geocodeMut.mutate()}
              geocoding={geocodeMut.isPending}
              compact={compact}
              drawRoutes
            />
          </div>
          )}
          {/* Tech load is a FIELD-worker report (C3/I4): only capability-flagged
              field workers are route runners. Non-field roles stay on the board
              below (so a mis-assigned visit can be dragged off them) but never
              appear in the load analytics.

              Collapsed by default. It answers "is anybody overloaded", which is
              an occasional question, and it used to sit permanently between the
              map and the board pushing the thing you came for down the page. */}
          <div className="min-w-0 space-y-4">
            {showLoad ? (
              <div className="space-y-1">
                <div className="flex justify-end">
                  <button
                    onClick={() => setShowLoadPersist(false)}
                    className="rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    Hide tech load
                  </button>
                </div>
                <HeatmapPanel
                  visits={visits}
                  staff={staff.filter((s: any) => s.is_field_tech)}
                />
              </div>
            ) : (
              <button
                onClick={() => setShowLoadPersist(true)}
                className="w-full rounded-lg border border-dashed px-3 py-1.5 text-left text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                Show tech load
              </button>
            )}
            {/* Mobile Phase 2: below `md` the dnd board is replaced by a
                tap-through day list (per-tech rows → VisitDetailDrawer). This
                comment used to claim reassignment and reschedule happen via
                "the drawer's existing controls"; the drawer has neither, and
                saying so here is how the same wrong claim got repeated into
                MobileDayList and into its user-facing footer. Mobile is
                observe + close-out; moving work between techs or between days
                is desktop-only (Q-12). */}
            <div className="md:hidden">
              <MobileDayList visits={visits} staff={staff} onOpen={setDetailVisitId} />
            </div>

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
                selectedIds={selected}
                onToggleSelect={toggleSelect}
                onSelectLane={(ids) => setSelected(new Set([...selected, ...ids]))}
                selectionActive={selectionActive}
                hoveredVisitId={hoveredVisitId}
                onHover={setHoveredVisitId}
              />
              {staff.map((s: any) => {
                const offRoutes = s.is_field_tech && !s.routing_available;
                const away = offToday.has(s.id);
                return (
                  <Column
                    key={s.id}
                    id={s.id}
                    title={s.display_name}
                    subtitle={s.role ? humanizeRole(s.role) : undefined}
                    offRoutes={offRoutes}
                    offToday={away}
                    items={columns[s.id] ?? []}
                    layout={boardLayout}
                    onComplete={(id) => completeMut.mutate(id)}
                    completingId={completeMut.isPending ? (completeMut.variables as string) : null}
                    onOpen={setDetailVisitId}
                    selectedIds={selected}
                    onToggleSelect={toggleSelect}
                    onSelectLane={(ids) => setSelected(new Set([...selected, ...ids]))}
                    selectionActive={selectionActive}
                    hoveredVisitId={hoveredVisitId}
                    onHover={setHoveredVisitId}
                    laneAction={
                      <button
                        onClick={() => setCoverFor({ id: s.id, name: s.display_name })}
                        className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
                        title={`${s.display_name} is out — move their work`}
                      >
                        Cover
                      </button>
                    }
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
                  notRoutableHint={
                    canManageCrew ? (
                      <>Still holding work — drag it to a tech, or let them run routes.</>
                    ) : undefined
                  }
                  laneAction={
                    canManageCrew ? (
                      <button
                        onClick={() => routingMut.mutate({ staffId: s.id, isFieldTech: true })}
                        disabled={routingMut.isPending}
                        className="rounded border border-rose-300 px-1.5 py-0.5 text-[10px] text-rose-700 hover:bg-rose-50 disabled:opacity-50"
                        title={`Let ${s.display_name} run routes`}
                      >
                        Let them run routes
                      </button>
                    ) : undefined
                  }
                  items={columns[s.id] ?? []}
                  layout={boardLayout}
                  onComplete={(id) => completeMut.mutate(id)}
                  completingId={completeMut.isPending ? (completeMut.variables as string) : null}
                  onOpen={setDetailVisitId}
                  selectedIds={selected}
                  onToggleSelect={toggleSelect}
                  onSelectLane={(ids) => setSelected(new Set([...selected, ...ids]))}
                  selectionActive={selectionActive}
                  hoveredVisitId={hoveredVisitId}
                  onHover={setHoveredVisitId}
                />
              ))}
            </div>
            <DragOverlay>
              {activeVisit ? <VisitCardView visit={activeVisit} dragging /> : null}
            </DragOverlay>
          </DndContext>
            </div>
          </div>
        </div>
      )}

      {/* Week and month keep their own phone list — the selected day's visits,
          filtered out of the wider window the calendar fetched. A single
          shared instance used to do both with a ternary; two call sites with
          genuinely different inputs is clearer than one that is neither.
          Rendered at EVERY range: week/month once left phones with no visit
          list at all. */}
      {range !== "today" && (
        <div className="md:hidden">
          <MobileDayList
            visits={visits.filter((v: any) => v.scheduled_on === day)}
            staff={staff}
            onOpen={setDetailVisitId}
          />
        </div>
      )}
      <StaffRoutingDialog
        staff={routingDialogStaff}
        open={Boolean(routingDialogStaff)}
        onOpenChange={(o) => !o && setRoutingDialogStaff(null)}
      />
      <OneOffVisitDialog
        open={oneOffOpen}
        onOpenChange={setOneOffOpen}
        onCreated={() => {
          setLocalColumns(null);
          qc.invalidateQueries({ queryKey: ["visits"] });
        }}
      />

      {/* Selection action bar. Fixed to the bottom rather than inline: it has
          to stay reachable while you scroll a long board picking the next
          visit, and an inline bar scrolls away exactly when it is being used. */}
      {selectionActive && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-card/95 p-3 shadow-lg backdrop-blur">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 text-xs">
            <span className="font-medium">
              {selected.size} selected
            </span>
            <select
              className="h-8 rounded-md border bg-background px-2"
              defaultValue=""
              onChange={(e) => {
                const v = e.target.value;
                e.target.value = "";
                if (v === "__unassign__") bulkAssignMut.mutate(null);
                else if (v) bulkAssignMut.mutate(v);
              }}
              disabled={bulkAssignMut.isPending}
            >
              <option value="">Assign to…</option>
              {staff.map((st: any) => (
                <option key={st.id} value={st.id}>
                  {st.display_name}
                  {st.routing_available ? "" : " (away)"}
                </option>
              ))}
              <option value="__unassign__">— Unassign —</option>
            </select>
            <label className="inline-flex items-center gap-1.5 rounded-md border bg-background px-2 py-1">
              <span className="text-muted-foreground">Move to</span>
              <input
                type="date"
                className="bg-transparent focus-visible:outline-none"
                onChange={(e) => e.target.value && bulkRescheduleMut.mutate(e.target.value)}
                disabled={bulkRescheduleMut.isPending}
              />
            </label>
            <Button size="sm" variant="ghost" onClick={clearSelection}>
              Clear
            </Button>
            <span className="ml-auto text-muted-foreground">
              Shift-click for a range · completed visits are never moved
            </span>
          </div>
        </div>
      )}

      {/* Cover: what happens when someone is out.
          Marking a tech unavailable used to change a flag and nothing else —
          their work stayed assigned to somebody who is not coming in, and the
          only way to notice was to open each day and see the lane still full.
          This shows the work FIRST and then asks. */}
      {coverFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-lg border bg-card p-5 shadow-xl">
            <h2 className="text-base font-semibold">{coverFor.name} is out</h2>
            {coverQuery.isLoading ? (
              <p className="mt-3 text-sm text-muted-foreground">Checking what they&apos;re holding…</p>
            ) : (coverQuery.data?.total ?? 0) === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">
                They have no upcoming work. Nothing to move.
              </p>
            ) : (
              <>
                <p className="mt-3 text-sm">
                  They still have{" "}
                  <strong>
                    {coverQuery.data?.total} visit{coverQuery.data?.total === 1 ? "" : "s"}
                  </strong>{" "}
                  across {coverQuery.data?.days?.length} day
                  {coverQuery.data?.days?.length === 1 ? "" : "s"}, starting{" "}
                  {coverQuery.data?.days?.[0]?.scheduled_on}.
                </p>
                <div className="mt-3 max-h-40 overflow-y-auto rounded border">
                  <table className="w-full text-xs">
                    <tbody>
                      {(coverQuery.data?.days ?? []).map((d: any) => (
                        <tr key={d.scheduled_on} className="border-b last:border-0">
                          <td className="px-2 py-1">{d.scheduled_on}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{d.visits}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  Moving spreads it round-robin across the technicians who are available, day by
                  day, and clears the stop order so it can be optimised again. Completed visits stay
                  where they are.
                </p>
              </>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setCoverFor(null)}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => redistributeMut.mutate()}
                disabled={redistributeMut.isPending || (coverQuery.data?.total ?? 0) === 0}
              >
                {redistributeMut.isPending ? "Moving…" : "Move their work"}
              </Button>
            </div>
          </div>
        </div>
      )}

      <VisitDetailDrawer
        visitId={detailVisitId}
        onOpenChange={(o) => !o && setDetailVisitId(null)}
      />
    </div>
  );
}


/** Toggleable weekday chips for the org's operating days (0=Sun..6=Sat). */
function MapPanel({
  baseStyle,
  onBaseStyle,
  hoveredVisitId,
  onHoverVisit,
  visits,
  staff,
  onOpenVisit,
  onGeocode,
  geocoding,
  compact = false,
  drawRoutes = true,
}: {
  baseStyle: TileVariant;
  onBaseStyle: (v: TileVariant) => void;
  hoveredVisitId?: string | null;
  onHoverVisit?: (id: string | null) => void;
  visits: any[];
  staff: any[];
  onOpenVisit?: (id: string) => void;
  onGeocode?: () => void;
  geocoding?: boolean;
  /** Tighter chrome and a shorter map. Side by side the map shares the row
   *  with the board, and 420px of tiles pushes the first lane off screen on a
   *  1080p display — the arrangement exists to keep both visible. */
  compact?: boolean;
  drawRoutes?: boolean;
}) {
  const groups = useMemo(() => buildTechGroups(visits as any, staff as any), [visits, staff]);
  const mappable = visits.filter(
    (v: any) => v.properties?.latitude != null && v.properties?.longitude != null,
  ).length;
  const missing = visits.length - mappable;
  return (
    <div className={`rounded-lg border bg-card ${compact ? "p-2.5" : "p-4"}`}>
      <div className={`flex flex-wrap items-center justify-between gap-2 ${compact ? "mb-2" : "mb-3"}`}>
        <div>
          <h2 className="text-sm font-semibold">Map</h2>
          <p className="text-[11px] text-muted-foreground">
            {mappable} of {visits.length} visits on map. Click a pin or a card to view details.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={baseStyle}
            onChange={(e) => onBaseStyle(e.target.value as TileVariant)}
            className="h-7 rounded-md border bg-background px-2 text-[11px]"
            title={BASE_STYLES.find((b) => b.value === baseStyle)?.hint}
            aria-label="Map style"
          >
            {BASE_STYLES.map((b) => (
              <option key={b.value} value={b.value} title={b.hint}>
                {b.label}
              </option>
            ))}
          </select>
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
        <RouteMap
          groups={groups}
          height={compact ? 320 : 420}
          onVisitClick={onOpenVisit}
          drawRoutes={drawRoutes}
          baseStyle={baseStyle}
          hoveredVisitId={hoveredVisitId}
          onHoverVisit={onHoverVisit}
        />
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
  offToday,
  notRoutable,
  notRoutableHint,
  onComplete,
  completingId,
  onOpen,
  layout = "columns",
  selectedIds,
  onToggleSelect,
  onSelectLane,
  selectionActive,
  hoveredVisitId,
  onHover,
  laneAction,
}: {
  id: string;
  title: string;
  subtitle?: string;
  items: any[];
  tone?: "muted";
  offRoutes?: boolean;
  /** Has dated time off covering the day on screen. Distinct from `offRoutes`,
   *  which is the undated same-day flag — this one has an end and the server
   *  refuses assignment for it. */
  offToday?: boolean;
  selectedIds?: Set<string>;
  onToggleSelect?: (id: string, e: React.MouseEvent) => void;
  onSelectLane?: (ids: string[]) => void;
  selectionActive?: boolean;
  hoveredVisitId?: string | null;
  onHover?: (id: string | null) => void;
  /** Rendered in the lane header — the tech-out control lives here. */
  laneAction?: React.ReactNode;
  /** Holds visits but is not a field tech. Read-only: the server refuses new
   *  assignments here, so accepting a drop would only produce an error toast. */
  notRoutable?: boolean;
  /** Overrides the default "…in Settings → Team" remedy when the caller can
   *  offer a shorter one. */
  notRoutableHint?: React.ReactNode;
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
      className={`rounded-lg border ${tone === "muted" ? "bg-muted/30" : offRoutes || offToday ? "bg-muted/40 opacity-70" : "bg-card"} ${
        isOver ? "ring-2 ring-primary" : ""
      }`}
    >
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            <span className="truncate">{title}</span>
            {offToday && (
              <Badge variant="outline" className="border-amber-400 text-amber-700 text-[10px]">
                Away
              </Badge>
            )}
            {offRoutes && !offToday && (
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
            // the dispatcher can reach either from here — the second one now
            // literally so, via the lane's own button, for anyone who holds
            // manage_users. Readers who don't still get told where it lives.
            <div className="text-xs text-rose-700">
              {notRoutableHint ?? (
                <>
                  Still holding work — drag it to a tech, or turn on “Runs routes” for them in
                  Settings → Team.
                </>
              )}
            </div>
          ) : (
            subtitle && <div className="text-xs text-muted-foreground capitalize">{subtitle}</div>
          )}
        </div>
        <div className="flex items-center gap-1.5 text-right">
          {laneAction}
          {onSelectLane && items.length > 0 && (
            <button
              onClick={() => onSelectLane(items.map((v) => v.id))}
              className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
              title="Select every visit in this lane"
            >
              All
            </button>
          )}
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
              selected={selectedIds?.has(v.id)}
              onToggleSelect={onToggleSelect}
              selectionActive={selectionActive}
              hovered={hoveredVisitId === v.id}
              onHover={onHover}
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
  selected,
  onToggleSelect,
  selectionActive,
  hovered,
  onHover,
}: {
  visit: Visit;
  seq: number;
  onComplete?: (id: string) => void;
  completing?: boolean;
  onOpen?: (id: string) => void;
  selected?: boolean;
  onToggleSelect?: (id: string, e: React.MouseEvent) => void;
  selectionActive?: boolean;
  hovered?: boolean;
  onHover?: (id: string | null) => void;
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
        selected={selected}
        onToggleSelect={onToggleSelect}
        selectionActive={selectionActive}
        hovered={hovered}
        onHover={onHover}
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
  selected,
  onToggleSelect,
  selectionActive,
  hovered,
  onHover,
}: {
  visit: Visit;
  seq?: number;
  dragging?: boolean;
  dragHandle?: any;
  onComplete?: (id: string) => void;
  completing?: boolean;
  onOpen?: (id: string) => void;
  selected?: boolean;
  onToggleSelect?: (id: string, e: React.MouseEvent) => void;
  /** True once anything is selected anywhere on the board. */
  selectionActive?: boolean;
  hovered?: boolean;
  onHover?: (id: string | null) => void;
}) {
  const p = visit.properties;
  const dirUrl = directionsUrl(p);
  const canComplete =
    onComplete && (visit.status === "scheduled" || visit.status === "in_progress");
  return (
    <div
      onMouseEnter={() => onHover?.(visit.id)}
      onMouseLeave={() => onHover?.(null)}
      className={`rounded-md border p-2 text-xs shadow-sm transition ${dragging ? "shadow-lg" : ""} ${
        selected ? "border-primary bg-primary/5 ring-1 ring-primary" : "bg-background"
      } ${hovered ? "border-primary bg-muted/60 ring-1 ring-primary/60" : ""} ${
        onOpen ? "cursor-pointer hover:border-primary/40 hover:bg-muted/40" : ""
      }`}
      onClick={(e) => {
        const t = e.target as HTMLElement;
        if (t.closest("a,button,input,label")) return;
        // Once a selection exists, a plain click EXTENDS it rather than opening
        // a drawer. Anything else means picking a fifth visit closes the four
        // you had — the single most common way a multi-select gets abandoned.
        if (selectionActive && onToggleSelect) {
          onToggleSelect(visit.id, e);
          return;
        }
        if (!onOpen) return;
        onOpen(visit.id);
      }}
    >
      <div className="flex items-start gap-2">
        {onToggleSelect && (
          <input
            type="checkbox"
            checked={Boolean(selected)}
            aria-label={`Select ${visit.clients?.display_name ?? "visit"}`}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) =>
              onToggleSelect(visit.id, e as unknown as React.MouseEvent)
            }
            className="mt-1 shrink-0"
          />
        )}
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
