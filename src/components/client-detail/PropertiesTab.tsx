// Properties tab (spec): expandable read-only summaries, boundary displayed
// automatically (no "View Boundary" click), yard size derived from the
// boundary, auto-calculated estimated time with override indicator, zone
// with detected/override badges, dogs per property (deactivate, don't
// delete), commercial-only fields, and Archive / Delete-when-allowed.
import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  Clock,
  DoorClosed,
  Dog as DogIcon,
  MapPin,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BoundaryPreview } from "@/components/BoundaryPreview";
import { formatArea } from "@/components/BoundarySketch";
import {
  listPropertiesForClient,
  setPropertyArchived,
  deletePropertyIfNoHistory,
  setPropertyZoneOverride,
  setPropertyEstimateOverride,
} from "@/lib/properties.functions";
import { listDogsForClient } from "@/lib/clients.functions";
import { addDog, updateDog } from "@/lib/dogs.functions";
import { updatePropertyWindow } from "@/lib/visits.functions";
import { deriveYardSize, YARD_SIZE_LABELS } from "@/lib/yard-size";
import { computeEstimatedMinutes, countPropertyHazards } from "@/lib/estimated-time";
import { EditDrawer, DrawerFooter } from "@/components/client-detail/EditDrawer";
import { PropertyDrawer } from "@/components/client-detail/PropertyDrawer";

const HAZARD_LABELS: Array<[string, string]> = [
  ["do_not_enter_if_dog_out", "Do not enter if dog is out"],
  ["aggressive_dog", "Aggressive dog"],
  ["escape_risk", "Escape risk"],
  ["invisible_fence", "Invisible fence"],
  ["dog_in_yard_during_service", "Dog in yard during service"],
  ["bees_wasps", "Bees / wasps"],
  ["sharp_objects", "Sharp objects"],
  ["slippery_surfaces", "Slippery surfaces"],
];

const TEMPERAMENT_TONE: Record<string, string> = {
  friendly: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  nervous: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  aggressive: "bg-destructive/10 text-destructive",
  unknown: "bg-muted text-muted-foreground",
};

export function PropertiesTab({
  clientId,
  client,
  subscriptions,
  zones,
  canManagePricing,
}: {
  clientId: string;
  client: any;
  subscriptions: any[];
  zones: any[];
  canManagePricing: boolean;
}) {
  const qc = useQueryClient();
  const listPropsFn = useServerFn(listPropertiesForClient);
  const listDogsFn = useServerFn(listDogsForClient);
  const { data: propsData, isLoading } = useQuery({
    queryKey: ["properties", clientId],
    queryFn: () => listPropsFn({ data: { clientId } }),
  });
  const { data: dogsData } = useQuery({
    queryKey: ["client-dogs", clientId],
    queryFn: () => listDogsFn({ data: { clientId } }),
  });

  const properties = propsData?.properties ?? [];
  const activeProps = properties.filter((p: any) => !p.archived_at);
  const archivedProps = properties.filter((p: any) => p.archived_at);
  const dogs = dogsData?.dogs ?? [];

  const [drawerProp, setDrawerProp] = useState<any | null | "new">(null);
  // Small portfolios start fully expanded (boundaries visible immediately);
  // bigger ones start with just the first property open so a 12-property
  // HOA doesn't mount a dozen maps at once.
  const [openIds, setOpenIds] = useState<Set<string> | null>(null);
  const expanded: Set<string> =
    openIds ??
    new Set(
      activeProps.length <= 3
        ? activeProps.map((p: any) => p.id)
        : activeProps.slice(0, 1).map((p: any) => p.id),
    );

  function toggle(id: string) {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpenIds(next);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">
          {activeProps.length} propert{activeProps.length === 1 ? "y" : "ies"}
        </h2>
        <Button size="sm" onClick={() => setDrawerProp("new")}>
          <Plus className="mr-1 h-4 w-4" /> Add property
        </Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : activeProps.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          No properties yet. Add the first one to start scheduling service.
        </div>
      ) : (
        <ul className="space-y-3">
          {activeProps.map((p: any) => (
            <PropertyCard
              key={p.id}
              property={p}
              client={client}
              clientId={clientId}
              dogs={dogs.filter((d: any) => d.property_id === p.id)}
              subscriptions={subscriptions.filter((s: any) => s.property_id === p.id)}
              zones={zones}
              open={expanded.has(p.id)}
              onToggle={() => toggle(p.id)}
              onEdit={() => setDrawerProp(p)}
              canManagePricing={canManagePricing}
            />
          ))}
        </ul>
      )}

      {archivedProps.length > 0 && (
        <details className="rounded-lg border bg-muted/20 p-3 text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            Archived properties ({archivedProps.length})
          </summary>
          <ul className="mt-2 space-y-2">
            {archivedProps.map((p: any) => (
              <ArchivedPropertyRow key={p.id} property={p} clientId={clientId} />
            ))}
          </ul>
        </details>
      )}

      <PropertyDrawer
        open={drawerProp !== null}
        onClose={() => setDrawerProp(null)}
        clientId={clientId}
        client={client}
        property={drawerProp === "new" ? null : drawerProp}
      />
    </div>
  );
}

function ArchivedPropertyRow({ property, clientId }: { property: any; clientId: string }) {
  const qc = useQueryClient();
  const archiveFn = useServerFn(setPropertyArchived);
  const mut = useMutation({
    mutationFn: () => archiveFn({ data: { propertyId: property.id, archived: false } }),
    onSuccess: () => {
      toast.success("Property restored");
      qc.invalidateQueries({ queryKey: ["properties", clientId] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <li className="flex items-center justify-between rounded-md border bg-background p-2">
      <span>
        {property.street}, {property.city}
        <span className="ml-2 text-xs text-muted-foreground">
          archived {new Date(property.archived_at).toLocaleDateString()}
        </span>
      </span>
      <Button size="sm" variant="outline" onClick={() => mut.mutate()} disabled={mut.isPending}>
        <ArchiveRestore className="mr-1 h-3.5 w-3.5" /> Restore
      </Button>
    </li>
  );
}

function PropertyCard({
  property: p,
  client,
  clientId,
  dogs,
  subscriptions,
  zones,
  open,
  onToggle,
  onEdit,
  canManagePricing,
}: {
  property: any;
  client: any;
  clientId: string;
  dogs: any[];
  subscriptions: any[];
  zones: any[];
  open: boolean;
  onToggle: () => void;
  onEdit: () => void;
  canManagePricing: boolean;
}) {
  const qc = useQueryClient();
  const archiveFn = useServerFn(setPropertyArchived);
  const deleteFn = useServerFn(deletePropertyIfNoHistory);
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["properties", clientId] });
    qc.invalidateQueries({ queryKey: ["client-activity", clientId] });
  };

  const archiveMut = useMutation({
    mutationFn: () => archiveFn({ data: { propertyId: p.id, archived: true } }),
    onSuccess: () => {
      toast.success("Property archived");
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const deleteMut = useMutation({
    mutationFn: () => deleteFn({ data: { propertyId: p.id } }),
    onSuccess: () => {
      toast.success("Property deleted");
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const accountType = p.account_type ?? client.account_type ?? "residential";
  const isCommercial = accountType === "commercial";
  const activeDogs = dogs.filter((d: any) => d.active !== false);
  const activeSubs = subscriptions.filter((s: any) => s.status === "active");
  const hazards = HAZARD_LABELS.filter(([k]) => p[k]);

  const zoneName = (id: string | null | undefined) =>
    zones.find((z: any) => z.id === id)?.name ?? null;
  const effectiveZone = zoneName(p.zone_id);
  const detectedZone = zoneName(p.auto_zone_id);
  const overridden = !!p.zone_override_reason;

  const yardCat = deriveYardSize(p.boundary_area_sqm ? Number(p.boundary_area_sqm) : null);

  // Estimated time: computed from the formula; a manual override (with a
  // stored reason) wins and is labeled as such.
  const sub = activeSubs[0];
  const computed = useMemo(
    () =>
      computeEstimatedMinutes({
        boundaryAreaSqm: p.boundary_area_sqm ? Number(p.boundary_area_sqm) : null,
        dogCount: activeDogs.length,
        frequency: sub?.frequency ?? "weekly",
        intervalWeeks: sub?.interval_weeks ?? null,
        intervalDays: sub?.interval_days ?? null,
        hazardCount: countPropertyHazards(p),
      }),
    [p, activeDogs.length, sub],
  );
  const isOverride = !!p.est_override_at;
  const effectiveMinutes = isOverride ? p.service_duration_min : (computed ?? p.service_duration_min);

  return (
    <li className="rounded-lg border bg-card">
      {/* Collapsed summary row */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-medium">
            {p.street}
            {p.unit ? `, ${p.unit}` : ""}, {p.city} {p.postal_code}
          </span>
          <Badge variant={isCommercial ? "default" : "secondary"}>
            {isCommercial ? "Commercial" : "Residential"}
          </Badge>
          {effectiveZone && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <MapPin className="h-3 w-3" />
              {effectiveZone}
              {overridden && (
                <Badge variant="outline" className="ml-0.5 text-[10px]">
                  Override
                </Badge>
              )}
            </span>
          )}
          {effectiveMinutes ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="h-3 w-3" />
              {effectiveMinutes} min
            </span>
          ) : null}
          {activeDogs.length > 0 && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <DogIcon className="h-3 w-3" />
              {activeDogs.length}
            </span>
          )}
          {hazards.length > 0 && (
            <span className="text-xs font-medium text-destructive">
              {hazards.length} hazard{hazards.length > 1 ? "s" : ""}
            </span>
          )}
          {activeSubs.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {activeSubs.length} active service{activeSubs.length > 1 ? "s" : ""}
            </span>
          )}
        </div>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="space-y-4 border-t px-4 py-4">
          {/* Actions */}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={onEdit}>
              <Pencil className="mr-1 h-3.5 w-3.5" /> Edit
            </Button>
            <Link to="/properties/$propertyId/boundary" params={{ propertyId: p.id }}>
              <Button size="sm" variant="outline">
                <MapPin className="mr-1 h-3.5 w-3.5" />
                {p.boundary ? "Edit boundary" : "Draw boundary"}
              </Button>
            </Link>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (window.confirm("Archive this property? It disappears from operational views."))
                  archiveMut.mutate();
              }}
              disabled={archiveMut.isPending}
            >
              <Archive className="mr-1 h-3.5 w-3.5" /> Archive
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => {
                if (window.confirm("Delete this property? Only allowed when it has no history."))
                  deleteMut.mutate();
              }}
              disabled={deleteMut.isPending}
            >
              <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete
            </Button>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {/* Boundary: displayed automatically when present */}
            <div>
              {p.boundary ? (
                <>
                  <BoundaryPreview boundary={p.boundary} areaSqm={p.boundary_area_sqm} height={220} />
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {yardCat && (
                      <span>
                        Yard size: <span className="font-medium text-foreground">{YARD_SIZE_LABELS[yardCat]}</span>{" "}
                        (from boundary)
                      </span>
                    )}
                  </div>
                </>
              ) : (
                <div className="flex h-[220px] flex-col items-center justify-center rounded-md border border-dashed text-center text-sm text-muted-foreground">
                  <span>No boundary drawn yet.</span>
                  <span className="mt-1 text-xs">
                    Yard size and estimated time come from the boundary.
                  </span>
                  <Link
                    to="/properties/$propertyId/boundary"
                    params={{ propertyId: p.id }}
                    className="mt-2 text-primary hover:underline"
                  >
                    Draw it on the map
                  </Link>
                </div>
              )}
            </div>

            <div className="space-y-3 text-sm">
              {/* Zone */}
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Zone
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <span>{effectiveZone ?? "No zone matched"}</span>
                  {overridden ? (
                    <>
                      <Badge variant="outline">Override</Badge>
                      <span className="text-xs text-muted-foreground">
                        detected: {detectedZone ?? "none"} · {p.zone_override_reason}
                      </span>
                    </>
                  ) : (
                    <Badge variant="secondary" className="text-[10px]">
                      Detected automatically
                    </Badge>
                  )}
                  {canManagePricing && (
                    <ZoneOverrideControl property={p} zones={zones} clientId={clientId} />
                  )}
                </div>
              </div>

              {/* Estimated time */}
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Estimated time on site
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <span className="font-medium">
                    {effectiveMinutes ? `${effectiveMinutes} min` : "Not enough data yet"}
                  </span>
                  {isOverride ? (
                    <>
                      <Badge variant="outline">Override</Badge>
                      <span className="text-xs text-muted-foreground">
                        {p.est_override_reason} · auto estimate: {computed ?? "-"} min
                      </span>
                    </>
                  ) : (
                    <Badge variant="secondary" className="text-[10px]">
                      Auto-calculated
                    </Badge>
                  )}
                  {canManagePricing && (
                    <EstimateOverrideControl property={p} clientId={clientId} computed={computed} />
                  )}
                </div>
              </div>

              {/* Access */}
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Access
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-muted-foreground">
                  {p.address_source === "matched" ? (
                    <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:text-blue-400">
                      Address Matched, Not USPS Verified
                    </span>
                  ) : (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium">
                      Address entered manually
                    </span>
                  )}
                  {p.gate_code ? (
                    <span className="inline-flex items-center gap-1">
                      <DoorClosed className="h-3.5 w-3.5" />
                      Gate: <span className="font-medium text-foreground">{p.gate_code}</span>
                    </span>
                  ) : (
                    <span>No gate code</span>
                  )}
                  {(p.visit_contact_name || p.visit_contact_phone || p.visit_contact_email) && (
                    <span>
                      On-site contact:{" "}
                      <span className="text-foreground">
                        {p.visit_contact_name || p.visit_contact_phone || p.visit_contact_email}
                      </span>
                    </span>
                  )}
                </div>
              </div>

              {/* Hazards */}
              {hazards.length > 0 && (
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Hazards
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {hazards.map(([k, label]) => (
                      <span
                        key={k}
                        className="rounded bg-destructive/10 px-1.5 py-0.5 text-[11px] font-medium text-destructive"
                      >
                        {label}
                      </span>
                    ))}
                  </div>
                  {p.hazard_notes && (
                    <p className="mt-1 text-xs text-muted-foreground">{p.hazard_notes}</p>
                  )}
                </div>
              )}

              {/* Commercial-only fields */}
              {isCommercial && (
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Commercial details
                  </div>
                  <div className="mt-1 space-y-0.5 text-muted-foreground">
                    {(p.commercial_sections ?? []).length > 0 && (
                      <div>Sections: {(p.commercial_sections ?? []).join(", ")}</div>
                    )}
                    {(p.building_labels ?? []).length > 0 && (
                      <div>Buildings: {(p.building_labels ?? []).join(", ")}</div>
                    )}
                    {(p.commercial_sections ?? []).length === 0 &&
                      (p.building_labels ?? []).length === 0 && (
                        <div>No sections or buildings recorded. Edit the property to add them.</div>
                      )}
                  </div>
                </div>
              )}
            </div>
          </div>

          <ServiceWindowRow property={p} />

          <DogsSection propertyId={p.id} clientId={clientId} dogs={dogs} />
        </div>
      )}
    </li>
  );
}

// ── Service window (redesigned: earliest / latest / anytime) ───────────────

function ServiceWindowRow({ property }: { property: any }) {
  const upd = useServerFn(updatePropertyWindow);
  const qc = useQueryClient();
  const mut = useMutation({
    mutationFn: (patch: any) => upd({ data: { propertyId: property.id, ...patch } }),
    onSuccess: () => {
      toast.success("Service window saved");
      qc.invalidateQueries({ queryKey: ["properties"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const anytime = !property.earliest_service_time && !property.latest_service_time;

  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Service window
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        When the team may arrive. This is a window, not the actual arrival time.
      </p>
      <div className="mt-2 flex flex-wrap items-end gap-3">
        <div>
          <Label htmlFor={`win-early-${property.id}`} className="text-xs text-muted-foreground">
            Earliest arrival
          </Label>
          <Input
            id={`win-early-${property.id}`}
            type="time"
            className="mt-0.5 h-9 w-32"
            defaultValue={property.earliest_service_time?.slice(0, 5) ?? ""}
            onBlur={(e) => mut.mutate({ earliest_service_time: e.target.value || null })}
          />
        </div>
        <div>
          <Label htmlFor={`win-late-${property.id}`} className="text-xs text-muted-foreground">
            Latest arrival
          </Label>
          <Input
            id={`win-late-${property.id}`}
            type="time"
            className="mt-0.5 h-9 w-32"
            defaultValue={property.latest_service_time?.slice(0, 5) ?? ""}
            onBlur={(e) => mut.mutate({ latest_service_time: e.target.value || null })}
          />
        </div>
        {anytime ? (
          <Badge variant="secondary" className="mb-2">
            Anytime
          </Badge>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="mb-1 text-xs text-muted-foreground"
            onClick={() =>
              mut.mutate({ earliest_service_time: null, latest_service_time: null })
            }
          >
            Clear (anytime)
          </Button>
        )}
      </div>
    </div>
  );
}

// ── Dogs (belong to properties; deactivate instead of delete) ──────────────

function DogsSection({
  propertyId,
  clientId,
  dogs,
}: {
  propertyId: string;
  clientId: string;
  dogs: any[];
}) {
  const qc = useQueryClient();
  const addFn = useServerFn(addDog);
  const updateFn = useServerFn(updateDog);
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["client-dogs", clientId] });
    qc.invalidateQueries({ queryKey: ["properties", clientId] });
  };

  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [breed, setBreed] = useState("");
  const [size, setSize] = useState("");
  const [temperament, setTemperament] = useState<"friendly" | "nervous" | "aggressive" | "unknown">("unknown");
  const [notes, setNotes] = useState("");

  const addMut = useMutation({
    mutationFn: () =>
      addFn({
        data: {
          propertyId,
          name: name.trim(),
          breed: breed || null,
          weightClass: size || null,
          temperament,
          notes: notes || null,
        },
      }),
    onSuccess: () => {
      setAdding(false);
      setName("");
      setBreed("");
      setSize("");
      setNotes("");
      setTemperament("unknown");
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const toggleMut = useMutation({
    mutationFn: (v: { id: string; active: boolean }) => updateFn({ data: v }),
    onSuccess: invalidate,
    onError: (e) => toast.error((e as Error).message),
  });

  const activeDogs = dogs.filter((d) => d.active !== false);
  const inactiveDogs = dogs.filter((d) => d.active === false);

  return (
    <div>
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Dogs ({activeDogs.length})
        </div>
        {!adding && (
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setAdding(true)}>
            <Plus className="mr-1 h-3 w-3" /> Add dog
          </Button>
        )}
      </div>

      <ul className="mt-1.5 space-y-1.5 text-sm">
        {activeDogs.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{d.name}</span>
              {d.breed && <span className="text-xs text-muted-foreground">{d.breed}</span>}
              {d.weight_class && <span className="text-xs text-muted-foreground">{d.weight_class}</span>}
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${TEMPERAMENT_TONE[d.temperament ?? "unknown"]}`}
              >
                {d.temperament ?? "unknown"}
              </span>
              {d.notes && <span className="text-xs text-muted-foreground">{d.notes}</span>}
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs text-muted-foreground"
              onClick={() => toggleMut.mutate({ id: d.id, active: false })}
            >
              Mark inactive
            </Button>
          </li>
        ))}
        {activeDogs.length === 0 && !adding && (
          <li className="rounded-md border border-dashed p-2 text-center text-xs text-muted-foreground">
            No dogs recorded for this property.
          </li>
        )}
      </ul>

      {inactiveDogs.length > 0 && (
        <details className="mt-1.5 text-xs text-muted-foreground">
          <summary className="cursor-pointer">Inactive dogs ({inactiveDogs.length})</summary>
          <ul className="mt-1 space-y-1">
            {inactiveDogs.map((d) => (
              <li key={d.id} className="flex items-center justify-between rounded-md border p-2">
                <span>
                  {d.name}
                  {d.breed ? ` · ${d.breed}` : ""}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 text-xs"
                  onClick={() => toggleMut.mutate({ id: d.id, active: true })}
                >
                  Reactivate
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}

      {adding && (
        <form
          className="mt-2 grid gap-2 rounded-md border bg-muted/20 p-3 sm:grid-cols-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) addMut.mutate();
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
            <Label className="text-xs">Size</Label>
            <select
              value={size}
              onChange={(e) => setSize(e.target.value)}
              className="h-10 w-full rounded-md border bg-background px-2 text-sm"
            >
              <option value="">-</option>
              <option value="small">Small</option>
              <option value="medium">Medium</option>
              <option value="large">Large</option>
              <option value="giant">Giant</option>
            </select>
          </div>
          <div>
            <Label className="text-xs">Temperament</Label>
            <select
              value={temperament}
              onChange={(e) => setTemperament(e.target.value as typeof temperament)}
              className="h-10 w-full rounded-md border bg-background px-2 text-sm"
            >
              <option value="friendly">Friendly</option>
              <option value="nervous">Nervous</option>
              <option value="aggressive">Aggressive</option>
              <option value="unknown">Unknown</option>
            </select>
          </div>
          <div>
            <Label className="text-xs">Notes</Label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <div className="flex gap-2 sm:col-span-5">
            <Button type="submit" size="sm" disabled={addMut.isPending || !name.trim()}>
              {addMut.isPending ? "Adding…" : "Add dog"}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

// ── Zone + estimate override drawers (authorized roles only) ────────────────

function ZoneOverrideControl({
  property,
  zones,
  clientId,
}: {
  property: any;
  zones: any[];
  clientId: string;
}) {
  const qc = useQueryClient();
  const overrideFn = useServerFn(setPropertyZoneOverride);
  const [open, setOpen] = useState(false);
  const [zoneId, setZoneId] = useState(property.zone_id ?? "");
  const [reason, setReason] = useState("");

  const mut = useMutation({
    mutationFn: (v: { zoneId: string | null; reason?: string }) =>
      overrideFn({ data: { propertyId: property.id, ...v } }),
    onSuccess: () => {
      toast.success("Zone updated");
      setOpen(false);
      setReason("");
      qc.invalidateQueries({ queryKey: ["properties", clientId] });
      qc.invalidateQueries({ queryKey: ["client-activity", clientId] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setZoneId(property.zone_id ?? "");
          setOpen(true);
        }}
        className="text-xs text-primary underline underline-offset-2 hover:no-underline"
      >
        Change
      </button>
      <EditDrawer open={open} onClose={() => setOpen(false)} title="Zone override" size="sm" dirty={!!reason}>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Detected zone:{" "}
            <span className="font-medium text-foreground">
              {zones.find((z: any) => z.id === property.auto_zone_id)?.name ?? "none"}
            </span>
          </p>
          <div>
            <Label>Effective zone</Label>
            <select
              value={zoneId}
              onChange={(e) => setZoneId(e.target.value)}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              <option value="">Select a zone…</option>
              {zones.map((z: any) => (
                <option key={z.id} value={z.id}>
                  {z.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label>Reason for override</Label>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. edge of zone, grandfathered pricing"
            />
          </div>
          <DrawerFooter
            onCancel={() => {
              if (reason && !window.confirm("Discard unsaved changes?")) return;
              setOpen(false);
            }}
          >
            {property.zone_override_reason && (
              <Button
                type="button"
                variant="outline"
                onClick={() => mut.mutate({ zoneId: null })}
                disabled={mut.isPending}
              >
                Back to detected
              </Button>
            )}
            <Button
              type="button"
              onClick={() => mut.mutate({ zoneId, reason })}
              disabled={mut.isPending || !zoneId || !reason.trim()}
            >
              Save override
            </Button>
          </DrawerFooter>
        </div>
      </EditDrawer>
    </>
  );
}

function EstimateOverrideControl({
  property,
  clientId,
  computed,
}: {
  property: any;
  clientId: string;
  computed: number | null;
}) {
  const qc = useQueryClient();
  const overrideFn = useServerFn(setPropertyEstimateOverride);
  const [open, setOpen] = useState(false);
  const [minutes, setMinutes] = useState(String(property.service_duration_min ?? ""));
  const [reason, setReason] = useState("");

  const mut = useMutation({
    mutationFn: (v: { minutes: number | null; reason?: string }) =>
      overrideFn({ data: { propertyId: property.id, ...v } }),
    onSuccess: () => {
      toast.success("Estimated time updated");
      setOpen(false);
      setReason("");
      qc.invalidateQueries({ queryKey: ["properties", clientId] });
      qc.invalidateQueries({ queryKey: ["client-activity", clientId] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setMinutes(String(property.service_duration_min ?? computed ?? ""));
          setOpen(true);
        }}
        className="text-xs text-primary underline underline-offset-2 hover:no-underline"
      >
        Override
      </button>
      <EditDrawer
        open={open}
        onClose={() => setOpen(false)}
        title="Estimated time override"
        size="sm"
        dirty={!!reason}
      >
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Auto-calculated estimate:{" "}
            <span className="font-medium text-foreground">
              {computed ? `${computed} min` : "not enough data"}
            </span>
          </p>
          <div>
            <Label>Minutes on site</Label>
            <Input
              type="number"
              min="1"
              max="600"
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
            />
          </div>
          <div>
            <Label>Reason for override</Label>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. steep terrain, double gate walk"
            />
          </div>
          <DrawerFooter
            onCancel={() => {
              if (reason && !window.confirm("Discard unsaved changes?")) return;
              setOpen(false);
            }}
          >
            {property.est_override_at && (
              <Button
                type="button"
                variant="outline"
                onClick={() => mut.mutate({ minutes: null })}
                disabled={mut.isPending}
              >
                Back to auto
              </Button>
            )}
            <Button
              type="button"
              onClick={() => mut.mutate({ minutes: parseInt(minutes, 10), reason })}
              disabled={mut.isPending || !minutes || !reason.trim()}
            >
              Save override
            </Button>
          </DrawerFooter>
        </div>
      </EditDrawer>
    </>
  );
}

// formatArea re-exported so summary rows can show boundary area consistently.
export { formatArea };
