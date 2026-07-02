import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import {
  listVisitsForDay,
  generateVisits,
  assignRoute,
  optimizeRoute,
  listStaff,
  reassignVisit,
  reorderRoute,
} from "@/lib/visits.functions";
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

  const listV = useServerFn(listVisitsForDay);
  const listS = useServerFn(listStaff);
  const gen = useServerFn(generateVisits);
  const assign = useServerFn(assignRoute);
  const optimize = useServerFn(optimizeRoute);
  const reassign = useServerFn(reassignVisit);
  const reorder = useServerFn(reorderRoute);
  const qc = useQueryClient();

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
            Optimize uses nearest-neighbor from the tech's start location (Settings → Team).
          </p>
        </div>
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          <Column id={UNASSIGNED} title="Unassigned" items={columns[UNASSIGNED] ?? []} tone="muted" />
          {staff.map((s: any) => (
            <Column key={s.id} id={s.id} title={s.display_name} subtitle={s.role} items={columns[s.id] ?? []} />
          ))}
        </div>
        <DragOverlay>
          {activeVisit ? <VisitCardView visit={activeVisit} dragging /> : null}
        </DragOverlay>
      </DndContext>
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
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {visit.zones?.name && <Badge variant="outline" className="h-4 px-1 text-[10px]">{visit.zones.name}</Badge>}
            <Badge variant="secondary" className="h-4 px-1 text-[10px]">{visit.status}</Badge>
          </div>
        </div>
      </div>
    </div>
  );
}
