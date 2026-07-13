import { createFileRoute } from "@tanstack/react-router";
import { AiSection, DispatchPanel } from "@/components/ai/AiPanels";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import {
  balanceOverloadedRoutes,
  getVisitRangeSummary,
  listVisitsForDay,
  generateVisits,
  assignRoute,
  optimizeRoute,
  optimizeWeek,
  reoptimizeAll,
  listStaff,
  reassignVisit,
  reorderRoute,
  getDispatchSettings,
  updateDispatchSettings,
} from "@/lib/visits.functions";
import { backfillPropertyGeocodes } from "@/lib/properties.functions";
import { completeVisit } from "@/lib/my-day.functions";
import { RouteMap, buildTechGroups } from "@/components/RouteMap";
import { VisitDetailDrawer } from "@/components/VisitDetailDrawer";
import { WeatherStrip } from "@/components/WeatherStrip";
import { Navigation, CheckCircle2, MapPin, CloudRain, Settings2 } from "lucide-react";

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

function toLocalISO(d: Date) {
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60_000).toISOString().slice(0, 10);
}
function todayISO() {
  return toLocalISO(new Date());
}

function RoutesPage() {
  const [day, setDay] = useState(todayISO());
  const [through, setThrough] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    return toLocalISO(d);
  });
  const [assignStaffId, setAssignStaffId] = useState<string>("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [localColumns, setLocalColumns] = useState<Record<string, Visit[]> | null>(null);

  const [weekDays, setWeekDays] = useState(7);
  const [viewMode, setViewMode] = useState<"map" | "board">(
    () => (typeof localStorage !== "undefined" && localStorage.getItem("routes.viewMode") === "board" ? "board" : "map"),
  );
  const [range, setRange] = useState<"today" | "week" | "month">(() => {
    if (typeof localStorage === "undefined") return "today";
    const v = localStorage.getItem("routes.range");
    return v === "week" || v === "month" ? v : "today";
  });
  const setViewModePersist = (m: "map" | "board") => {
    setViewMode(m);
    try { localStorage.setItem("routes.viewMode", m); } catch { /* private mode */ }
  };
  const setRangePersist = (r: "today" | "week" | "month") => {
    setRange(r);
    try { localStorage.setItem("routes.range", r); } catch { /* private mode */ }
  };
  // Gear option: tech lanes as vertical columns or full-width horizontal rows.
  const [boardLayout, setBoardLayout] = useState<"columns" | "rows">(
    () => (typeof localStorage !== "undefined" && localStorage.getItem("routes.boardLayout") === "rows" ? "rows" : "columns"),
  );
  const setBoardLayoutPersist = (l: "columns" | "rows") => {
    setBoardLayout(l);
    try { localStorage.setItem("routes.boardLayout", l); } catch { /* private mode */ }
  };
  const [hideWeekends, setHideWeekends] = useState<boolean>(
    () => typeof localStorage !== "undefined" && localStorage.getItem("routes.hideWeekends") === "1",
  );
  const setHideWeekendsPersist = (v: boolean) => {
    setHideWeekends(v);
    try { localStorage.setItem("routes.hideWeekends", v ? "1" : "0"); } catch { /* private mode */ }
  };
  const [toolsOpen, setToolsOpen] = useState(false);
  const [detailVisitId, setDetailVisitId] = useState<string | null>(null);

  const listV = useServerFn(listVisitsForDay);
  const listS = useServerFn(listStaff);
  const gen = useServerFn(generateVisits);
  const assign = useServerFn(assignRoute);
  const optimize = useServerFn(optimizeRoute);
  const optWeek = useServerFn(optimizeWeek);
  const reoptAll = useServerFn(reoptimizeAll);
  const reassign = useServerFn(reassignVisit);

  const reorder = useServerFn(reorderRoute);
  const getSettings = useServerFn(getDispatchSettings);
  const updSettings = useServerFn(updateDispatchSettings);
  const doComplete = useServerFn(completeVisit);
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

  const { data: settingsData } = useQuery({
    queryKey: ["dispatch-settings"],
    queryFn: () => getSettings(),
  });
  const settings = settingsData?.settings ?? {
    workday_start: "08:00",
    workday_end: "17:00",
    avg_speed_kmh: 30,
    traffic_profile: "normal",
  };

  const { data: visitsData } = useQuery({
    queryKey: ["visits", day],
    queryFn: () => listV({ data: { day } }),
  });
  const { data: staffData } = useQuery({ queryKey: ["staff"], queryFn: () => listS() });

  const allStaff = staffData?.staff ?? [];
  // Show every field tech in the board — available techs get regular columns,
  // off-duty ones stay visible as muted "Off routes" lanes so a dispatcher
  // sees at a glance who's not in play today (finding #12). Non-field roles
  // still only appear if they somehow already own a visit.
  const assignedIds = new Set((visitsData?.visits ?? []).map((v: any) => v.assigned_staff_id).filter(Boolean));
  const staff = allStaff
    .filter((s: any) => s.is_field_tech || assignedIds.has(s.id))
    .sort((a: any, b: any) => {
      const av = a.routing_available ? 0 : 1;
      const bv = b.routing_available ? 0 : 1;
      if (av !== bv) return av - bv;
      return (a.display_name ?? "").localeCompare(b.display_name ?? "");
    });
  const visits: Visit[] = visitsData?.visits ?? [];

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

  const genMut = useMutation({
    mutationFn: () => gen({ data: { through } }),
    onSuccess: (r) => {
      toast.success(`Generated ${r.inserted} visits`);
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
  const balanceFn = useServerFn(balanceOverloadedRoutes);
  const balanceMut = useMutation({
    mutationFn: () => balanceFn({ data: { day, apply: true } }),
    onSuccess: (r: any) => {
      const over = (r.loads ?? []).filter((l: any) => l.overCapacity).length;
      if (r.applied > 0) {
        toast.success(`Rebalanced ${r.applied} overflow stop(s) off overloaded routes. Re-optimize to tidy sequences.`);
      } else if (over === 0) {
        toast.success("No overloaded routes — everyone's within capacity.");
      } else {
        toast.warning("Some routes are overloaded but no tech has spare capacity — add a tech or move visits to another day.");
      }
      setLocalColumns(null);
      qc.invalidateQueries({ queryKey: ["visits", day] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const settingsMut = useMutation({

    mutationFn: (patch: any) => updSettings({ data: patch }),
    onSuccess: () => {
      toast.success("Dispatch settings saved");
      qc.invalidateQueries({ queryKey: ["dispatch-settings"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const geocode = useServerFn(backfillPropertyGeocodes);
  const geocodeMut = useMutation({
    mutationFn: () => geocode({ data: { limit: 100 } }),
    onSuccess: (r) => {
      toast.success(`Geocoded ${r.updated} addresses${r.remaining ? ` · ${r.remaining} remaining` : ""}`);
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
            Dispatch, route, map, and mark visits complete — all in one view.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input type="date" value={day} onChange={(e) => { setLocalColumns(null); setDay(e.target.value); }} className="w-[160px]" />
          {/* Two clean axes instead of five mixed buttons: WHAT you look at
              (Map = map + load + board, Board = board only) and WHEN
              (Today / Week / Month). */}
          <div className="inline-flex rounded-md border bg-card p-0.5 text-xs">
            {(["map", "board"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setViewModePersist(m)}
                className={`px-3 py-1.5 rounded ${viewMode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
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
                className={`px-3 py-1.5 rounded ${range === r ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
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
                  <div className="text-[11px] text-muted-foreground">Skip Sat/Sun in Week and Month views.</div>
                </div>
                <Switch checked={hideWeekends} onCheckedChange={setHideWeekendsPersist} />
              </div>
              <div className="space-y-1.5">
                <div className="text-sm font-medium">Board layout</div>
                <div className="text-[11px] text-muted-foreground">How tech lanes are arranged on the board.</div>
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
            {toolsOpen ? "Hide planning tools" : "Planning tools"}
          </Button>

        </div>
      </div>
      <WeatherStrip day={day} />


      {toolsOpen && (
      <div className="grid gap-4 rounded-lg border bg-card p-5 sm:grid-cols-3">

        <div className="space-y-2">
          <Label htmlFor="day">Day</Label>
          <Input id="day" type="date" value={day} onChange={(e) => { setLocalColumns(null); setDay(e.target.value); }} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="through">Generate visits through</Label>
          <div className="flex gap-2">
            <Input id="through" type="date" value={through} onChange={(e) => setThrough(e.target.value)} />
            <Button onClick={() => genMut.mutate()} disabled={genMut.isPending}>
              {genMut.isPending ? "…" : "Generate"}
            </Button>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="tech">Auto-assign / optimize day for tech</Label>
          <div className="flex gap-2">
            <select
              id="tech"
              value={assignStaffId}
              onChange={(e) => setAssignStaffId(e.target.value)}
              className="h-10 flex-1 rounded-md border bg-background px-3 text-sm"
            >
              <option value="">Select…</option>
              {staff.map((s: any) => (
                <option key={s.id} value={s.id}>{s.display_name}</option>
              ))}
            </select>
            <Button onClick={() => assignMut.mutate()} disabled={!assignStaffId || assignMut.isPending} variant="secondary">
              Assign
            </Button>
            <Button onClick={() => optimizeMut.mutate()} disabled={!assignStaffId || optimizeMut.isPending}>
              {optimizeMut.isPending ? "…" : "Optimize"}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Optimize uses nearest-neighbor with time windows + traffic from the tech's start location.
          </p>
        </div>
      </div>
      )}

      {toolsOpen && (
      <div className="grid gap-4 rounded-lg border bg-card p-5 md:grid-cols-2">

        <div className="space-y-2">
          <Label>Optimize multiple days (auto-balance across techs)</Label>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={1}
              max={31}
              value={weekDays}
              onChange={(e) => setWeekDays(Math.max(1, Math.min(31, Number(e.target.value) || 1)))}
              className="w-20"
            />
            <span className="text-sm text-muted-foreground">days starting {day}</span>
            <Button onClick={() => weekMut.mutate()} disabled={weekMut.isPending}>
              {weekMut.isPending ? "…" : "Optimize week"}
            </Button>
            <Button
              variant="secondary"
              onClick={() => reoptMut.mutate()}
              disabled={reoptMut.isPending}
              title="Recompute sequence for every tech using their remaining stops"
            >
              {reoptMut.isPending ? "…" : "Re-optimize today"}
            </Button>
            <Button
              variant="secondary"
              onClick={() => balanceMut.mutate()}
              disabled={balanceMut.isPending}
              title="Move overflow off any tech whose day exceeds working-hours capacity"
            >
              {balanceMut.isPending ? "…" : "Balance overloaded routes"}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Distributes unassigned visits round-robin by zone, then optimizes each tech's day.
          </p>
        </div>
        <div className="md:col-span-2">
          {/* Value-aware dispatch belongs with the other planning tools (punch list #11). */}
          <AiSection title="AI dispatch" description="Suggest value-aware reassignments for a day.">
            <DispatchPanel />
          </AiSection>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-xs">Workday start</Label>
            <Input
              type="time"
              defaultValue={settings.workday_start?.slice(0, 5) ?? "08:00"}
              onBlur={(e) => settingsMut.mutate({ workday_start: e.target.value })}
            />
          </div>
          <div>
            <Label className="text-xs">Workday end</Label>
            <Input
              type="time"
              defaultValue={settings.workday_end?.slice(0, 5) ?? "17:00"}
              onBlur={(e) => settingsMut.mutate({ workday_end: e.target.value })}
            />
          </div>
          <div>
            <Label className="text-xs">Avg speed (km/h)</Label>
            <Input
              type="number"
              min={5}
              max={120}
              defaultValue={settings.avg_speed_kmh ?? 30}
              onBlur={(e) => settingsMut.mutate({ avg_speed_kmh: Number(e.target.value) })}
            />
          </div>
          <div>
            <Label className="text-xs">Traffic profile</Label>
            <select
              defaultValue={settings.traffic_profile ?? "normal"}
              onChange={(e) => settingsMut.mutate({ traffic_profile: e.target.value as any })}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              <option value="light">Light (faster)</option>
              <option value="normal">Normal</option>
              <option value="heavy">Heavy (slower)</option>
            </select>
          </div>
          <div>
            <Label className="text-xs">Max drive to a stop (min)</Label>
            <Input
              type="number"
              min={15}
              max={1440}
              defaultValue={(settings as any).max_drive_minutes ?? 240}
              onBlur={(e) => settingsMut.mutate({ max_drive_minutes: Number(e.target.value) })}
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              Assignments implying a longer drive are flagged as implausible.
            </p>
          </div>
        </div>
      </div>
      )}

      {range !== "today" && (
        <WeekOverview
          day={day}
          initialSpan={range === "month" ? "month" : 7}
          hideWeekends={hideWeekends}
          onPickDay={(d) => { setLocalColumns(null); setDay(d); setRangePersist("today"); }}
        />
      )}

      {range === "today" && viewMode === "map" && (
        <>
          <MapPanel
            visits={visits}
            staff={staff}
            onOpenVisit={setDetailVisitId}
            onGeocode={() => geocodeMut.mutate()}
            geocoding={geocodeMut.isPending}
          />
          <HeatmapPanel visits={visits} staff={staff} />
        </>
      )}

      {range === "today" && (
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        <div className={boardLayout === "rows" ? "grid gap-4 grid-cols-1" : "grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"}>

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
                subtitle={s.role}
                offRoutes={offRoutes}
                items={columns[s.id] ?? []}
                layout={boardLayout}
                onComplete={(id) => completeMut.mutate(id)}
                completingId={completeMut.isPending ? (completeMut.variables as string) : null}
                onOpen={setDetailVisitId}
              />
            );
          })}
        </div>
        <DragOverlay>
          {activeVisit ? <VisitCardView visit={activeVisit} dragging /> : null}
        </DragOverlay>
      </DndContext>
      )}
      <VisitDetailDrawer visitId={detailVisitId} onOpenChange={(o) => !o && setDetailVisitId(null)} />
    </div>

  );
}

function MapPanel({
  visits, staff, onOpenVisit, onGeocode, geocoding,
}: {
  visits: any[]; staff: any[];
  onOpenVisit?: (id: string) => void;
  onGeocode?: () => void;
  geocoding?: boolean;
}) {
  const groups = useMemo(() => buildTechGroups(visits as any, staff as any), [visits, staff]);
  const mappable = visits.filter((v: any) => v.properties?.latitude != null && v.properties?.longitude != null).length;
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
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: g.color }} />
              <span>{g.name}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="relative">
        <RouteMap groups={groups} height={420} onVisitClick={onOpenVisit} />
        {mappable === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-md bg-background/70 text-xs text-muted-foreground">
            <span>No coordinates yet — geocode your properties to plot them.</span>
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
type OverviewSpan = 7 | 28 | "month";

function WeekOverview({ day, onPickDay, initialSpan = 7, hideWeekends = false }: { day: string; onPickDay: (d: string) => void; initialSpan?: OverviewSpan; hideWeekends?: boolean }) {
  const [span, setSpan] = useState<OverviewSpan>(initialSpan);
  const rangeFn = useServerFn(getVisitRangeSummary);
  useEffect(() => { setSpan(initialSpan); }, [initialSpan]);

  const iso = (d: Date) => {
    const off = d.getTimezoneOffset();
    return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
  };
  const base = new Date(`${day}T00:00:00`);
  const days: string[] = [];
  let leadingBlanks = 0;
  if (span === "month") {
    // The selected day's calendar month, grid-aligned to Monday.
    const first = new Date(base.getFullYear(), base.getMonth(), 1);
    const last = new Date(base.getFullYear(), base.getMonth() + 1, 0);
    leadingBlanks = (first.getDay() + 6) % 7; // 0 = Monday
    for (let i = 1; i <= last.getDate(); i++) {
      days.push(iso(new Date(base.getFullYear(), base.getMonth(), i)));
    }
  } else {
    // Start from the Monday of the selected day's week.
    const dow = (base.getDay() + 6) % 7;
    const start = new Date(base);
    start.setDate(base.getDate() - dow);
    for (let i = 0; i < span; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      days.push(iso(d));
    }
  }
  const from = days[0];
  const to = days[days.length - 1];

  const q = useQuery({
    queryKey: ["visit-range", from, to],
    queryFn: () => rangeFn({ data: { from, to } }),
  });
  const byDay = new Map<string, { total: number; completed: number; unassigned: number }>();
  for (const d of (q.data as any)?.days ?? []) byDay.set(d.date, d);
  const maxTotal = Math.max(1, ...days.map((d) => byDay.get(d)?.total ?? 0));
  const todayIso = todayISO();

  const isWeekend = (d: string) => {
    const dow = new Date(`${d}T00:00:00`).getDay();
    return dow === 0 || dow === 6;
  };
  const cols = hideWeekends ? 5 : 7;
  // With weekends hidden, Monday-aligned blanks shrink to weekday-only blanks
  // (Sat/Sun leaders disappear entirely).
  const monthBlanks = span === "month" ? Math.min(leadingBlanks, 5) : 0;
  const visibleDays = hideWeekends ? days.filter((d) => !isWeekend(d)) : days;
  const title =
    span === 7 ? "This week"
    : span === 28 ? "Next 4 weeks"
    : base.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-md border p-0.5 text-xs">
            <button onClick={() => setSpan(7)} className={`px-3 py-1 rounded ${span === 7 ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}>Week</button>
            <button onClick={() => setSpan(28)} className={`px-3 py-1 rounded ${span === 28 ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}>4 weeks</button>
            <button onClick={() => setSpan("month")} className={`px-3 py-1 rounded ${span === "month" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}>Month</button>
          </div>
        </div>
      </div>
      <div className={`grid gap-2 ${cols === 5 ? "grid-cols-5" : "grid-cols-7"}`}>
        {Array.from({ length: monthBlanks }).map((_, i) => (
          <div key={`blank-${i}`} />
        ))}
        {visibleDays.map((d) => {
          const c = byDay.get(d) ?? { total: 0, completed: 0, unassigned: 0 };
          const heat = c.total / maxTotal;
          const dt = new Date(`${d}T00:00:00`);
          return (
            <button
              key={d}
              onClick={() => onPickDay(d)}
              className={`flex flex-col rounded-md border p-2 text-left text-xs transition hover:ring-1 hover:ring-primary ${d === todayIso ? "ring-1 ring-primary" : ""}`}
              style={{ background: c.total ? `rgba(37,99,235,${0.08 + heat * 0.35})` : undefined }}
              title={`${c.total} visits · ${c.completed} completed · ${c.unassigned} unassigned`}
            >
              <span className="text-[10px] uppercase text-muted-foreground">
                {dt.toLocaleDateString(undefined, { weekday: "short" })}
              </span>
              <span className="font-medium">{dt.getDate()}</span>
              <span className="mt-1 text-[11px]">{c.total} visit{c.total === 1 ? "" : "s"}</span>
              {c.unassigned > 0 && (
                <span className="text-[10px] text-amber-700">{c.unassigned} unassigned</span>
              )}
            </button>
          );
        })}
      </div>
      <p className="mt-3 text-[11px] text-muted-foreground">
        Darker = busier. Click a day to open its route board.
      </p>
    </div>
  );
}

function Column({
  id, title, subtitle, items, tone, offRoutes, onComplete, completingId, onOpen, layout = "columns",
}: {
  id: string; title: string; subtitle?: string; items: any[]; tone?: "muted";
  offRoutes?: boolean;
  onComplete?: (visitId: string) => void;
  completingId?: string | null;
  onOpen?: (visitId: string) => void;
  layout?: "columns" | "rows";
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
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
          </div>
          {subtitle && <div className="text-xs text-muted-foreground capitalize">{subtitle}</div>}
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
      <SortableContext items={items.map((v) => v.id)} strategy={layout === "rows" ? rectSortingStrategy : verticalListSortingStrategy}>
        <div className={layout === "rows" ? "flex min-h-[80px] flex-wrap gap-2 p-2 [&>*]:w-72" : "min-h-[80px] space-y-2 p-2"}>
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
  visit, seq, onComplete, completing, onOpen,
}: { visit: Visit; seq: number; onComplete?: (id: string) => void; completing?: boolean; onOpen?: (id: string) => void }) {
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
  visit, seq, dragging, dragHandle, onComplete, completing, onOpen,
}: {
  visit: Visit; seq?: number; dragging?: boolean; dragHandle?: any;
  onComplete?: (id: string) => void; completing?: boolean;
  onOpen?: (id: string) => void;
}) {
  const p = visit.properties;
  const dirUrl = directionsUrl(p);
  const canComplete = onComplete && (visit.status === "scheduled" || visit.status === "in_progress");
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
            <span className="truncate font-medium">{visit.clients?.display_name ?? "—"}</span>
          </div>
          {p && (
            <div className="truncate text-muted-foreground">
              {p.street}, {p.city} {p.postal_code}
            </div>
          )}
          {(visit.eta_start || visit.travel_min != null) && (
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
              {visit.eta_start && (
                <span>ETA {new Date(visit.eta_start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
              )}
              {visit.travel_km != null && <span>· {Number(visit.travel_km).toFixed(1)} km</span>}
              {visit.travel_min != null && <span>· {Math.round(Number(visit.travel_min))} min drive</span>}
            </div>
          )}
          {(() => {
            const s = p?.earliest_service_time?.slice(0, 5);
            const e = p?.latest_service_time?.slice(0, 5);
            if (!s && !e) return null;
            const label = s && e ? `${s}–${e}` : s ? `${s} onward` : `until ${e}`;
            return <div className="mt-0.5 text-[10px] text-muted-foreground">Window {label}</div>;
          })()}
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {visit.zones?.name && <Badge variant="outline" className="h-4 px-1 text-[10px]">{visit.zones.name}</Badge>}
            <Badge variant="secondary" className="h-4 px-1 text-[10px]">{visit.status}</Badge>
            {visit.window_violated && <Badge variant="destructive" className="h-4 px-1 text-[10px]">Late</Badge>}
            {visit.weather_flagged && (
              <Badge
                variant="destructive"
                className="h-4 gap-0.5 px-1 text-[10px]"
                title={visit.weather_note ?? "Weather risk"}
              >
                <CloudRain className="h-2.5 w-2.5" />
                {visit.weather_note ? String(visit.weather_note).split(",")[0] : "Weather"}
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
    const revenue = mine.reduce((sum, v) => sum + (v.subscriptions?.price_cents ?? 0), 0);
    const withEta = mine
      .map((v) => v.eta_end)
      .filter(Boolean)
      .map((s) => new Date(s as string).getTime());
    const projectedEnd = withEta.length ? new Date(Math.max(...withEta)) : null;
    return { staff: s, total: mine.length, done, skipped, inProgress, remaining, late, revenue, projectedEnd };
  });
  const unassigned = visits.filter((v) => !v.assigned_staff_id).length;
  const maxTotal = Math.max(1, ...perTech.map((t) => t.total));

  const zoneMap = new Map<string, number>();
  for (const v of visits) {
    const name = v.zones?.name ?? "No zone";
    zoneMap.set(name, (zoneMap.get(name) ?? 0) + 1);
  }
  const zones = Array.from(zoneMap.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const maxZone = Math.max(1, ...zones.map(([, n]) => n));

  if (staff.length === 0 && visits.length === 0) return null;
  return (
    <div className="grid gap-4 rounded-lg border bg-card p-5 md:grid-cols-2">
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Tech load</h2>
          {unassigned > 0 && (
            <Badge variant="destructive" className="text-[10px]">{unassigned} unassigned</Badge>
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
                    {t.done}/{t.total} · ${(t.revenue / 100).toFixed(0)}
                    {t.late > 0 && <span className="ml-2 text-destructive">{t.late} late</span>}
                    {t.projectedEnd && (
                      <span className="ml-2">
                        ends {t.projectedEnd.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    )}
                  </span>
                </div>
                <div className="mt-1 h-2 w-full overflow-hidden rounded bg-muted">
                  <div
                    className="h-full bg-primary/30"
                    style={{ width: `${pct}%` }}
                  >
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
