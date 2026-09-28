// Units tab (commercial/HOA only): per-property unit rosters with residents,
// per-unit dogs (PooPrints-style DNA registration status), and offending
// incidents. Incidents can carry a one-off charge which bills through the
// add-on charge RPC so it lands on the client's next invoice.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { AlertTriangle, Building2, ChevronDown, Dna, Dog as DogIcon, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DateField } from "@/components/fields";
import { EmptyState, MetaChip, SectionLabel } from "@/components/client-detail/primitives";
import { EditDrawer, DrawerFooter } from "@/components/client-detail/EditDrawer";
import { formatDay } from "@/lib/format";
import { usePermissions } from "@/hooks/useMyRole";
import { Switch } from "@/components/ui/switch";
import { listDogsForClient } from "@/lib/clients.functions";
import { addDog, updateDog } from "@/lib/dogs.functions";
import { setClientDnaCompliance } from "@/lib/dna.functions";
import {
  listUnitsForClient,
  createUnit,
  updateUnit,
  logUnitIncident,
  INCIDENT_KIND_LABELS,
  type UnitIncidentKind,
} from "@/lib/units.functions";

const DNA_STATUSES = ["not_registered", "pending", "registered"] as const;
type DnaStatus = (typeof DNA_STATUSES)[number];

const DNA_LABELS: Record<DnaStatus, string> = {
  not_registered: "Not registered",
  pending: "DNA pending",
  registered: "DNA registered",
};

const DNA_TONE: Record<DnaStatus, string> = {
  registered: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  pending: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  not_registered: "bg-muted text-muted-foreground",
};

function DnaChip({ status, count }: { status: DnaStatus; count?: number }) {
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${DNA_TONE[status]}`}
    >
      {count != null ? `${count} ` : ""}
      {DNA_LABELS[status].toLowerCase()}
    </span>
  );
}

const KIND_TONE: Record<UnitIncidentKind, string> = {
  waste_violation: "bg-destructive/15 text-destructive",
  dna_match: "bg-destructive/15 text-destructive",
  complaint: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  other: "bg-muted text-muted-foreground",
};

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function UnitsTab({
  clientId,
  client,
  properties,
  canBill,
  onGoToTab,
}: {
  clientId: string;
  client: any;
  properties: any[];
  canBill: boolean;
  onGoToTab?: (tab: string) => void;
}) {
  const qc = useQueryClient();
  const { role } = usePermissions();
  // Mirrors the can_write_org() posture enforced server-side and by RLS.
  const canWrite = role != null && role !== "tech";

  const listUnitsFn = useServerFn(listUnitsForClient);
  const listDogsFn = useServerFn(listDogsForClient);
  const { data: unitsData, isLoading } = useQuery({
    queryKey: ["client-units", clientId],
    queryFn: () => listUnitsFn({ data: { clientId } }),
  });
  const { data: dogsData } = useQuery({
    queryKey: ["client-dogs", clientId],
    queryFn: () => listDogsFn({ data: { clientId } }),
  });

  const commercialProps = useMemo(
    () =>
      properties.filter(
        (p: any) =>
          !p.archived_at && (p.account_type ?? client?.account_type) === "commercial",
      ),
    [properties, client],
  );
  const units: any[] = (unitsData as any)?.units ?? [];
  const incidents: any[] = (unitsData as any)?.incidents ?? [];
  const dogs: any[] = (dogsData as any)?.dogs ?? [];
  // Orphan dogs on unit-bearing properties: they exist in /dna but were never
  // assigned to a unit (I5). Shown here for management review so the Units tab
  // reconciles with /dna instead of silently reading zero (I3).
  const reviewDogs: any[] = (unitsData as any)?.reviewDogs ?? [];

  // "new:<propertyId>" opens the add form scoped to that property.
  const [drawerUnit, setDrawerUnit] = useState<any | string | null>(null);
  const [incidentUnit, setIncidentUnit] = useState<any | null>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["client-units", clientId] });
    qc.invalidateQueries({ queryKey: ["client-dogs", clientId] });
    qc.invalidateQueries({ queryKey: ["client-activity", clientId] });
  };

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;

  // DNA compliance reflection (IA rework): commercial clients only. Same flag
  // the /dna landing list is built from — enabling here surfaces the client in
  // the DNA workspace.
  const dnaCard =
    client?.account_type === "commercial" ? (
      <DnaComplianceCard
        clientId={clientId}
        enabled={!!client?.dna_compliance_enabled}
        canWrite={canWrite}
        onChanged={() => {
          qc.invalidateQueries({ queryKey: ["client", clientId] });
          qc.invalidateQueries({ queryKey: ["dna-compliance-clients"] });
          qc.invalidateQueries({ queryKey: ["client-activity", clientId] });
        }}
      />
    ) : null;

  if (commercialProps.length === 0) {
    return (
      <div className="space-y-6">
        {dnaCard}
        <EmptyState
          icon={Building2}
          title="No commercial properties"
          description="Units live on commercial properties. Mark a property as commercial to manage its units here."
          actionLabel={onGoToTab ? "Go to Properties" : undefined}
          onAction={onGoToTab ? () => onGoToTab("properties") : undefined}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {dnaCard}
      {commercialProps.map((p: any) => {
        const propUnits = units.filter((u) => u.property_id === p.id);
        const propReviewDogs = reviewDogs.filter((d) => d.property_id === p.id);
        return (
          <section key={p.id} className="space-y-2">
            <div className="flex items-center justify-between">
              <SectionLabel>
                {p.street}, {p.city} · {propUnits.length} unit{propUnits.length === 1 ? "" : "s"}
              </SectionLabel>
              {canWrite && (
                <Button size="sm" onClick={() => setDrawerUnit(`new:${p.id}`)}>
                  <Plus className="mr-1 h-4 w-4 shrink-0" /> Add unit
                </Button>
              )}
            </div>

            {propReviewDogs.length > 0 && (
              <ReviewDogsCard
                dogs={propReviewDogs}
                units={propUnits}
                canWrite={canWrite}
                onChanged={invalidate}
              />
            )}

            {propUnits.length === 0 ? (
              <EmptyState
                compact
                icon={Building2}
                title="No units yet"
                description="Add units to track residents, their dogs' DNA registration, and incidents."
                actionLabel={canWrite ? "Add unit" : undefined}
                onAction={canWrite ? () => setDrawerUnit(`new:${p.id}`) : undefined}
              />
            ) : (
              <ul className="space-y-2">
                {propUnits.map((u) => (
                  <UnitCard
                    key={u.id}
                    unit={u}
                    clientId={clientId}
                    dogs={dogs.filter((d) => d.unit_id === u.id)}
                    incidents={incidents.filter((i) => i.unit_id === u.id)}
                    canWrite={canWrite}
                    onEdit={() => setDrawerUnit(u)}
                    onLogIncident={() => setIncidentUnit(u)}
                    onChanged={invalidate}
                  />
                ))}
              </ul>
            )}
          </section>
        );
      })}

      <UnitDrawer
        open={drawerUnit !== null}
        onClose={() => setDrawerUnit(null)}
        unit={typeof drawerUnit === "string" ? null : drawerUnit}
        propertyId={
          typeof drawerUnit === "string" ? drawerUnit.slice("new:".length) : drawerUnit?.property_id
        }
        onSaved={invalidate}
      />

      <IncidentDrawer
        unit={incidentUnit}
        onClose={() => setIncidentUnit(null)}
        unitDogs={incidentUnit ? dogs.filter((d) => d.unit_id === incidentUnit.id) : []}
        canBill={canBill}
        onSaved={() => {
          invalidate();
          qc.invalidateQueries({ queryKey: ["client-addons", clientId] });
          qc.invalidateQueries({ queryKey: ["billing-summary", clientId] });
        }}
      />
    </div>
  );
}

// ── DNA compliance chip / toggle (IA rework) ─────────────────────────────────

function DnaComplianceCard({
  clientId,
  enabled,
  canWrite,
  onChanged,
}: {
  clientId: string;
  enabled: boolean;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const setFn = useServerFn(setClientDnaCompliance);
  const mut = useMutation({
    mutationFn: (next: boolean) => setFn({ data: { clientId, enabled: next } }),
    onSuccess: (_r, next) => {
      toast.success(next ? "DNA compliance enabled" : "DNA compliance disabled");
      onChanged();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-3 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Dna className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="text-sm font-medium">DNA compliance</span>
        <span
          className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${
            enabled
              ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
              : "bg-muted text-muted-foreground"
          }`}
        >
          {enabled ? "Enabled" : "Not enabled"}
        </span>
        {enabled && (
          <Link
            to="/dna"
            search={{ client: clientId }}
            className="text-xs text-primary underline underline-offset-2"
          >
            Open DNA workspace
          </Link>
        )}
      </div>
      {canWrite && (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          {enabled ? "On" : "Off"}
          <Switch
            checked={enabled}
            disabled={mut.isPending}
            onCheckedChange={(next) => mut.mutate(next)}
            aria-label="Toggle DNA compliance"
          />
        </label>
      )}
    </div>
  );
}

// ── Management review: orphan dogs not assigned to a unit (I5) ────────────────

function ReviewDogsCard({
  dogs,
  units,
  canWrite,
  onChanged,
}: {
  dogs: any[];
  units: any[];
  canWrite: boolean;
  onChanged: () => void;
}) {
  const updateFn = useServerFn(updateDog);
  const assignMut = useMutation({
    mutationFn: (v: { id: string; unitId: string }) =>
      updateFn({ data: { id: v.id, unitId: v.unitId } }),
    onSuccess: onChanged,
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
      <div className="flex items-center gap-2 text-sm font-medium text-amber-800 dark:text-amber-300">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        Needs review: {dogs.length} dog{dogs.length === 1 ? "" : "s"} not assigned to a unit
      </div>
      <p className="mt-1 text-xs text-amber-800/80 dark:text-amber-300/80">
        These dogs appear in DNA compliance but are not linked to a unit. Assign each to a unit so
        incidents and DNA matches attribute correctly.
      </p>
      <ul className="mt-2 space-y-1.5">
        {dogs.map((d) => (
          <li
            key={d.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-card p-2"
          >
            <span className="flex flex-wrap items-center gap-2">
              <DogIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="font-medium">{d.name}</span>
              {d.breed && <span className="text-xs text-muted-foreground">{d.breed}</span>}
              <DnaChip status={(d.dna_status ?? "not_registered") as DnaStatus} />
            </span>
            {canWrite &&
              (units.length > 0 ? (
                <select
                  aria-label={`Assign ${d.name} to a unit`}
                  defaultValue=""
                  disabled={assignMut.isPending}
                  onChange={(e) => e.target.value && assignMut.mutate({ id: d.id, unitId: e.target.value })}
                  className="h-8 rounded-md border bg-background px-2 text-xs"
                >
                  <option value="">Assign to unit…</option>
                  {units.map((u) => (
                    <option key={u.id} value={u.id}>
                      Unit {u.unit_label}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="text-xs text-muted-foreground">Add a unit first</span>
              ))}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Unit row (expandable) ────────────────────────────────────────────────────

function UnitCard({
  unit: u,
  clientId,
  dogs,
  incidents,
  canWrite,
  onEdit,
  onLogIncident,
  onChanged,
}: {
  unit: any;
  clientId: string;
  dogs: any[];
  incidents: any[];
  canWrite: boolean;
  onEdit: () => void;
  onLogIncident: () => void;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const activeDogs = dogs.filter((d) => d.active !== false);
  const dnaCounts = DNA_STATUSES.map(
    (s) =>
      [s, activeDogs.filter((d) => (d.dna_status ?? "not_registered") === s).length] as const,
  ).filter(([, n]) => n > 0);

  return (
    <li className="rounded-lg border bg-card shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-medium">Unit {u.unit_label}</span>
          {u.resident_name && (
            <span className="text-xs text-muted-foreground">{u.resident_name}</span>
          )}
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <DogIcon className="h-3 w-3 shrink-0" />
            {activeDogs.length}
          </span>
          {dnaCounts.map(([s, n]) => (
            <DnaChip key={s} status={s} count={n} />
          ))}
          {u.offending_count > 0 && (
            <span className="inline-flex items-center gap-1 rounded-md bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              {u.offending_count} offense{u.offending_count === 1 ? "" : "s"}
            </span>
          )}
        </div>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="space-y-4 border-t px-4 py-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            {canWrite && (
              <Button size="sm" variant="outline" onClick={onEdit}>
                Edit unit
              </Button>
            )}
            {canWrite && (
              <Button size="sm" variant="outline" onClick={onLogIncident}>
                <AlertTriangle className="mr-1 h-3.5 w-3.5 shrink-0" /> Log incident
              </Button>
            )}
          </div>

          {(u.resident_phone || u.resident_email || u.notes) && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {u.resident_phone && <span>{u.resident_phone}</span>}
              {/* One unbreakable token as a flex item: without `break-all` this
                  row is at least as wide as the resident's address, which sets
                  the width of the unit card. */}
              {u.resident_email && <span className="break-all">{u.resident_email}</span>}
              {u.notes && <span>{u.notes}</span>}
            </div>
          )}

          <UnitDogsSection
            unit={u}
            clientId={clientId}
            dogs={dogs}
            canWrite={canWrite}
            onChanged={onChanged}
          />

          <div>
            <SectionLabel>Incidents ({incidents.length})</SectionLabel>
            {incidents.length === 0 ? (
              <div className="mt-1.5">
                <EmptyState
                  compact
                  icon={AlertTriangle}
                  title="No incidents recorded"
                  description="Waste violations and DNA matches raise the unit's offense count."
                  actionLabel={canWrite ? "Log incident" : undefined}
                  onAction={canWrite ? onLogIncident : undefined}
                />
              </div>
            ) : (
              <ul className="mt-1.5 space-y-1.5">
                {incidents.map((i) => {
                  const dogName = dogs.find((d) => d.id === i.dog_id)?.name;
                  return (
                    <li
                      key={i.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2"
                    >
                      <span className="flex flex-wrap items-center gap-2">
                        <span
                          className={`rounded px-1.5 py-0.5 text-xs font-medium ${KIND_TONE[i.kind as UnitIncidentKind] ?? "bg-muted text-muted-foreground"}`}
                        >
                          {INCIDENT_KIND_LABELS[i.kind as UnitIncidentKind] ?? i.kind}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {formatDay(i.incident_on)}
                        </span>
                        {dogName && <span className="text-xs text-muted-foreground">{dogName}</span>}
                        {i.notes && <span className="text-xs text-muted-foreground">{i.notes}</span>}
                      </span>
                      {i.charged_cents != null && (
                        <MetaChip>Billed ${(i.charged_cents / 100).toFixed(2)}</MetaChip>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

// ── Dogs inside a unit ───────────────────────────────────────────────────────

function UnitDogsSection({
  unit,
  clientId,
  dogs,
  canWrite,
  onChanged,
}: {
  unit: any;
  clientId: string;
  dogs: any[];
  canWrite: boolean;
  onChanged: () => void;
}) {
  const addFn = useServerFn(addDog);
  const updateFn = useServerFn(updateDog);

  const [adding, setAdding] = useState(false);
  const [editingDogId, setEditingDogId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [breed, setBreed] = useState("");
  const [dna, setDna] = useState<DnaStatus>("not_registered");

  const resetForm = () => {
    setAdding(false);
    setEditingDogId(null);
    setName("");
    setBreed("");
    setDna("not_registered");
  };

  const startEdit = (d: any) => {
    setAdding(true);
    setEditingDogId(d.id);
    setName(d.name ?? "");
    setBreed(d.breed ?? "");
    setDna((d.dna_status ?? "not_registered") as DnaStatus);
  };

  const saveMut = useMutation({
    mutationFn: () => {
      const fields = { name: name.trim(), breed: breed || null, dnaStatus: dna };
      const run = editingDogId
        ? updateFn({ data: { id: editingDogId, ...fields } })
        : addFn({ data: { propertyId: unit.property_id, unitId: unit.id, ...fields } });
      return run.then(() => ({ ok: true }));
    },
    onSuccess: () => {
      resetForm();
      onChanged();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const dnaMut = useMutation({
    mutationFn: (v: { id: string; dnaStatus: DnaStatus }) => updateFn({ data: v }),
    onSuccess: onChanged,
    onError: (e) => toast.error((e as Error).message),
  });

  const activeDogs = dogs.filter((d) => d.active !== false);

  return (
    <div>
      <div className="flex items-center justify-between">
        <SectionLabel>Dogs ({activeDogs.length})</SectionLabel>
        {canWrite && !adding && (
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setAdding(true)}>
            <Plus className="mr-1 h-3 w-3 shrink-0" /> Add dog
          </Button>
        )}
      </div>

      <ul className="mt-1.5 space-y-1.5">
        {activeDogs.map((d) => (
          <li
            key={d.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2"
          >
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{d.name}</span>
              {d.breed && <span className="text-xs text-muted-foreground">{d.breed}</span>}
              <DnaChip status={(d.dna_status ?? "not_registered") as DnaStatus} />
            </span>
            {canWrite && (
              <span className="flex items-center gap-1.5">
                <select
                  aria-label={`DNA status for ${d.name}`}
                  value={(d.dna_status ?? "not_registered") as string}
                  onChange={(e) => dnaMut.mutate({ id: d.id, dnaStatus: e.target.value as DnaStatus })}
                  disabled={dnaMut.isPending}
                  className="h-7 rounded-md border bg-background px-1.5 text-xs"
                >
                  {DNA_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {DNA_LABELS[s]}
                    </option>
                  ))}
                </select>
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => startEdit(d)}>
                  Edit
                </Button>
              </span>
            )}
          </li>
        ))}
        {activeDogs.length === 0 && !adding && (
          <li>
            <EmptyState
              compact
              icon={DogIcon}
              title="No dogs registered to this unit"
              description="DNA registration and incident attribution start with a dog record."
              actionLabel={canWrite ? "Add dog" : undefined}
              onAction={canWrite ? () => setAdding(true) : undefined}
            />
          </li>
        )}
      </ul>

      {adding && (
        <form
          className="mt-2 grid gap-2 rounded-md border bg-muted/20 p-3 sm:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) saveMut.mutate();
          }}
        >
          <div>
            <Label className="text-xs">Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div>
            <Label className="text-xs">Breed</Label>
            <Input value={breed} onChange={(e) => setBreed(e.target.value)} />
          </div>
          <div>
            <Label className="text-xs">DNA status</Label>
            <select
              value={dna}
              onChange={(e) => setDna(e.target.value as DnaStatus)}
              className="h-10 w-full rounded-md border bg-background px-2 text-sm"
            >
              {DNA_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {DNA_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-end gap-2">
            <Button type="submit" size="sm" disabled={saveMut.isPending || !name.trim()}>
              {saveMut.isPending ? "Saving…" : editingDogId ? "Save dog" : "Add dog"}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={resetForm}>
              <X className="mr-1 h-3.5 w-3.5 shrink-0" /> Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

// ── Add / edit unit drawer ───────────────────────────────────────────────────

function UnitDrawer({
  open,
  onClose,
  unit,
  propertyId,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  unit: any | null;
  propertyId: string | undefined;
  onSaved: () => void;
}) {
  const createFn = useServerFn(createUnit);
  const updateFn = useServerFn(updateUnit);

  const initial = useMemo(
    () => ({
      unitLabel: unit?.unit_label ?? "",
      residentName: unit?.resident_name ?? "",
      residentPhone: unit?.resident_phone ?? "",
      residentEmail: unit?.resident_email ?? "",
      notes: unit?.notes ?? "",
    }),
    [unit],
  );
  const [form, setForm] = useState(initial);
  const [wasOpen, setWasOpen] = useState(false);
  if (open && !wasOpen) {
    setForm(initial);
    setWasOpen(true);
  } else if (!open && wasOpen) {
    setWasOpen(false);
  }
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const saveMut = useMutation({
    mutationFn: () => {
      const fields = {
        unitLabel: form.unitLabel.trim(),
        residentName: form.residentName || null,
        residentPhone: form.residentPhone || null,
        residentEmail: form.residentEmail || null,
        notes: form.notes || null,
      };
      const run = unit
        ? updateFn({ data: { id: unit.id, ...fields } })
        : createFn({ data: { propertyId: propertyId!, ...fields } });
      return run.then(() => ({ ok: true }));
    },
    onSuccess: () => {
      toast.success(unit ? "Unit saved" : "Unit added");
      onSaved();
      onClose();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <EditDrawer
      open={open}
      onClose={onClose}
      title={unit ? `Edit unit ${unit.unit_label}` : "Add unit"}
      description="A unit is one residence in the community: its label, resident, and contact details."
      size="sm"
      dirty={dirty}
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (form.unitLabel.trim()) saveMut.mutate();
        }}
      >
        <div>
          <Label htmlFor="unit-label">Unit label</Label>
          <Input
            id="unit-label"
            value={form.unitLabel}
            onChange={(e) => set("unitLabel", e.target.value)}
            placeholder="101, B-12, Cottage 3…"
            required
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="unit-resident">Resident name</Label>
            <Input
              id="unit-resident"
              value={form.residentName}
              onChange={(e) => set("residentName", e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="unit-phone">Resident phone</Label>
            <Input
              id="unit-phone"
              value={form.residentPhone}
              onChange={(e) => set("residentPhone", e.target.value)}
            />
          </div>
        </div>
        <div>
          <Label htmlFor="unit-email">Resident email</Label>
          <Input
            id="unit-email"
            type="email"
            value={form.residentEmail}
            onChange={(e) => set("residentEmail", e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="unit-notes">Notes</Label>
          <Textarea
            id="unit-notes"
            rows={3}
            value={form.notes}
            onChange={(e) => set("notes", e.target.value)}
          />
        </div>
        <DrawerFooter>
          <Button type="submit" disabled={saveMut.isPending || !form.unitLabel.trim()}>
            {saveMut.isPending ? "Saving…" : unit ? "Save unit" : "Add unit"}
          </Button>
        </DrawerFooter>
      </form>
    </EditDrawer>
  );
}

// ── Log incident drawer ──────────────────────────────────────────────────────

function IncidentDrawer({
  unit,
  onClose,
  unitDogs,
  canBill,
  onSaved,
}: {
  unit: any | null;
  onClose: () => void;
  unitDogs: any[];
  canBill: boolean;
  onSaved: () => void;
}) {
  const logFn = useServerFn(logUnitIncident);
  const [kind, setKind] = useState<UnitIncidentKind>("waste_violation");
  const [incidentOn, setIncidentOn] = useState(todayISO());
  const [dogId, setDogId] = useState("");
  const [notes, setNotes] = useState("");
  const [charge, setCharge] = useState("");

  const [wasOpen, setWasOpen] = useState(false);
  if (unit && !wasOpen) {
    setKind("waste_violation");
    setIncidentOn(todayISO());
    setDogId("");
    setNotes("");
    setCharge("");
    setWasOpen(true);
  } else if (!unit && wasOpen) {
    setWasOpen(false);
  }

  const chargeCents = charge.trim() === "" ? null : Math.round((parseFloat(charge) || 0) * 100);

  const mut = useMutation({
    mutationFn: () =>
      logFn({
        data: {
          unitId: unit.id,
          kind,
          incidentOn,
          dogId: dogId || null,
          notes: notes.trim() || null,
          chargedCents: chargeCents && chargeCents > 0 ? chargeCents : null,
        },
      }),
    onSuccess: () => {
      toast.success(
        chargeCents && chargeCents > 0
          ? "Incident logged and charge added to the next invoice"
          : "Incident logged",
      );
      onSaved();
      onClose();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const raisesCount = kind === "waste_violation" || kind === "dna_match";

  return (
    <EditDrawer
      open={!!unit}
      onClose={onClose}
      title={unit ? `Log incident for unit ${unit.unit_label}` : "Log incident"}
      description="Waste violations and DNA matches raise the unit's offense count."
      size="sm"
      dirty={!!notes || !!charge || !!dogId}
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          mut.mutate();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="inc-kind">Kind</Label>
            <select
              id="inc-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as UnitIncidentKind)}
              className="h-10 w-full rounded-md border bg-background px-2 text-sm"
            >
              {(Object.keys(INCIDENT_KIND_LABELS) as UnitIncidentKind[]).map((k) => (
                <option key={k} value={k}>
                  {INCIDENT_KIND_LABELS[k]}
                </option>
              ))}
            </select>
            {raisesCount && (
              <p className="mt-1 text-xs text-muted-foreground">
                Adds 1 to this unit's offense count.
              </p>
            )}
          </div>
          <DateField label="Date" value={incidentOn} onChange={setIncidentOn} />
        </div>
        <div>
          <Label htmlFor="inc-dog">Dog (optional)</Label>
          <select
            id="inc-dog"
            value={dogId}
            onChange={(e) => setDogId(e.target.value)}
            className="h-10 w-full rounded-md border bg-background px-2 text-sm"
          >
            <option value="">Unknown / not attributed</option>
            {unitDogs
              .filter((d) => d.active !== false)
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
          </select>
        </div>
        <div>
          <Label htmlFor="inc-notes">Notes</Label>
          <Textarea id="inc-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        {canBill ? (
          <div>
            <Label htmlFor="inc-charge">Charge the client ($, optional)</Label>
            <Input
              id="inc-charge"
              type="number"
              min="0"
              step="0.01"
              className="w-40"
              value={charge}
              onChange={(e) => setCharge(e.target.value)}
              placeholder="0.00"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Bills as a one-off charge ("Unit {unit?.unit_label}:{" "}
              {INCIDENT_KIND_LABELS[kind].toLowerCase()}") on the client's next invoice.
            </p>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Billing an incident charge requires client billing permissions.
          </p>
        )}
        <DrawerFooter>
          <Button type="submit" disabled={mut.isPending}>
            {mut.isPending ? "Logging…" : "Log incident"}
          </Button>
        </DrawerFooter>
      </form>
    </EditDrawer>
  );
}
