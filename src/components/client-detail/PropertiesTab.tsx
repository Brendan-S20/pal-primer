// Properties tab (spec): expandable read-only summaries, boundary displayed
// automatically (no "View Boundary" click), yard size derived from the
// boundary, auto-calculated estimated time with override indicator, zone
// with detected/override badges, dogs per property (deactivate, don't
// delete), commercial-only fields, and Archive / Delete-when-allowed.
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  Clock,
  DoorClosed,
  Dog as DogIcon,
  Home,
  KeyRound,
  MapPin,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Navigation } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState, MetaChip, SectionLabel } from "@/components/client-detail/primitives";
import { formatDay } from "@/lib/format";
import { BoundaryPreview } from "@/components/BoundaryPreview";
import { formatArea } from "@/components/BoundarySketch";
import {
  listPropertiesForClient,
  setPropertyArchived,
  deletePropertyIfNoHistory,
} from "@/lib/properties.functions";
import { listDogsForClient } from "@/lib/clients.functions";
import { addDog, updateDog } from "@/lib/dogs.functions";
import { deriveYardSize, YARD_SIZE_LABELS } from "@/lib/yard-size";
import { computeEstimatedMinutes, countPropertyHazards } from "@/lib/estimated-time";
import { PropertyDrawer } from "@/components/client-detail/PropertyDrawer";
import { ACCESS_METHOD_LABEL, isAccessMethod } from "@/lib/walk-access";
import { useConfirmDialog } from "@/components/ConfirmDialog";

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

export const COMMON_BREEDS = [
  "Mixed breed",
  "Labrador Retriever",
  "Golden Retriever",
  "German Shepherd",
  "French Bulldog",
  "Bulldog",
  "Poodle",
  "Goldendoodle",
  "Labradoodle",
  "Beagle",
  "Rottweiler",
  "German Shorthaired Pointer",
  "Dachshund",
  "Pembroke Welsh Corgi",
  "Australian Shepherd",
  "Yorkshire Terrier",
  "Boxer",
  "Great Dane",
  "Siberian Husky",
  "Cavalier King Charles Spaniel",
  "Doberman Pinscher",
  "Miniature Schnauzer",
  "Shih Tzu",
  "Boston Terrier",
  "Bernese Mountain Dog",
  "Pomeranian",
  "Havanese",
  "Chihuahua",
  "Border Collie",
  "Pit Bull / Am. Staffordshire",
  "Cane Corso",
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
  visits,
  canManagePricing,
  onGoToTab,
  editPropertyId,
  onEditPropertyConsumed,
}: {
  clientId: string;
  client: any;
  subscriptions: any[];
  zones: any[];
  visits: any[];
  canManagePricing: boolean;
  /** Tab navigation for cross-tab pointers (commercial dogs live on Units). */
  onGoToTab?: (tab: string) => void;
  /** Deep-linked ?editProperty=<id> (already stripped from the URL by the
   * route): opens the PropertyDrawer for that property once its data is in. */
  editPropertyId?: string | null;
  onEditPropertyConsumed?: () => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
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

  // Keep the ID, derive the object from fresh query data: the editor's
  // inline sections (boundary, overrides) must not render a stale snapshot
  // after their own saves invalidate the list.
  const [drawerProp, setDrawerProp] = useState<string | null | "new">(null);
  const drawerProperty =
    drawerProp && drawerProp !== "new"
      ? (properties.find((x: any) => x.id === drawerProp) ?? null)
      : null;

  // Consume the ?editProperty deep link once the property list actually
  // contains the id (opening earlier would render the drawer in "new" mode
  // against a null property). An unknown id is simply never consumed.
  useEffect(() => {
    if (!editPropertyId) return;
    if (properties.some((p: any) => p.id === editPropertyId)) {
      setDrawerProp(editPropertyId);
      onEditPropertyConsumed?.();
    }
  }, [editPropertyId, properties]); // eslint-disable-line react-hooks/exhaustive-deps

  // The list's Edit affordances go through the URL (?editProperty=<id>, the
  // ?edit=true pattern) so an edit is deep-linkable/shareable; the route
  // strips the param and hands it back via editPropertyId.
  const openEditViaUrl = (propertyId: string) =>
    navigate({
      to: "/clients/$clientId",
      params: { clientId },
      search: { tab: "properties", editProperty: propertyId } as any,
    });
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
          <Plus className="mr-1 h-4 w-4 shrink-0" /> Add property
        </Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : activeProps.length === 0 ? (
        <EmptyState
          icon={Home}
          title="No properties yet"
          description="Add the first one to start scheduling service."
          actionLabel="Add property"
          onAction={() => setDrawerProp("new")}
        />
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
              visitCount={visits.filter((v: any) => v.property_id === p.id).length}
              zones={zones}
              open={expanded.has(p.id)}
              onToggle={() => toggle(p.id)}
              onEdit={() => openEditViaUrl(p.id)}
              canManagePricing={canManagePricing}
              onGoToTab={onGoToTab}
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
        property={drawerProp === "new" ? null : drawerProperty}
        zones={zones}
        canManagePricing={canManagePricing}
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
          archived {formatDay(property.archived_at)}
        </span>
      </span>
      <Button size="sm" variant="outline" onClick={() => mut.mutate()} disabled={mut.isPending}>
        <ArchiveRestore className="mr-1 h-3.5 w-3.5 shrink-0" /> Restore
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
  visitCount,
  zones,
  open,
  onToggle,
  onEdit,
  canManagePricing,
  onGoToTab,
}: {
  property: any;
  client: any;
  clientId: string;
  dogs: any[];
  subscriptions: any[];
  visitCount: number;
  zones: any[];
  open: boolean;
  onToggle: () => void;
  onEdit: () => void;
  canManagePricing: boolean;
  onGoToTab?: (tab: string) => void;
}) {
  const qc = useQueryClient();
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
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
    <li className="rounded-lg border bg-card shadow-sm">
      {confirmDialog}
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
          <MetaChip>{isCommercial ? "Commercial" : "Residential"}</MetaChip>
          {effectiveZone && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <MapPin className="h-3 w-3 shrink-0" />
              {effectiveZone}
              {overridden && <MetaChip className="ml-0.5">Override</MetaChip>}
            </span>
          )}
          {effectiveMinutes ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="h-3 w-3 shrink-0" />
              {effectiveMinutes} min
            </span>
          ) : null}
          {activeDogs.length > 0 && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <DogIcon className="h-3 w-3 shrink-0" />
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
              <Pencil className="mr-1 h-3.5 w-3.5 shrink-0" /> Edit
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                // Directions to the pin when we have one, else the address.
                const dest =
                  p.latitude != null && p.longitude != null
                    ? `${p.latitude},${p.longitude}`
                    : encodeURIComponent(`${p.street}, ${p.city} ${p.postal_code}`);
                window.open(
                  `https://www.google.com/maps/dir/?api=1&destination=${dest}`,
                  "_blank",
                  "noopener",
                );
              }}
            >
              <Navigation className="mr-1 h-3.5 w-3.5" /> Navigate
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="h-10 w-10 p-0" aria-label="More actions">
                  <MoreHorizontal className="h-4 w-4 shrink-0" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  disabled={archiveMut.isPending}
                  onSelect={async () => {
                    if (
                      await confirm({
                        title: "Archive this property?",
                        description:
                          "It disappears from schedules and operational views. Its history is kept, and you can restore it anytime.",
                        confirmLabel: "Archive property",
                      })
                    )
                      archiveMut.mutate();
                  }}
                >
                  <Archive className="mr-2 h-3.5 w-3.5 shrink-0" /> Archive property…
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  disabled={deleteMut.isPending}
                  onSelect={async () => {
                    const hasHistory = visitCount > 0 || subscriptions.length > 0;
                    if (hasHistory) {
                      // PRD rule: history means archive, never delete. The modal
                      // says which action applies, why, and what depends on it.
                      const activeCount = subscriptions.filter(
                        (x: any) => x.status === "active",
                      ).length;
                      if (
                        await confirm({
                          title: "This property has history",
                          description: (
                            <>
                              <p>
                                {p.street} is referenced by {visitCount} visit
                                {visitCount === 1 ? "" : "s"} and {subscriptions.length} service
                                {subscriptions.length === 1 ? "" : "s"}
                                {activeCount > 0 ? ` (${activeCount} active)` : ""}, so it can't be
                                deleted. Archiving keeps that history and removes the property from
                                operational views.
                              </p>
                            </>
                          ),
                          confirmLabel: "Archive instead",
                        })
                      )
                        archiveMut.mutate();
                      return;
                    }
                    if (
                      await confirm({
                        title: "Delete this property?",
                        description: `${p.street} has no visits, services, or invoices. Deleting removes it and its dog records permanently.`,
                        confirmLabel: "Delete property",
                        destructive: true,
                      })
                    )
                      deleteMut.mutate();
                  }}
                >
                  <Trash2 className="mr-2 h-3.5 w-3.5 shrink-0" /> Delete property…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {/* Boundary: displayed automatically when present */}
            <div>
              {p.boundary ? (
                <>
                  <BoundaryPreview
                    boundary={p.boundary}
                    areaSqm={p.boundary_area_sqm}
                    height={220}
                    title={p.street}
                  />
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
                  {/* The only way out of the empty state, and it was a 20px
                      line of text -- half Apple's floor. `touch:` rather than
                      `max-md:` because an iPad is 744px+ and all thumb. */}
                  <button
                    type="button"
                    onClick={onEdit}
                    className="mt-2 inline-flex items-center justify-center rounded-md px-3 text-primary hover:underline touch:min-h-11"
                  >
                    Draw it in the editor
                  </button>
                </div>
              )}
            </div>

            <div className="space-y-3 text-sm">
              {/* Zone */}
              <div>
                <SectionLabel>Zone</SectionLabel>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <span>{effectiveZone ?? "No zone matched"}</span>
                  {overridden ? (
                    <>
                      <MetaChip>Override</MetaChip>
                      <span className="text-xs text-muted-foreground">
                        detected: {detectedZone ?? "none"} · {p.zone_override_reason}
                      </span>
                    </>
                  ) : (
                    <MetaChip>Detected automatically</MetaChip>
                  )}

                </div>
              </div>

              {/* Estimated time */}
              <div>
                <SectionLabel>Estimated time on site</SectionLabel>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <span className="font-medium">
                    {effectiveMinutes ? `${effectiveMinutes} min` : "Not enough data yet"}
                  </span>
                  {isOverride ? (
                    <>
                      <MetaChip>Override</MetaChip>
                      <span className="text-xs text-muted-foreground">
                        {p.est_override_reason} · auto estimate: {computed ?? "-"} min
                      </span>
                    </>
                  ) : (
                    <MetaChip>Auto-calculated</MetaChip>
                  )}

                </div>
              </div>

              {/* Access */}
              <div>
                <SectionLabel>Access</SectionLabel>
                <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-muted-foreground">
                  <MetaChip>
                    {p.address_source === "matched"
                      ? "Address Matched, Not USPS Verified"
                      : "Address entered manually"}
                  </MetaChip>
                  {p.gate_code ? (
                    <span className="inline-flex items-center gap-1">
                      <DoorClosed className="h-3.5 w-3.5 shrink-0" />
                      Gate: <span className="font-medium text-foreground">{p.gate_code}</span>
                    </span>
                  ) : (
                    <span>No gate code</span>
                  )}
                  {isAccessMethod(p.access_method) && (
                    <span>
                      Way in:{" "}
                      <span className="text-foreground">{ACCESS_METHOD_LABEL[p.access_method]}</span>
                    </span>
                  )}
                  {p.key_held && (
                    <span className="inline-flex min-w-0 items-center gap-1">
                      <KeyRound className="h-3.5 w-3.5 shrink-0" />
                      <span className="min-w-0 truncate">
                        We hold a key
                        {p.key_tag ? (
                          <>
                            , tag <span className="font-medium text-foreground">{p.key_tag}</span>
                          </>
                        ) : null}
                      </span>
                    </span>
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
                  <SectionLabel>Hazards</SectionLabel>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {hazards.map(([k, label]) => (
                      <span
                        key={k}
                        className="rounded bg-destructive/10 px-1.5 py-0.5 text-xs font-medium text-destructive"
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
                  <SectionLabel>Commercial details</SectionLabel>
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

          {isCommercial ? (
            // Commercial dogs belong to units (PooPrints model) — manage them
            // on the Units tab, not here.
            <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
              <DogIcon className="h-4 w-4 shrink-0" />
              <span>Dogs are managed per unit on the Units tab.</span>
              {onGoToTab && (
                <button
                  type="button"
                  className="text-primary hover:underline"
                  onClick={() => onGoToTab("units")}
                >
                  Go to Units
                </button>
              )}
            </div>
          ) : (
            <DogsSection
              propertyId={p.id}
              clientId={clientId}
              dogs={dogs}
              billedDogCounts={activeSubs
                .filter((x: any) => x.account_type === "residential" && x.dog_count != null)
                .map((x: any) => x.dog_count as number)}
            />
          )}
        </div>
      )}
    </li>
  );
}

// ── Dogs (belong to properties; deactivate instead of delete) ──────────────

function DogsSection({
  propertyId,
  clientId,
  dogs,
  billedDogCounts = [],
}: {
  propertyId: string;
  clientId: string;
  dogs: any[];
  billedDogCounts?: number[];
}) {
  const qc = useQueryClient();
  const addFn = useServerFn(addDog);
  const updateFn = useServerFn(updateDog);
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["client-dogs", clientId] });
    qc.invalidateQueries({ queryKey: ["properties", clientId] });
  };

  // One form, two modes: adding a new dog or editing an existing one (UX
  // round 4: dogs must be editable right here, not just add/deactivate).
  const [adding, setAdding] = useState(false);
  const [editingDogId, setEditingDogId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [breed, setBreed] = useState("");
  const [breedChoice, setBreedChoice] = useState("");
  const [size, setSize] = useState("");
  const [temperament, setTemperament] = useState<"friendly" | "nervous" | "aggressive" | "unknown">("unknown");
  const [notes, setNotes] = useState("");

  const resetForm = () => {
    setAdding(false);
    setEditingDogId(null);
    setName("");
    setBreed("");
    setBreedChoice("");
    setSize("");
    setNotes("");
    setTemperament("unknown");
  };

  const startEdit = (d: any) => {
    setEditingDogId(d.id);
    setAdding(true);
    setName(d.name ?? "");
    const knownBreed = d.breed && COMMON_BREEDS.includes(d.breed);
    setBreed(d.breed ?? "");
    setBreedChoice(d.breed ? (knownBreed ? d.breed : "__other") : "");
    setSize(d.weight_class ?? "");
    setTemperament((d.temperament ?? "unknown") as typeof temperament);
    setNotes(d.notes ?? "");
  };

  const addMut = useMutation({
    mutationFn: () => {
      const fields = {
        name: name.trim(),
        breed: breed || null,
        weightClass: size || null,
        temperament,
        notes: notes || null,
      };
      const run = editingDogId
        ? updateFn({ data: { id: editingDogId, ...fields } })
        : addFn({ data: { propertyId, ...fields } });
      return run.then(() => ({ ok: true }));
    },
    onSuccess: () => {
      resetForm();
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
  // QA follow-up 1.5: services billing for a different dog count than the
  // property's records is a data-quality problem worth surfacing.
  const mismatched = billedDogCounts.filter((n) => n !== activeDogs.length);

  return (
    <div>
      {mismatched.length > 0 && (
        <div className="mb-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-800 dark:text-amber-300">
          Services bill for {mismatched.join(" and ")} dog{mismatched.some((n) => n !== 1) ? "s" : ""},
          but this property has {activeDogs.length} active dog record
          {activeDogs.length === 1 ? "" : "s"}. Add the dogs below or fix the service dog count.
        </div>
      )}
      <div className="flex items-center justify-between">
        <SectionLabel>Dogs ({activeDogs.length})</SectionLabel>
        {!adding && (
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setAdding(true)}>
            <Plus className="mr-1 h-3 w-3 shrink-0" /> Add dog
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
                className={`rounded px-1.5 py-0.5 text-xs font-medium ${TEMPERAMENT_TONE[d.temperament ?? "unknown"]}`}
              >
                {d.temperament ?? "unknown"}
              </span>
              {d.notes && <span className="text-xs text-muted-foreground">{d.notes}</span>}
            </span>
            <span className="flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                onClick={() => startEdit(d)}
              >
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs text-muted-foreground"
                onClick={() => toggleMut.mutate({ id: d.id, active: false })}
              >
                Mark inactive
              </Button>
            </span>
          </li>
        ))}
        {activeDogs.length === 0 && !adding && (
          <li>
            <EmptyState
              compact
              icon={DogIcon}
              title="No dogs recorded"
              description="Dog records here drive service dog counts and safety notes."
              actionLabel="Add dog"
              onAction={() => setAdding(true)}
            />
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
            <Label className="text-xs" htmlFor={`dog-breed-${propertyId}`}>
              Breed
            </Label>
            <select
              id={`dog-breed-${propertyId}`}
              value={breedChoice}
              onChange={(e) => {
                setBreedChoice(e.target.value);
                setBreed(e.target.value === "__other" ? "" : e.target.value);
              }}
              className="h-10 w-full rounded-md border bg-background px-2 text-sm"
            >
              <option value="">Not sure / leave blank</option>
              {COMMON_BREEDS.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
              <option value="__other">Other…</option>
            </select>
            {breedChoice === "__other" && (
              <Input
                aria-label="Breed (custom)"
                className="mt-1"
                value={breed}
                onChange={(e) => setBreed(e.target.value)}
                placeholder="Type the breed"
              />
            )}
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
              {addMut.isPending
                ? "Saving…"
                : editingDogId
                  ? "Save dog"
                  : "Add dog"}
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

// formatArea re-exported so summary rows can show boundary area consistently.
export { formatArea };
