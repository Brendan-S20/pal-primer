import { createFileRoute, Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { warnLessonClashes } from "@/components/training/lessonClashWarning";
import { humanizeRole } from "@/lib/humanize";
import { orgLocalTime } from "@/lib/org-day";
import { useOrgTimezone, useOrgToday } from "@/hooks/useOrgToday";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import {
  listVisitsForDay,
  listStaff,
  reassignVisit,
  reorderRoute,
  completeVisitFromOffice,
  bulkAssignVisits,
  bulkRescheduleVisits,
  getStaffUpcomingLoad,
  redistributeStaffWork,
  getDispatchSettings,
} from "@/lib/visits.functions";
import { backfillPropertyGeocodes } from "@/lib/properties.functions";
import { RouteMap, buildTechGroups, legendEntries, techColorMap } from "@/components/RouteMap";
import { WeatherStrip, hasPrecipitationRisk } from "@/components/WeatherStrip";
import { getWeatherForZones } from "@/lib/weather.functions";
import { findRouteWarnings } from "@/lib/route-plausibility";
import { formatDistance } from "@/lib/measures";
import { useDistanceUnit } from "@/hooks/useDistanceUnit";
import { BASE_STYLES, storedBaseStyle, storeBaseStyle, type TileVariant } from "@/lib/map-tiles";
import { StatusChip } from "@/components/client-detail/primitives";
import { listTimeOff } from "@/lib/users.functions";
import { MobileDayList } from "@/components/schedule/MobileDayList";
import { StaffRoutingDialog } from "@/components/routes/StaffRoutingDialog";
import { LaneStrip } from "@/components/routes/LaneStrip";
import { AutoRoutingPanel } from "@/components/routes/AutoRoutingPanel";
import { GroupWalksPanel } from "@/components/routes/GroupWalksPanel";
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
  AlertTriangle,
  ChevronDown,
  CloudRain,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { formatDay } from "@/lib/format";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay,
  closestCenter,
  pointerWithin,
  type CollisionDetection,
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
import { titleHead } from "@/lib/page-title";
import { visitStayDates } from "@/lib/stays";
import { skipReasonText } from "@/lib/skip-reason-text";

export const Route = createFileRoute("/_authenticated/routes")({
  head: () => titleHead("Schedule"),
  // Wide — see src/components/PageShell.tsx. The dispatch board: a column per
  // technician, and a week view seven days across.
  staticData: { pageWidth: "wide" },
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
    // MEASURED 2026-08-19: 26.0px. The `<label>` wraps the `<select>`, so the
    // label's box IS the hit area and it is the one that has to reach the
    // floor — sizing the select alone would leave the border it sits in short.
    <label className="inline-flex items-center gap-1.5 rounded-md border bg-card px-2 py-1 touch:min-h-11">
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
function RoutesPage() {
  // The ORG's today, not the phone's. This is the dispatch board: drag a
  // card, bulk-reassign a lane, complete from the office, and the day it
  // opens on is the day those actions land on. It asked the device, the
  // same fault My Day and the client pages were cured of, and this page
  // was the one the sweeps missed. Explicit pick, else the org's today,
  // resolved at render so it also follows midnight (the My Day pattern);
  // `setDay(null)` means "back to following today".
  const orgTodayIso = useOrgToday();
  const distanceUnit = useDistanceUnit();
  const [pickedDay, setDay] = useState<string | null>(null);
  const day = pickedDay ?? orgTodayIso;
  const [activeId, setActiveId] = useState<string | null>(null);
  const [localColumns, setLocalColumns] = useState<Record<string, Visit[]> | null>(null);

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
    () => typeof localStorage === "undefined" || localStorage.getItem("routes.sideBySide") !== "0",
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

  /** Weather is not a panel you keep. It is a warning, or it is nothing.
   *
   *  This used to be the same collapsed-by-default toggle the tech-load panel
   *  beside it still has: a permanent full-width "Show weather" button, and a
   *  remembered preference behind it. On the great majority of days that
   *  button was a dashed rectangle offering to tell the owner it is not going
   *  to rain — a permanent affordance for an occasional question, which is
   *  the same complaint that got the strip collapsed in the first place, one
   *  step further along.
   *
   *  "Remove the show weather and keep as an icon above, or only present when
   *  it's supposed to rain or snow." So: an icon, and only on a day the
   *  forecast says carries precipitation risk. Otherwise nothing renders at
   *  all — no button, no dashed box, no reserved row.
   *
   *  Nothing is persisted, and there is nothing left to persist: the state
   *  below is whether the strip is open right now, which lasts as long as you
   *  are looking at that day. The localStorage key that backed the old toggle
   *  is gone with it — a remembered "yes, show me weather" means nothing once
   *  the affordance only exists on the days it matters. It sat under the same
   *  `routes.` prefix as the settings above; anyone still carrying the old
   *  value in their browser now carries a key nothing reads. */
  const [weatherOpen, setWeatherOpen] = useState(false);

  /** Whether the heading's calendar is open. Nothing to persist: it closes on
   *  pick, like every other popover on this page. */
  const [datePickerOpen, setDatePickerOpen] = useState(false);

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
  // `?autoroute=review` is where the header's "Planning routes…" pill and the
  // "Routes ready" push both land: open the auto-routing card, which shows a
  // run in progress or replays a finished one. Read raw rather than through
  // validateSearch, so every other <Link to="/routes"> stays as it is; and
  // removed once read, so a refresh does not reopen the card.
  const autorouteParam = useRouterState({
    select: (r) => (r.location.search as Record<string, unknown>).autoroute,
  });
  const navigate = useNavigate();
  useEffect(() => {
    if (!autorouteParam) return;
    setToolsOpen(true);
    void navigate({ href: "/routes", replace: true });
  }, [autorouteParam, navigate]);
  const [detailVisitId, setDetailVisitId] = useState<string | null>(null);
  const [oneOffOpen, setOneOffOpen] = useState(false);
  // Booking a one-off takes the booking permission (#616), which a dispatcher
  // holds. The price stays manage_pricing: without it the dialog books at the
  // set price, and the server refuses any other.
  const { can: canDo, role } = usePermissions();
  const canBookOneOff = canDo("booking");
  // "You shouldn't have to go to settings to say who's a tech." Naming the
  // crew is the same permission as editing the crew — `setStaffRouting` takes
  // `manage_users` and will refuse regardless, so a dispatcher gets no switch
  // rather than a switch that throws.
  const canManageCrew = canDo("manage_users");

  const listV = useServerFn(listVisitsForDay);
  const listS = useServerFn(listStaff);
  const setRouting = useServerFn(setStaffRouting);
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

  // The heading was the literal word "Today", and it stayed that way while the
  // range selector switched the page to a whole week or month and the arrows
  // walked the selected day off today entirely.
  //
  // That is not a cosmetic mismatch on this page. Everything below is a live
  // dispatch surface — drag a card, bulk-reassign a lane, complete a visit from
  // the office — and the heading is the ONLY thing that says which day those
  // actions land on. A dispatcher who glanced at "Today", saw a board, and
  // moved work was moving it on whatever day the page actually held.
  //
  // Built from the same rangeStart/rangeEnd the query fetches and the calendar
  // draws, so the title cannot drift from the data underneath it — the drift
  // above is precisely what happens when a heading is written independently of
  // the window it describes.
  const heading = useMemo(() => {
    // Parsed as LOCAL midnight, never `new Date("2026-08-09")`, which is
    // UTC midnight and renders as the previous day west of Greenwich.
    const at = (iso: string) => new Date(`${iso}T00:00:00`);
    if (range === "month") {
      return at(rangeStart).toLocaleDateString(undefined, { month: "long", year: "numeric" });
    }
    if (range === "week") {
      const from = at(rangeStart);
      const to = at(rangeEnd);
      // The year only when the week straddles one, so the common case stays
      // short and the awkward case stays unambiguous.
      const opts: Intl.DateTimeFormatOptions =
        from.getFullYear() === to.getFullYear()
          ? { month: "short", day: "numeric" }
          : { month: "short", day: "numeric", year: "numeric" };
      return `${from.toLocaleDateString(undefined, opts)} – ${to.toLocaleDateString(undefined, opts)}`;
    }
    // Still literally "Today" when it is today — the word is the right one for
    // the case people are in nearly all of the time, and losing it to a date
    // string would make the ordinary day read as an unusual one.
    if (day === orgTodayIso) return "Today";
    return at(day).toLocaleDateString(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric",
    });
  }, [range, day, rangeStart, rangeEnd, orgTodayIso]);
  const { data: visitsData } = useQuery({
    queryKey: ["visits", rangeStart, rangeEnd],
    queryFn: () =>
      listV({
        data: { day: rangeStart, ...(rangeEnd !== rangeStart ? { throughDay: rangeEnd } : {}) },
      }),
  });
  const { data: staffData } = useQuery({ queryKey: ["staff"], queryFn: () => listS() });

  /** Is the selected day forecast to rain or snow?
   *
   *  This runs on load, so the function it calls matters more than usual.
   *
   *  `getWeatherForZones` READS: zones, visit counts, and a forecast cache
   *  that it fills from Open-Meteo. It is the same call the header's forecast
   *  popover makes.
   *
   *  `analyzeDayWeather` — the one WeatherStrip runs when you press "Check
   *  weather" — WRITES. It sets `weather_flagged` and `weather_note` on the
   *  day's visit rows. Deciding whether to draw a button is not a reason to
   *  mark a dispatcher's visits, and a page that flagged visits merely by
   *  being opened would be marking days nobody had looked at yet. It stays an
   *  explicit action, taken from inside the strip, and is not reachable from
   *  here.
   *
   *  Only for the single-day view: the strip acts on one date, so a week or a
   *  month has no single day for this to be about. `enabled` keeps the query
   *  from firing at all in those ranges.
   *
   *  A failure is silent on purpose. If the forecast cannot be fetched there
   *  is no risk to report, and an error banner about the weather service on a
   *  dispatch board is noise about a thing the reader cannot act on. */
  const getWeatherFn = useServerFn(getWeatherForZones);
  const weatherQ = useQuery({
    queryKey: ["routes-weather-risk", day],
    queryFn: () => getWeatherFn({ data: { fromDate: day, toDate: day } }),
    enabled: range === "today",
    staleTime: 10 * 60_000,
    retry: false,
  });

  /** True only when a zone with a working forecast says this exact date brings
   *  precipitation. `hasPrecipitationRisk` lives beside the strip and explains
   *  why wind and freezing temperatures do not count. */
  const dayHasPrecipitationRisk = useMemo(() => {
    const zones = (weatherQ.data as { zones?: any[] } | undefined)?.zones ?? [];
    return zones.some(
      (z: any) =>
        z.status === "ok" &&
        (z.days ?? []).some((d: any) => d.date === day && hasPrecipitationRisk(d)),
    );
  }, [weatherQ.data, day]);

  // Close the strip when the day underneath it changes. It was opened about a
  // specific date's forecast; leaving it open would carry an answer about
  // Tuesday onto Wednesday's board.
  useEffect(() => {
    setWeatherOpen(false);
  }, [day, range]);

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

  /** Route plausibility (QA finding #10).
   *
   *  The optimizer would schedule a stop 1,850 km / 61 h from the depot without
   *  saying anything, and could show an arrival time that its own drive figure
   *  does not allow. `findRouteWarnings` was written to catch both, tested
   *  against that exact repro, and then rendered nowhere — the dispatcher went
   *  on getting no warning until rule 6 of the dead-machinery check found the
   *  module unreachable.
   *
   *  Thresholds come from the org's dispatch settings, not the helper's
   *  defaults: an org whose day starts at 06:00 or whose cap is 90 minutes
   *  would otherwise be measured against 08:00 and 240, and warned either far
   *  too much or not at all. The query is the same one Settings > Scheduling
   *  uses, so it is usually already in cache. */
  const dispatchFn = useServerFn(getDispatchSettings);
  const dispatchQ = useQuery({
    queryKey: ["dispatch-settings"],
    queryFn: () => dispatchFn(),
    staleTime: 5 * 60_000,
  });
  const routeWarnings = useMemo(() => {
    const s = dispatchQ.data?.settings as
      | {
          max_drive_minutes?: number | null;
          workday_start?: string | null;
          timezone?: string | null;
        }
      | undefined;
    // "08:30:00" -> 510. Left undefined when unset so the helper's default
    // applies rather than a silent 0, which would flag every stop.
    const startMin = (() => {
      const [h, m] = (s?.workday_start ?? "").split(":");
      const mins = Number(h) * 60 + Number(m);
      return Number.isFinite(mins) ? mins : undefined;
    })();
    return findRouteWarnings(
      visits.map((v: any) => ({
        id: v.id,
        clientName: v.clients?.display_name ?? null,
        travel_km: v.travel_km,
        travel_min: v.travel_min,
        eta_start: v.eta_start,
        scheduled_on: v.scheduled_on,
      })),
      {
        maxDriveMinutes: s?.max_drive_minutes ?? undefined,
        workdayStartMinutes: startMin,
        // The ETA check measures "minutes into the day" on the ORG's clock —
        // an instant compared against a wall-clock workday start. Without the
        // zone the helper falls back to the column default, and a dispatcher's
        // device east of the org would read every correct 8 AM ETA as
        // implausible. Same row as the two thresholds above, so the warning
        // and the setting can never disagree here either.
        timezone: s?.timezone ?? undefined,
        // The unit the cards below print, so a warning and the card it is
        // about give the same distance in the same unit (#496).
        distanceUnit,
      },
    );
  }, [visits, dispatchQ.data, distanceUnit]);

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
        if (fTeam !== "all" && fTeam !== "unassigned" && v.assigned_staff_id !== fTeam)
          return false;
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
  const { confirm: confirmMove, dialog: moveDialog } = useConfirmDialog();
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
      if (r.clash) toast.warning(r.clash);
      warnLessonClashes(r);
      if (r.clash) toast.warning(r.clash);
      afterBulk();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const bulkRescheduleMut = useMutation({
    mutationFn: (toDate: string) => bulkRescheduleFn({ data: { visitIds: [...selected], toDate } }),
    onSuccess: (r: any) => {
      // `skipped` is not an error and is never swallowed: a weekly client moved
      // exactly a week already has a visit there, and silence would read as
      // "all moved".
      if (r.skipped > 0) {
        toast.warning(
          `Moved ${r.moved}. Left ${r.skipped} alone, because those clients already have a visit that day.`,
          { duration: 9000 },
        );
      } else {
        toast.success(`Moved ${r.moved} visit${r.moved === 1 ? "" : "s"}`);
      }
      if (r.clash) toast.warning(r.clash);
      warnLessonClashes(r);
      if (r.clash) toast.warning(r.clash);
      afterBulk();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  /** Take a tech off the board: show what they are holding, then offer to move
   *  it. Never silent — moving somebody's whole schedule on a checkbox is a
   *  surprise, not a safeguard. */
  const [coverFor, setCoverFor] = useState<{ id: string; name: string } | null>(null);
  /** Off by default (#619): Cover moves the away dates only. Work after the
   *  last away day stays with the tech unless this is ticked. */
  const [coverLater, setCoverLater] = useState(false);
  const openCover = (who: { id: string; name: string }) => {
    setCoverLater(false);
    setCoverFor(who);
  };
  const coverQuery = useQuery({
    queryKey: ["staff-load", coverFor?.id, day, orgTodayIso],
    queryFn: () => loadFn({ data: { staffId: coverFor!.id, day, today: orgTodayIso } }),
    enabled: Boolean(coverFor),
  });
  const coverWindow = coverQuery.data?.window ?? null;
  const coverMoveTotal =
    (coverQuery.data?.total ?? 0) + (coverLater ? (coverQuery.data?.laterTotal ?? 0) : 0);
  const redistributeMut = useMutation({
    mutationFn: () =>
      redistributeFn({
        data: {
          staffId: coverFor!.id,
          from: coverWindow?.from,
          to: coverWindow?.to,
          includeLater: coverLater,
        },
      }),
    onSuccess: (r: any) => {
      if (r.left > 0) {
        toast.warning(
          `Moved ${r.moved}. Left ${r.left} with ${coverFor!.name}, because nobody else could take ${r.left === 1 ? "it" : "them"}: another tech already has a groom at that time, or is off that day. ${(r.leftAppointments ?? []).map((v: { client: string; day: string; startTime: string | null }) => `${v.client}, ${v.day} ${v.startTime ?? ""}`).join("; ")}`,
          { duration: 9000 },
        );
      } else {
        toast.success(`Moved ${r.moved} visit${r.moved === 1 ? "" : "s"} to the rest of the crew`);
      }
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
  // assignMut / optimizeMut / weekMut / reoptMut lived here. They backed the
  // deleted "One tech, one day" card, and optimizeMut sent `reassign: true` —
  // the call that reassigned an entire day's visits, across every tech, to one
  // person. Removing the JSX alone would have left that call in the bundle,
  // unreachable today and one careless re-wire from being reachable again.
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
        `Geocoded ${r.updated} addresses${r.rezoned ? `, ${r.rezoned} placed in a zone` : ""}${r.remaining ? ` · ${r.remaining} remaining` : ""}`,
      );
      if (r.zonesUnread)
        toast.error(
          `Zones could not be read, so ${r.zonesUnread} geocoded addresses kept their old zone. Re-run zone detection on the Zones page.`,
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

  /** Refetch, then drop the optimistic snapshot.
   *
   *  `columns` returns `localColumns` whenever it is set, so leaving it in
   *  place after a drag freezes the board on that snapshot until something
   *  else happens to clear it: the invalidate refetches, the query updates,
   *  and nothing on screen moves. Everything ELSE on the page — the map, the
   *  calendar, the tech-load panel, the route-warnings banner — reads the
   *  fresh `visits`, so a stale snapshot means two panes on one screen
   *  disagreeing about where a visit is.
   *
   *  Awaiting the refetch BEFORE clearing is what keeps this from flickering:
   *  the fresh data is already in place when the snapshot goes, so the board
   *  never falls back to the pre-drag order for a frame. */
  const settle = async () => {
    await qc.invalidateQueries({ queryKey: ["visits", day] });
    setLocalColumns(null);
  };

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
      await settle();
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
      const r = await reassign({
        data: { visitId: moved.id, staffId: toCol === UNASSIGNED ? null : toCol },
      });
      if (r.clash) toast.warning(r.clash);
      warnLessonClashes(r);
      if (toCol !== UNASSIGNED) await persistColumn(toCol, next[toCol]);
      if (fromCol !== UNASSIGNED) await persistColumn(fromCol, next[fromCol]);
    } catch (err) {
      // Drop the optimistic move. Without this the reassign fails, a toast
      // appears, and the card STAYS in the lane it never reached — so the
      // board says one tech has the visit and the database says another.
      // Nobody drives to that yard. `persistColumn`, twenty lines up, has
      // always done this; only the cross-lane path forgot.
      setLocalColumns(null);
      toast.error((err as Error).message);
    }
    await settle();
  }

  const activeVisit = activeId ? visits.find((v) => v.id === activeId) : null;

  /** An empty Unassigned lane is drawn as a 3.5rem strip so its width goes to
   *  the techs (#495). It stays collapsed during a drag: widening it at drag
   *  start would shove every lane sideways under the pointer, after dnd-kit
   *  has measured where they are. The collision rule below is what makes the
   *  narrow strip easy to hit instead. */
  const unassignedEmpty = (columns[UNASSIGNED] ?? []).length === 0;
  const unassignedCollapsed = boardLayout === "columns" && unassignedEmpty;

  /** `closestCenter` compares the CENTRE of the dragged card, and the grip is
   *  at the card's left edge, so with the pointer on a 56px strip the card's
   *  centre is over the first tech lane and that lane wins. While the strip is
   *  collapsed, a pointer inside it means Unassigned; everywhere else the
   *  board behaves exactly as it did. */
  const collisionDetection: CollisionDetection = (args) => {
    if (unassignedCollapsed) {
      const onStrip = pointerWithin({
        ...args,
        droppableContainers: args.droppableContainers.filter((c) => c.id === UNASSIGNED),
      });
      if (onStrip.length > 0) return onStrip;
    }
    return closestCenter(args);
  };

  const [laneRow, setLaneRow] = useState<HTMLDivElement | null>(null);
  const laneRowShape = [staff.length, stranded.length, unassignedCollapsed];
  const moreLanesToTheEnd = useMoreToTheEnd(laneRow, laneRowShape);

  return (
    <>
      {moveDialog}
      {visitsData?.clash && (
        <p
          role="alert"
          className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
        >
          {visitsData.clash}
        </p>
      )}
      <div className="flex flex-wrap items-end justify-between gap-3">
        {/* ── THE PAGE IS CALLED SCHEDULE, AND NOW SAYS SO ─────────────────
            The sidebar, the tab bar, the command palette and the dashboard all
            call this page Schedule. Its own heading said "Today ▾", because the
            heading was also the date picker, so pressing Schedule landed on a
            page that called itself something else (launch pass, 2026-10,
            recommendation 3).

            So the heading is the page's name and the date is the control
            beside it, keeping everything it did as the heading:

            "I like clicking on the month and it opens the date picker instead
            of it being separate." The label is built from the same window the
            board fetches, so it cannot drift from the data, and pressing it
            opens the calendar. The chevron is not decoration: it is the only
            thing on screen that says this text does something.

            One wrapping row, so at 360px the date drops under the heading
            instead of pushing the toolbar off the side. */}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
            <h1 className="text-2xl font-semibold">Schedule</h1>
            <Popover open={datePickerOpen} onOpenChange={setDatePickerOpen}>
              <PopoverTrigger asChild>
                {/* No aria-label. The button's own text IS its name — "August
                    2026" — and an aria-label would replace the one thing the
                    reader needs with a description of the control. Radix puts
                    aria-haspopup and aria-expanded on the trigger, which is
                    where "and it opens something" belongs. */}
                <button
                  type="button"
                  title="Pick a date"
                  data-testid="schedule-date"
                  className="-mx-2 flex min-h-[2.75rem] items-center gap-1.5 rounded-md px-2 text-left text-lg font-medium hover:bg-muted md:mouse:min-h-0 md:py-1"
                >
                  {heading}
                  <ChevronDown className="h-5 w-5 shrink-0 text-muted-foreground" />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-auto p-0">
                <Calendar
                  mode="single"
                  selected={new Date(`${day}T00:00:00`)}
                  defaultMonth={new Date(`${day}T00:00:00`)}
                  onSelect={(picked) => {
                    if (!picked) return;
                    setLocalColumns(null);
                    setDay(toLocalISO(picked));
                    setDatePickerOpen(false);
                  }}
                  autoFocus
                  /* 44px cells on a phone, the calendar's own 32px from md up.
                     Seven 44px columns plus the card's padding is 332px, which
                     fits a 360px viewport with room for the popover's collision
                     padding — the narrow end this has to survive. */
                  className="[--cell-size:2.75rem] md:[--cell-size:2rem]"
                />
              </PopoverContent>
            </Popover>
            {/* Step by whatever you are LOOKING at: a day, a week or a calendar
                month, so the control matches the view it drives. Beside the
                date it steps rather than in the toolbar: at 1024px the toolbar
                wrapped to three rows (QA row 43), and the heading row had the
                room. */}
            <div className="inline-flex items-center gap-1">
              <Button
                variant="outline"
                size="icon"
                className="h-9 w-9 shrink-0"
                onClick={() => shiftDay(-1)}
                title={`Previous ${rangeNoun}`}
                aria-label={`Previous ${rangeNoun}`}
              >
                <ChevronLeft className="h-4 w-4 shrink-0" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="h-9 w-9 shrink-0"
                onClick={() => shiftDay(1)}
                title={`Next ${rangeNoun}`}
                aria-label={`Next ${rangeNoun}`}
              >
                <ChevronRight className="h-4 w-4 shrink-0" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-9"
                onClick={() => {
                  setLocalColumns(null);
                  setDay(null);
                }}
                disabled={day === orgTodayIso}
              >
                Today
              </Button>
            </div>
          </div>
          {/* A-P2-10: completing a visit from the office is an owner or office
              manager action (office_complete_visit refuses a dispatcher), so
              only they are told this page marks visits complete. */}
          <p className="text-sm text-muted-foreground">
            {role === "owner" || role === "office_manager"
              ? "Dispatch, route, map, and mark visits complete, all in one view."
              : "Dispatch, route and map visits, all in one view."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* The emergency button. A one-off used to mean going to the client,
              opening Services, adding a "service", choosing One time, and then
              waiting for the nightly run to put it on the board — which is not
              a thing anyone does while someone is on the phone. */}
          {canBookOneOff && (
            <Button variant="outline" onClick={() => setOneOffOpen(true)}>
              <CalendarClock className="mr-1.5 h-4 w-4 shrink-0" />
              One-off visit
            </Button>
          )}
          {/* Two clean axes instead of five mixed buttons: WHAT you look at
              (Map = map + load + board, Board = board only) and WHEN
              (Today / Week / Month). */}
          <div className="inline-flex rounded-md border bg-card p-0.5 text-xs">
            {(["map", "board"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setViewModePersist(m)}
                // MEASURED 2026-08-19: 36.0px. `max-md:py-2.5` was an attempt at
                // this and it fell four short — padding around a 16px line
                // cannot be reasoned to 44 without doing the arithmetic, and
                // nobody had. A minimum states the intent directly.
                className={`px-3 py-1.5 touch:min-h-11 rounded ${viewMode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
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
                className={`px-3 py-1.5 touch:min-h-11 rounded ${range === r ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                {r === "today" ? "Day" : r === "week" ? "Week" : "Month"}
              </button>
            ))}
          </div>
          {/* The controls used now and then (display options, and who runs
              routes) share one "More" menu, so the toolbar stays one row at
              1024px. They were two more buttons on it. */}
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                title="Display options and crew"
                data-testid="schedule-more"
              >
                <Settings2 className="h-4 w-4 shrink-0" />
                <span className="ml-1.5">More</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="max-h-[min(36rem,calc(100vh-6rem))] w-80 max-w-[calc(100vw-1rem)] space-y-4 overflow-y-auto"
            >
              <div className="text-xs font-semibold uppercase text-muted-foreground">Display</div>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium">Hide weekends</div>
                  <div className="text-2xs text-muted-foreground">
                    Skip Sat/Sun in Week and Month views.
                  </div>
                </div>
                <Switch checked={hideWeekends} onCheckedChange={setHideWeekendsPersist} />
              </div>
              <p className="border-b pb-3 text-2xs text-muted-foreground">
                Workday hours, work days and travel assumptions live in{" "}
                <Link to="/settings/scheduling" className="underline underline-offset-2">
                  Settings → Scheduling
                </Link>
                .
              </p>
              <div className="space-y-1.5">
                <div className="text-sm font-medium">Density</div>
                <div className="text-2xs text-muted-foreground">
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
                  <div className="text-2xs text-muted-foreground">
                    Keeps a pin and its lane on screen together. Stacks below 1280px.
                  </div>
                </div>
                <Switch checked={sideBySide} onCheckedChange={setSideBySidePersist} />
              </div>
              <div className="space-y-1.5">
                <div className="text-sm font-medium">Board layout</div>
                <div className="text-2xs text-muted-foreground">
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
              {canManageCrew && (
                <div className="-mx-4 -mb-4 border-t" data-testid="schedule-crew">
                  <div className="border-b px-3 py-2">
                    <div className="flex items-center gap-1.5 text-sm font-medium">
                      <Users className="h-4 w-4 shrink-0" />
                      Who runs routes
                    </div>
                    <div className="text-2xs text-muted-foreground">
                      Everyone switched on here gets a lane on the board and can be assigned work.
                      Everyone else stays in the office.
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
                            <div className="text-2xs text-muted-foreground capitalize">
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
                              className="h-7 px-2 text-2xs"
                              onClick={() => setRoutingDialogStaff(s)}
                              title="Time off and route endpoints"
                            >
                              <CalendarOff className="h-3.5 w-3.5 shrink-0" />
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
                  <div className="border-t px-3 py-2 text-2xs text-muted-foreground">
                    Switching somebody off doesn&apos;t move their visits, so use{" "}
                    <strong>Cover</strong> on their lane for that.
                  </div>
                </div>
              )}
            </PopoverContent>
          </Popover>
          <Button variant="outline" size="sm" onClick={() => setToolsOpen((v) => !v)}>
            {toolsOpen ? "Hide auto-routing" : "Auto-routing"}
          </Button>
        </div>
      </div>

      {/* Auto-routing: things you DO to the day in front of you.
          The configuration that used to share this drawer — workday hours,
          work days, speed and traffic assumptions — moved to Settings →
          Scheduling. One button held both, so "Planning tools" meant a date
          picker, three optimizers and the definition of a working week, and
          you had to open it to find out which you were about to get.
          The day picker that sat here too is gone: the header already has one,
          and two date inputs on one screen setting the same day is not a
          choice anybody wants to make.
          It renders FLOATING now (fixed, bottom-right) rather than inline. As
          an inline block it pushed the board down the moment you opened it, so
          you lost sight of the schedule exactly when you started rearranging
          it. Its position in this file no longer affects where it appears. */}
      {toolsOpen && (
        <AutoRoutingPanel
          day={day}
          staff={staff}
          onApplied={() => setLocalColumns(null)}
          onClose={() => setToolsOpen(false)}
          onReviewDay={(d) => setDay(d)}
        />
      )}

      <GroupWalksPanel day={day} staff={staff} onChanged={() => setLocalColumns(null)} />

      {/* The "One tech, one day" card that stood here is gone, and with it a
          live data-loss bug.
          Its Optimize button sent `reassign: true`. In optimize_route_v2 that
          branch selects EVERY scheduled visit on the day — org-wide, not the
          selected tech's — and writes assigned_staff_id = the chosen tech onto
          all of them. Pick a tech, press Optimize, and the whole day belonged
          to one person. There was no confirm, no preview and no undo, and the
          helper text under the button said it "re-sequences what they already
          have".
          Everything the card could do is reachable from Auto-routing above,
          which previews first and never silently reassigns: Assign is covered
          because plan_route already ingests unassigned stops; one-tech and
          multi-day optimize are the tech and date pickers; "Re-optimize today"
          is no techs selected with today's date.
          The Settings pointer it carried survives, in the Display popover. */}

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
            // That day's board, whose first column is Unassigned. The day board
            // is where a visit gets assigned, by dragging it out of that column.
            onPickUnassigned={(d) => {
              setLocalColumns(null);
              setDay(d);
              setRangePersist("today");
              setViewModePersist("board");
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
                // Routes DO draw here now. They used to be off because
                // buildTechGroups keyed on tech alone, so a week's stops sorted
                // by `sequence` — which restarts at 1 daily — zig-zagged across
                // days. Grouping per tech per day fixes the cause; `multiDay`
                // then draws every day faintly and hover lifts one.
                drawRoutes
                multiDay
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
                emptyText={day === orgTodayIso ? "No visits today." : "No visits on this day."}
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
            {/* Implausible routes come first and are NOT collapsible.

                Weather and tech load are questions you choose to ask; this is
                the board telling you something is wrong with what it just drew.
                A 61-hour drive or an arrival time the route's own drive figure
                cannot produce is not a preference — hiding it behind a toggle
                is how it went unnoticed for as long as the helper existed with
                nothing rendering it. */}
            {routeWarnings.length > 0 && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3">
                <div className="flex items-center gap-2 text-sm font-medium text-destructive">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  {routeWarnings.length} implausible {routeWarnings.length === 1 ? "stop" : "stops"}{" "}
                  on this route
                </div>
                <ul className="mt-2 space-y-1">
                  {routeWarnings.map((w) => (
                    <li key={`${w.visitId}-${w.reason}`}>
                      {/* A whole sentence is the control here, so the 44px
                          floor is met by giving the row height rather than by
                          padding a glyph.

                          This was `max-md:` until 2026-09-15, on the reasoning
                          that "the sweep measures by width, not by pointer
                          type". That was true of the default sweep, which only
                          asks for 44px at or below 768px. It is NOT true under
                          APPLE_SIZES, which sets `hasTouch` and runs the floor
                          at every Apple size — so an iPad Pro at 1366px is a
                          touch device with a 16px target, and these two buttons
                          failed at 820, 844, 1024, 1180 and 1366.

                          `touch:` is the rule the product actually has:
                          `(pointer: coarse), (max-width: 767px)`. A finger on an
                          iPad is still a finger. A mouse at 1366 still gets the
                          tight list of links. */}
                      <button
                        type="button"
                        onClick={() => setDetailVisitId(w.visitId)}
                        className="flex w-full items-center text-left text-xs text-destructive underline-offset-2 hover:underline touch:min-h-11 touch:py-1"
                      >
                        {w.message}
                      </button>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-2xs text-muted-foreground">
                  Thresholds come from{" "}
                  <Link to="/settings/scheduling" className="underline underline-offset-2">
                    Settings → Scheduling
                  </Link>
                  .
                </p>
              </div>
            )}
            {/* Weather sits above tech load: "is today workable at all" comes
                before "is anybody overloaded". Only for the single-day view —
                the strip analyses one date, and offering it while the board
                shows a week or a month would be a control that silently acts on
                a day you are not looking at.

                And only on a day the forecast says will rain or snow. On a dry
                day this whole branch renders nothing: no icon, no empty row,
                nothing to scroll past. The icon IS the warning — its presence
                is the information, before anything is clicked — which is why
                it is drawn in the destructive colour and why there is no
                greyed-out version of it for clear days.

                44px box around a 16px glyph below md, per CLAUDE.md and the
                pattern in ui/dialog.tsx; a pointer gets the tighter 36px box
                from md up. The label says "Show weather" / "Hide weather"
                because an icon-only control has to say what it is to a screen
                reader, and `title` puts the same words under a mouse. */}
            {range === "today" && dayHasPrecipitationRisk && (
              <div className="space-y-1">
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => setWeatherOpen((v) => !v)}
                    aria-expanded={weatherOpen}
                    aria-label={weatherOpen ? "Hide weather" : "Show weather"}
                    title={weatherOpen ? "Hide weather" : "Show weather"}
                    className="flex h-11 w-11 items-center justify-center rounded-md text-destructive hover:bg-muted md:mouse:h-9 md:mouse:w-9"
                  >
                    <CloudRain className="h-4 w-4 shrink-0" />
                  </button>
                </div>
                {weatherOpen && <WeatherStrip day={day} />}
              </div>
            )}
            {showLoad ? (
              <div className="space-y-1">
                <div className="flex justify-end">
                  <button
                    onClick={() => setShowLoadPersist(false)}
                    className="rounded px-2 py-0.5 text-2xs text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    Hide tech load
                  </button>
                </div>
                <HeatmapPanel visits={visits} staff={staff.filter((s: any) => s.is_field_tech)} />
              </div>
            ) : (
              <button
                onClick={() => setShowLoadPersist(true)}
                // MEASURED 2026-08-19: 29.0px — the shortest control on the
                // board, because `text-2xs` shrank the line the padding was
                // sized around.
                className="w-full rounded-lg border border-dashed px-3 py-1.5 text-left text-2xs text-muted-foreground hover:bg-muted hover:text-foreground touch:min-h-11"
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

            {/* Lanes are ONE ROW, never a second grid row (#495).

                This used to be a wrapping grid, 2/3/4 columns by container
                width. At 1032px (an iPad in landscape) that gave Unassigned
                plus two techs, and the third tech wrapped onto a row below the
                fold, so the board never showed the whole crew at once. Lanes
                in the same row are the point of a dispatch board: dragging
                from the first tech to the last has to be one gesture.

                So every lane asks for at least 15rem (240px, what a card needs
                with its header unbroken) and grows to share whatever is left
                (`flex-[1_0_15rem]`). If they all fit, they share the row and
                nothing scrolls. If they do not, the ROW scrolls sideways
                inside its own `overflow-x-auto`, never the page, and a fade
                on the end edge says more lanes are there.

                Drag across that scroll: dnd-kit's autoScroll scrolls the
                nearest scrollable ancestor of the dragged card, which is this
                row, when the pointer nears its edge, so a lane that starts
                off-screen comes to the card. A swipe on a card body scrolls
                the row; only the grip starts a drag (`touch-none` on it, and
                the PointerSensor wants 5px of travel first).

                An empty Unassigned lane is a 3.5rem strip (count and a
                vertical label), still the same droppable. The rows layout is
                its own mode and keeps its one-lane-per-row grid. */}
            <div className="@container relative max-md:hidden">
              <DndContext
                sensors={sensors}
                collisionDetection={collisionDetection}
                autoScroll
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
              >
                <div
                  ref={setLaneRow}
                  data-lane-row
                  className={
                    boardLayout === "rows"
                      ? "grid gap-4 grid-cols-1"
                      : "flex items-stretch gap-4 overflow-x-auto pb-2"
                  }
                >
                  <Column
                    id={UNASSIGNED}
                    title="Unassigned"
                    items={columns[UNASSIGNED] ?? []}
                    tone="muted"
                    collapsed={unassignedCollapsed}
                    dropHint={activeId !== null}
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
                        completingId={
                          completeMut.isPending ? (completeMut.variables as string) : null
                        }
                        onOpen={setDetailVisitId}
                        selectedIds={selected}
                        onToggleSelect={toggleSelect}
                        onSelectLane={(ids) => setSelected(new Set([...selected, ...ids]))}
                        selectionActive={selectionActive}
                        hoveredVisitId={hoveredVisitId}
                        onHover={setHoveredVisitId}
                        laneAction={
                          <button
                            onClick={() => openCover({ id: s.id, name: s.display_name })}
                            // 18px from `py-0.5` around a 3xs line. Moving a
                            // whole lane's work because someone called in sick is
                            // not a control to aim at.
                            className="rounded px-1.5 py-0.5 text-3xs text-muted-foreground hover:bg-muted hover:text-foreground touch:min-h-11 touch:px-3"
                            title={`${s.display_name} is out, move their work`}
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
                          <>Still holding work. Drag it to a tech, or let them run routes.</>
                        ) : undefined
                      }
                      laneAction={
                        canManageCrew ? (
                          <button
                            onClick={() => routingMut.mutate({ staffId: s.id, isFieldTech: true })}
                            disabled={routingMut.isPending}
                            className="rounded border border-rose-300 px-1.5 py-0.5 text-3xs text-rose-700 hover:bg-rose-50 disabled:opacity-50"
                            title={`Let ${s.display_name} run routes`}
                          >
                            Let them run routes
                          </button>
                        ) : undefined
                      }
                      items={columns[s.id] ?? []}
                      layout={boardLayout}
                      onComplete={(id) => completeMut.mutate(id)}
                      completingId={
                        completeMut.isPending ? (completeMut.variables as string) : null
                      }
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
                {boardLayout === "columns" && moreLanesToTheEnd && (
                  <div
                    aria-hidden
                    data-more-lanes
                    className="pointer-events-none absolute inset-y-0 end-0 w-12 bg-linear-to-l from-background to-transparent rtl:bg-linear-to-r"
                  />
                )}
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
      {/* Room under the floating auto-routing card, at the foot of the page,
          so the last cards of a lane can be scrolled up out from under it.
          The card measures itself into --auto-routing-h (QA row 17). */}
      {toolsOpen && (
        <div
          aria-hidden="true"
          data-auto-routing-room=""
          className="h-[var(--auto-routing-h,0px)]"
        />
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
            <span className="font-medium">{selected.size} selected</span>
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
              <option value="__unassign__">(Unassign)</option>
            </select>
            <label className="inline-flex items-center gap-1.5 rounded-md border bg-background px-2 py-1">
              <span className="text-muted-foreground">Move to</span>
              <input
                type="date"
                className="bg-transparent focus-visible:outline-none"
                // A date picker fires on every change, and on a phone every
                // scroll of the wheel is a change: this moved the selection
                // the moment a day was touched. It asks first now.
                onChange={async (e) => {
                  const input = e.currentTarget;
                  const to = input.value;
                  if (!to) return;
                  const n = selected.size;
                  const ok = await confirmMove({
                    title: `Move ${n} visit${n === 1 ? "" : "s"} to ${formatDay(to)}?`,
                    description:
                      "Completed visits are never moved, and a client who already has a visit that day is left alone.",
                    confirmLabel: "Move visits",
                  });
                  input.value = "";
                  if (ok) bulkRescheduleMut.mutate(to);
                }}
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
            {coverWindow && (
              <p className="mt-1 text-sm text-muted-foreground">
                {coverWindow.source === "time_off" ? "Time off " : "Just "}
                <strong className="text-foreground">
                  {coverWindow.from === coverWindow.to
                    ? formatDay(coverWindow.from)
                    : `${formatDay(coverWindow.from)} to ${formatDay(coverWindow.to)}`}
                </strong>
                {coverWindow.source === "day" ? ", no time off is recorded" : ""}
                {coverWindow.reason ? ` (${coverWindow.reason})` : ""}
              </p>
            )}
            {coverQuery.isLoading ? (
              <p className="mt-3 text-sm text-muted-foreground">
                Checking what they&apos;re holding…
              </p>
            ) : (coverQuery.data?.total ?? 0) + (coverQuery.data?.laterTotal ?? 0) === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">
                They have no upcoming work. Nothing to move.
              </p>
            ) : (
              <>
                <p className="mt-3 text-sm">
                  {(coverQuery.data?.total ?? 0) === 0 ? (
                    "They have no visits on those dates."
                  ) : (
                    <>
                      They have{" "}
                      <strong>
                        {coverQuery.data?.total} visit{coverQuery.data?.total === 1 ? "" : "s"}
                      </strong>{" "}
                      on those dates.
                    </>
                  )}
                </p>
                {(coverQuery.data?.days?.length ?? 0) > 0 && (
                  <div className="mt-3 max-h-40 overflow-y-auto rounded border">
                    <table className="w-full text-xs">
                      <tbody>
                        {(coverQuery.data?.days ?? []).map((d) => (
                          <tr key={d.scheduled_on} className="border-b last:border-0">
                            <td className="px-2 py-1">{formatDay(d.scheduled_on)}</td>
                            <td className="px-2 py-1 text-right tabular-nums">{d.visits}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {(coverQuery.data?.laterTotal ?? 0) > 0 && (
                  <label className="mt-3 flex min-h-11 cursor-pointer items-start gap-3 rounded border p-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 shrink-0"
                      checked={coverLater}
                      onChange={(e) => setCoverLater(e.target.checked)}
                    />
                    <span className="min-w-0">
                      Also move later work
                      <span className="block text-xs text-muted-foreground">
                        {coverQuery.data?.laterTotal} more visit
                        {coverQuery.data?.laterTotal === 1 ? "" : "s"} after{" "}
                        {coverWindow ? formatDay(coverWindow.to) : "these dates"}. Left unticked,
                        they stay with {coverFor.name}.
                      </span>
                    </span>
                  </label>
                )}
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
                disabled={redistributeMut.isPending || coverMoveTotal === 0}
              >
                {redistributeMut.isPending
                  ? "Moving…"
                  : `Move ${coverMoveTotal} visit${coverMoveTotal === 1 ? "" : "s"}`}
              </Button>
            </div>
          </div>
        </div>
      )}

      <VisitDetailDrawer
        visitId={detailVisitId}
        onOpenChange={(o) => !o && setDetailVisitId(null)}
      />
    </>
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
  multiDay = false,
  emptyText = "No visits to show.",
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
  multiDay?: boolean;
  /** What an empty day says (#423). The geocoding prompt is for visits that
   *  have no pin, never for a day that has no visits. */
  emptyText?: string;
}) {
  // perDay must match multiDay: grouping and rendering disagreeing is exactly
  // the bug this replaces.
  const groups = useMemo(
    () => buildTechGroups(visits as any, staff as any, multiDay),
    [visits, staff, multiDay],
  );
  const mappable = visits.filter(
    (v: any) => v.properties?.latitude != null && v.properties?.longitude != null,
  ).length;
  const missing = visits.length - mappable;
  return (
    <div className={`rounded-lg border bg-card ${compact ? "p-2.5" : "p-4"}`}>
      <div
        className={`flex flex-wrap items-center justify-between gap-2 ${compact ? "mb-2" : "mb-3"}`}
      >
        <div>
          <h2 className="text-sm font-semibold">Map</h2>
          <p className="text-2xs text-muted-foreground">
            {mappable} of {visits.length} visits on map. Tap a pin or a card to view details.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Hidden while only one basemap is available. CARTO's two styles
              were removed when it began watermarking our tiles (see
              map-tiles.ts), and a picker offering a single choice is a control
              that does nothing. It returns on its own the moment a second
              style is added. */}
          {BASE_STYLES.length > 1 && (
            <select
              value={baseStyle}
              onChange={(e) => onBaseStyle(e.target.value as TileVariant)}
              className="h-7 rounded-md border bg-background px-2 text-2xs"
              title={BASE_STYLES.find((b) => b.value === baseStyle)?.hint}
              aria-label="Map style"
            >
              {BASE_STYLES.map((b) => (
                <option key={b.value} value={b.value} title={b.hint}>
                  {b.label}
                </option>
              ))}
            </select>
          )}
          {onGeocode && missing > 0 && (
            <Button size="sm" variant="outline" onClick={onGeocode} disabled={geocoding}>
              <MapPin className="mr-1 h-3.5 w-3.5 shrink-0" />
              {geocoding ? "Geocoding…" : `Geocode ${missing} address${missing === 1 ? "" : "es"}`}
            </Button>
          )}
          {legendEntries(groups).map((g) => (
            <div key={g.key} className="flex items-center gap-1 text-2xs">
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
          multiDay={multiDay}
          baseStyle={baseStyle}
          hoveredVisitId={hoveredVisitId}
          onHoverVisit={onHoverVisit}
        />
        {visits.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center rounded-md bg-background/70 text-sm text-muted-foreground">
            {emptyText}
          </div>
        ) : (
          mappable === 0 && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-md bg-background/70 text-xs text-muted-foreground">
              <span>No coordinates yet. Geocode your properties to plot them.</span>
              {onGeocode && (
                <Button size="sm" variant="outline" onClick={onGeocode} disabled={geocoding}>
                  <MapPin className="mr-1 h-3.5 w-3.5 shrink-0" />
                  {geocoding ? "Geocoding…" : "Geocode addresses"}
                </Button>
              )}
            </div>
          )
        )}
      </div>
    </div>
  );
}

// Finding #28 + punch list #13: a multi-day overview so office staff can see
// upcoming volume, overloaded days, and gaps across a week, rolling 4 weeks,
// or a true calendar month — with weekends optionally hidden.

/** True while a horizontal scroller has content past its end edge: it
 *  overflows and is not scrolled all the way. Drives the lane row's edge fade
 *  (#495). `Math.abs` because `scrollLeft` counts down from 0 under
 *  `dir="rtl"`. The lanes themselves are observed too, because a lane changing
 *  width (Unassigned collapsing, a long day of cards) changes the overflow
 *  without the scroller's own box moving at all. */
function useMoreToTheEnd(el: HTMLElement | null, deps: unknown[]) {
  const [more, setMore] = useState(false);
  useEffect(() => {
    if (!el) {
      setMore(false);
      return;
    }
    const measure = () => setMore(el.scrollWidth - el.clientWidth - Math.abs(el.scrollLeft) > 1);
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(el);
    for (const child of Array.from(el.children)) ro?.observe(child);
    return () => {
      el.removeEventListener("scroll", measure);
      ro?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [el, ...deps]);
  return more;
}

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
  collapsed,
  dropHint,
}: {
  id: string;
  title: string;
  subtitle?: string;
  items: any[];
  tone?: "muted";
  /** Drawn as a narrow strip: the count and a vertical label. Still the same
   *  droppable, so a visit dragged onto it lands in this lane (#495). */
  collapsed?: boolean;
  /** A drag is in progress somewhere on the board. Only the collapsed strip
   *  reads it, to look like somewhere a card can go. */
  dropHint?: boolean;
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
  // Inset in the columns layout: the lane row scrolls sideways, and a
  // scroller clips on both axes, so a ring drawn outside the lane loses its
  // top, bottom and outer edges to the row it sits in.
  const overRing = layout === "columns" ? "ring-2 ring-inset ring-primary" : "ring-2 ring-primary";
  if (collapsed) {
    // Full height of the row, so the whole strip is the target, not a box
    // the size of the label. The label reads bottom to top like a book spine.
    return (
      <div
        ref={setNodeRef}
        data-lane-collapsed
        title={`${title}: nothing here. Drop a visit to unassign it.`}
        className={`flex w-14 flex-none flex-col items-center gap-3 rounded-lg border bg-muted/30 py-2 ${
          dropHint ? "border-dashed border-primary" : ""
        } ${isOver ? overRing : ""}`}
      >
        <Badge variant="secondary">{items.length}</Badge>
        <span className="rotate-180 whitespace-nowrap text-xs font-medium text-muted-foreground [writing-mode:vertical-rl]">
          {title}
        </span>
      </div>
    );
  }
  return (
    <div
      ref={setNodeRef}
      className={`min-w-0 rounded-lg border ${layout === "columns" ? "flex-[1_0_15rem]" : ""} ${tone === "muted" ? "bg-muted/30" : offRoutes || offToday ? "bg-muted/40 opacity-70" : "bg-card"} ${
        isOver ? overRing : ""
      }`}
    >
      {/* The header WRAPS rather than squeezing. The name block asks for at
          least 9rem and grows; when the lane cannot hold that beside the
          lane's controls (Cover, All, the count and the day's value), the
          controls drop to a line of their own under the name, instead of
          truncating the name to its first few letters. On a wide lane the
          two still share one row, as before. */}
      <div
        data-lane-header
        className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b px-3 py-2"
      >
        <div className="min-w-0 flex-[1_1_9rem]">
          <div className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
            <span className="truncate" data-lane-title>
              {title}
            </span>
            {offToday && (
              <Badge variant="outline" className="border-amber-400 text-amber-700 text-3xs">
                Away
              </Badge>
            )}
            {offRoutes && !offToday && (
              <Badge variant="outline" className="border-amber-400 text-amber-700 text-3xs">
                Off routes
              </Badge>
            )}
            {notRoutable && (
              <Badge variant="outline" className="border-rose-400 text-rose-700 text-3xs">
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
                  Still holding work. Drag it to a tech, or turn on “Runs routes” for them in
                  Settings → Users &amp; roles.
                </>
              )}
            </div>
          ) : (
            subtitle && <div className="text-xs text-muted-foreground capitalize">{subtitle}</div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5 text-right">
          {laneAction}
          {onSelectLane && items.length > 0 && (
            <button
              onClick={() => onSelectLane(items.map((v) => v.id))}
              // 18px. Selecting a whole lane is a bulk action — the kind
              // where hitting the wrong thing costs the most — and it sat
              // next to the Cover button that had the same fault.
              className="rounded px-1.5 py-0.5 text-3xs text-muted-foreground hover:bg-muted hover:text-foreground touch:min-h-11 touch:px-3"
              title="Select every visit in this lane"
            >
              All
            </button>
          )}
          <Badge variant="secondary">{items.length}</Badge>
          {totalCents > 0 && (
            <div className="mt-0.5 text-3xs text-muted-foreground">
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
  const tz = useOrgTimezone();
  const distanceUnit = useDistanceUnit();
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
          // 13px, and the bulk-select control on every stop card. The square
          // stays 13px; the LABEL around it is the 44px box on a touch screen,
          // so a tap anywhere in it toggles the box (QA row 23). It replaced a
          // `::before` on the input itself: a native checkbox is a replaced
          // element, and whether its pseudo-element draws, and takes the tap,
          // is up to the browser. A label's hit area is not.
          // stopPropagation on both: the label's own click and the click it
          // forwards to the input each bubble to the card, whose onClick would
          // toggle the selection a second time.
          <label
            data-select-hit=""
            onClick={(e) => e.stopPropagation()}
            className="mt-1 flex shrink-0 cursor-pointer items-center justify-center touch:mt-0 touch:min-h-11 touch:min-w-11"
          >
            <input
              type="checkbox"
              checked={Boolean(selected)}
              aria-label={`Select ${visit.clients?.display_name ?? "visit"}`}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => onToggleSelect(visit.id, e as unknown as React.MouseEvent)}
              className="shrink-0 cursor-pointer"
            />
          </label>
        )}
        <button
          {...(dragHandle ?? {})}
          // 16px, no accessible name — a fault twice over. The grip is how a
          // stop gets reordered, so on a tablet it is the control most likely
          // to be aimed at with a finger and it was the smallest on the card.
          aria-label="Drag to reorder this stop"
          className="mt-0.5 flex cursor-grab touch-none items-center justify-center text-muted-foreground hover:text-foreground touch:min-h-11 touch:min-w-11"
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {seq != null && <span className="text-muted-foreground">#{seq}</span>}
            <span className="truncate font-medium" title={visit.clients?.display_name ?? undefined}>
              {visit.clients?.display_name ?? "-"}
            </span>
          </div>
          {(() => {
            // Street on one line, city and ZIP on the next (#498). One
            // truncated line cut a lane's addresses off after a few words, so
            // stops could not be told apart without opening each one. The
            // street may wrap to two lines whether or not a city line follows,
            // so the clamp never cuts a short street; the city and ZIP stay
            // one truncated line, three lines at most. The whole address is
            // the tooltip.
            const street = p?.street?.trim() || "";
            const cityLine = [p?.city?.trim(), p?.postal_code?.trim()].filter(Boolean).join(" ");
            const full = [street, cityLine].filter(Boolean).join(", ");
            if (!full) return null;
            return (
              <div data-card-address="" className="text-muted-foreground" title={full}>
                {street && <div className="line-clamp-2 break-words">{street}</div>}
                {cityLine && <div className="truncate">{cityLine}</div>}
              </div>
            );
          })()}
          {(visit.eta_start || visit.travel_min != null) && (
            <div className="mt-1 flex flex-wrap items-center gap-2 text-3xs text-muted-foreground">
              {visit.eta_start && <span>ETA {orgLocalTime(visit.eta_start, tz)}</span>}
              {visit.travel_km != null && (
                <span>· {formatDistance(visit.travel_km, distanceUnit)}</span>
              )}
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
            return <div className="mt-0.5 text-3xs text-muted-foreground">Window {label}</div>;
          })()}
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {visit.services?.name && (
              // What the visit is (services, phase 2), as the zone below: one
              // line, ellipsis, full name on hover; the business's own text.
              <Badge
                variant="secondary"
                className="h-4 min-w-0 max-w-full px-1 text-3xs"
                title={visit.services.name}
              >
                <bdi className="truncate">{visit.services.name}</bdi>
              </Badge>
            )}
            {visitStayDates((visit as any).subscriptions?.stays) && (
              // Part of a sitter's stay (#411), with its dates.
              <Badge variant="outline" className="h-4 min-w-0 max-w-full px-1 text-3xs">
                <span className="truncate">
                  Stay, {visitStayDates((visit as any).subscriptions?.stays)}
                </span>
              </Badge>
            )}
            {visit.zones?.name && (
              // `h-4` is a fixed 16px, so a zone name longer than the lane
              // wrapped to three lines inside a one-line pill and printed
              // over the status chip beside it. One line, ellipsis, full
              // name on hover.
              <Badge
                variant="outline"
                className="h-4 min-w-0 max-w-full px-1 text-3xs"
                title={visit.zones.name}
              >
                <span className="truncate">{visit.zones.name}</span>
              </Badge>
            )}
            <StatusChip status={visit.status} className="h-4 px-1 text-3xs" />
            {visit.window_violated && (
              <Badge variant="destructive" className="h-4 px-1 text-3xs">
                Late
              </Badge>
            )}
          </div>
          {/* A skipped stop says why, or that nobody recorded why (QA row
              15: a future stop read "Skipped" and nothing else). */}
          {visit.status === "skipped" && (
            <div className="mt-0.5 break-words text-3xs text-muted-foreground">
              Skip: {skipReasonText(visit.skip_reason, visit.skip_reason_code)}
            </div>
          )}
          {(dirUrl || canComplete) && !dragging && (
            <div className="mt-2 flex flex-wrap gap-1">
              {dirUrl && (
                <a
                  href={dirUrl}
                  target="_blank"
                  rel="noreferrer"
                  // 25px, beside a Complete button that was already 44 on
                  // touch (QA row 23). Same fix: only the box grows.
                  className="inline-flex items-center gap-1 rounded border px-2 py-1 text-2xs hover:bg-muted touch:min-h-11"
                >
                  <Navigation className="h-3 w-3 shrink-0" /> Directions
                </a>
              )}
              {canComplete && (
                <button
                  type="button"
                  onClick={() => onComplete!(visit.id)}
                  disabled={completing}
                  // 25px from `py-1` around a 2xs line. Closing out a visit is
                  // the action this card exists for, and it was the smallest
                  // control on it. The glyph and the type stay put; only the
                  // box a thumb has to find grows.
                  className="inline-flex items-center gap-1 rounded border border-emerald-600/40 bg-emerald-600/10 px-2 py-1 text-2xs text-emerald-700 hover:bg-emerald-600/20 disabled:opacity-50 dark:text-emerald-400 touch:min-h-11"
                >
                  <CheckCircle2 className="h-3 w-3 shrink-0" /> {completing ? "…" : "Complete"}
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
  const tz = useOrgTimezone();
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
            <Badge variant="destructive" className="text-3xs">
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
                      <span className="ml-2">ends {orgLocalTime(t.projectedEnd, tz)}</span>
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
