import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import {
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
import { completeVisit } from "@/lib/my-day.functions";
import { RouteMap, buildTechGroups } from "@/components/RouteMap";
import { Navigation, CheckCircle2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function RoutesPage() {
  const [day, setDay] = useState(todayISO());
  const [through, setThrough] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    return d.toISOString().slice(0, 10);
  });
  const [assignStaffId, setAssignStaffId] = useState<string>("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [localColumns, setLocalColumns] = useState<Record<string, Visit[]> | null>(null);

  const [weekDays, setWeekDays] = useState(7);

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

  const staff = staffData?.staff ?? [];
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
  const assignMut = useMutation({
    mutationFn: () => assign({ data: { staffId: assignStaffId, day, reassign: false } }),
    onSuccess: (r) => {
      toast.success(`Auto-assigned ${r.assigned} visits`);
      setLocalColumns(null);
      qc.invalidateQueries({ queryKey: ["visits", day] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const optimizeMut = useMutation({
    mutationFn: () => optimize({ data: { staffId: assignStaffId, day, reassign: true } }),
    onSuccess: (r) => {
      toast.success(`Optimized ${r.assigned} stops (nearest-neighbor)`);
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
  const settingsMut = useMutation({

    mutationFn: (patch: any) => updSettings({ data: patch }),
    onSuccess: () => {
      toast.success("Dispatch settings saved");
      qc.invalidateQueries({ queryKey: ["dispatch-settings"] });
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
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Dispatch</h1>
        <p className="text-sm text-muted-foreground">
          Drag visits between techs and reorder within a route. Changes save automatically.
        </p>
      </div>

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
          </div>
          <p className="text-[11px] text-muted-foreground">
            Distributes unassigned visits round-robin by zone, then optimizes each tech's day.
          </p>
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
        </div>
      </div>

      <MapPanel visits={visits} staff={staff} />

      <HeatmapPanel visits={visits} staff={staff} />

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          <Column
            id={UNASSIGNED}
            title="Unassigned"
            items={columns[UNASSIGNED] ?? []}
            tone="muted"
            onComplete={(id) => completeMut.mutate(id)}
            completingId={completeMut.isPending ? (completeMut.variables as string) : null}
          />
          {staff.map((s: any) => (
            <Column
              key={s.id}
              id={s.id}
              title={s.display_name}
              subtitle={s.role}
              items={columns[s.id] ?? []}
              onComplete={(id) => completeMut.mutate(id)}
              completingId={completeMut.isPending ? (completeMut.variables as string) : null}
            />
          ))}
        </div>
        <DragOverlay>
          {activeVisit ? <VisitCardView visit={activeVisit} dragging /> : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

function MapPanel({ visits, staff }: { visits: any[]; staff: any[] }) {
  const groups = useMemo(() => buildTechGroups(visits as any, staff as any), [visits, staff]);
  const mappable = visits.filter((v: any) => v.properties?.latitude != null && v.properties?.longitude != null).length;
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Map</h2>
          <p className="text-[11px] text-muted-foreground">
            {mappable} of {visits.length} visits geocoded. Click a pin to open a popup; use the tech cards below to open directions or mark complete.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {groups.map((g) => (
            <div key={g.staffId ?? "u"} className="flex items-center gap-1 text-[11px]">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: g.color }} />
              <span>{g.name}</span>
            </div>
          ))}
        </div>
      </div>
      {mappable === 0 ? (
        <div className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
          No visits with coordinates on this day. Add latitude/longitude to properties to see the route on the map.
        </div>
      ) : (
        <RouteMap groups={groups} height={420} />
      )}
    </div>
  );
}

function Column({
  id, title, subtitle, items, tone,
}: { id: string; title: string; subtitle?: string; items: Visit[]; tone?: "muted" }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  const totalCents = items.reduce((sum, v) => sum + (v.subscriptions?.price_cents ?? 0), 0);
  return (
    <div
      ref={setNodeRef}
      className={`rounded-lg border ${tone === "muted" ? "bg-muted/30" : "bg-card"} ${
        isOver ? "ring-2 ring-primary" : ""
      }`}
    >
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div>
          <div className="text-sm font-medium">{title}</div>
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
      <SortableContext items={items.map((v) => v.id)} strategy={verticalListSortingStrategy}>
        <div className="min-h-[80px] space-y-2 p-2">
          {items.map((v, i) => (
            <SortableVisitCard key={v.id} visit={v} seq={i + 1} />
          ))}
          {items.length === 0 && (
            <div className="py-6 text-center text-xs text-muted-foreground">Drop visits here</div>
          )}
        </div>
      </SortableContext>
    </div>
  );
}

function SortableVisitCard({ visit, seq }: { visit: Visit; seq: number }) {
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
      <VisitCardView visit={visit} seq={seq} dragHandle={listeners} />
    </div>
  );
}

function VisitCardView({
  visit, seq, dragging, dragHandle,
}: { visit: Visit; seq?: number; dragging?: boolean; dragHandle?: any }) {
  const p = visit.properties;
  return (
    <div className={`rounded-md border bg-background p-2 text-xs shadow-sm ${dragging ? "shadow-lg" : ""}`}>
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
          {(p?.earliest_service_time || p?.latest_service_time) && (
            <div className="mt-0.5 text-[10px] text-muted-foreground">
              Window {p.earliest_service_time?.slice(0, 5) ?? "—"}–{p.latest_service_time?.slice(0, 5) ?? "—"}
            </div>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {visit.zones?.name && <Badge variant="outline" className="h-4 px-1 text-[10px]">{visit.zones.name}</Badge>}
            <Badge variant="secondary" className="h-4 px-1 text-[10px]">{visit.status}</Badge>
            {visit.window_violated && <Badge variant="destructive" className="h-4 px-1 text-[10px]">Late</Badge>}
          </div>
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
