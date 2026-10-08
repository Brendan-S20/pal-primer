// Waste-station management for commercial/HOA properties. QA round 8: the
// station's location is a map marker (picked on a satellite map) instead of a
// free-text field, liner size is a dropdown, capacity is gone, and the list
// groups stations by the property's commercial sections.
import { useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { MapPin, Navigation, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState, MetaChip, SectionLabel, StatusChip } from "@/components/client-detail/primitives";
import { StationMapPicker, StationsOverviewMap, type StationPoint } from "@/components/StationMapPicker";
import { listStations, upsertStation, deleteStation, renumberStations } from "@/lib/stations.functions";
import { isValidLabel, stationDisplayName } from "@/lib/dna-linkage";
import { focusFirstInvalid } from "@/lib/form-errors";
import { formatDay } from "@/lib/format";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { useServiceLines } from "@/components/CommercialOnly";

export const LINER_SIZES = [
  "Small (8-10 gal)",
  "Medium (13-15 gal)",
  "Large (30-33 gal)",
  "Other",
] as const;

type Draft = {
  id: string | null;
  label: string;
  notes: string;
  linerSize: string;
  section: string;
  propertyId: string;
  position: StationPoint | null;
};

function emptyDraft(propertyId: string): Draft {
  return { id: null, label: "", notes: "", linerSize: "", section: "", propertyId, position: null };
}

export function StationsPanel({ clientId, properties }: { clientId: string; properties: any[] }) {
  const qc = useQueryClient();
  const listFn = useServerFn(listStations);
  const upsertFn = useServerFn(upsertStation);
  const delFn = useServerFn(deleteStation);

  const renumberFn = useServerFn(renumberStations);
  const { petWaste, known } = useServiceLines();
  const { confirm, dialog } = useConfirmDialog();

  const [draft, setDraft] = useState<Draft>(() => emptyDraft(properties[0]?.id ?? ""));
  // Set by a submit that found a problem; cleared when the form resets.
  // This used to be `markerMissing`, the one error this form ever showed, and
  // only after a toast; the label was checked by an early `return` that did
  // nothing at all, which is the owner's report in full: "It doesn't say or highlight
  // which fields are required, so it's hard to tell when marking and clicking
  // add station." (iPhone, 2026-10-04)
  const [showErrors, setShowErrors] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  // The add/edit form is collapsed until asked for — the panel's default view
  // is the overview map + list of what already exists, not a blank add form.
  const [formOpen, setFormOpen] = useState(false);

  const { data } = useQuery({
    queryKey: ["stations", clientId],
    queryFn: () => listFn({ data: { clientId } }),
  });

  const upsertMut = useMutation({
    mutationFn: (v: any) => upsertFn({ data: v }),
    onSuccess: () => {
      toast.success("Station saved");
      qc.invalidateQueries({ queryKey: ["stations", clientId] });
      setDraft((d) => emptyDraft(d.propertyId));
      setShowErrors(false);
      setFormOpen(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const delMut = useMutation({
    mutationFn: (id: string) => delFn({ data: { id } }),
    onSuccess: () => {
      toast.success("Station removed");
      qc.invalidateQueries({ queryKey: ["stations", clientId] });
      setDraft((d) => emptyDraft(d.propertyId));
      setFormOpen(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const renumberMut = useMutation({
    mutationFn: (propertyId: string) => renumberFn({ data: { propertyId } }),
    onSuccess: () => {
      toast.success("Stations renumbered");
      qc.invalidateQueries({ queryKey: ["stations", clientId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const removeStation = async (s: any) => {
    const ok = await confirm({
      title: `Remove ${stationDisplayName(s.station_number, s.label)}?`,
      description: "This deletes the station and its service history. This cannot be undone.",
      confirmLabel: "Remove station",
      destructive: true,
    });
    if (ok) delMut.mutate(s.id);
  };

  const stations: any[] = data?.stations ?? [];

  // What a station needs, from the code that stores it: a property
  // (property_id NOT NULL; the picker always has one), a label (the server
  // requires one and refuses placeholders, though old rows may be NULL), and
  // for a NEW station a map marker (this form's own rule: the marker is the
  // location). Liner size, section and notes are nullable, and say so.
  const labelError = !draft.label.trim()
    ? "Give the station a label, like Building A or North lot."
    : !isValidLabel(draft.label)
      ? "Use a real label, not a placeholder."
      : undefined;
  const needsMarker = !draft.position && !draft.id;
  const showLabelError = showErrors && !!labelError;
  const showMarkerError = showErrors && needsMarker;

  const selectedProperty = properties.find((p: any) => p.id === draft.propertyId);
  const sections: string[] = selectedProperty?.commercial_sections ?? [];
  const mapCenter: StationPoint | null =
    selectedProperty?.latitude != null && selectedProperty?.longitude != null
      ? { lat: Number(selectedProperty.latitude), lng: Number(selectedProperty.longitude) }
      : null;

  // Group rows under section headings when any station carries a section.
  // Heading order follows the properties' commercial_sections lists, with
  // stray values appended and unassigned stations grouped last.
  const groups = useMemo(() => {
    const hasSections = stations.some((s) => s.section);
    if (!hasSections) return null;
    const order: string[] = [];
    for (const p of properties) for (const sec of p.commercial_sections ?? []) {
      if (!order.includes(sec)) order.push(sec);
    }
    for (const s of stations) {
      if (s.section && !order.includes(s.section)) order.push(s.section);
    }
    const bySection = new Map<string, any[]>();
    for (const sec of order) bySection.set(sec, []);
    const unassigned: any[] = [];
    for (const s of stations) {
      if (s.section && bySection.has(s.section)) bySection.get(s.section)!.push(s);
      else unassigned.push(s);
    }
    const out = [...bySection.entries()].filter(([, rows]) => rows.length > 0);
    if (unassigned.length > 0) out.push(["Unassigned", unassigned]);
    return out;
  }, [stations, properties]);

  if (properties.length === 0) return null;
  // Waste stations are pet-waste equipment. A business that does not run pet
  // waste is not offered a panel to start adding them -- but one that already
  // has stations keeps it, because their service records live here
  // (PET_WASTE_MODULES.stations_dna). Hiding only; nothing is refused.
  if (!petWaste && known && data && stations.length === 0) return null;

  const startEdit = (s: any) => {
    setShowErrors(false);
    setFormOpen(true);
    setDraft({
      id: s.id,
      label: s.label ?? "",
      notes: s.location_description ?? "",
      linerSize: s.liner_size ?? "",
      section: s.section ?? "",
      propertyId: s.property_id,
      position: s.latitude != null && s.longitude != null
        ? { lat: Number(s.latitude), lng: Number(s.longitude) }
        : null,
    });
  };

  const renderRow = (s: any) => (
    <li key={s.id} className="flex items-start justify-between gap-3 py-2">
      <div className="flex min-w-0 items-start gap-2">
        <MapPin
          className={`mt-0.5 h-4 w-4 shrink-0 ${
            s.latitude != null ? "text-emerald-600" : "text-muted-foreground/50"
          }`}
        />
        <div className="min-w-0">
          <div className="font-medium">
            {stationDisplayName(s.station_number, s.label)}
            {!s.active && <StatusChip status="inactive" className="ml-2" />}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            {s.liner_size && <MetaChip>Liner: {s.liner_size}</MetaChip>}
            <MetaChip>
              Last serviced: {s.last_serviced_on ? formatDay(s.last_serviced_on) : "not yet"}
            </MetaChip>
            {s.latitude == null && (
              <span className="text-xs text-amber-600">No map marker yet</span>
            )}
          </div>
          {s.location_description && (
            <div className="mt-0.5 text-xs text-muted-foreground">{s.location_description}</div>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {s.latitude != null && s.longitude != null && (
          <Button size="sm" variant="outline" asChild>
            <a
              href={`https://www.google.com/maps/dir/?api=1&destination=${s.latitude},${s.longitude}`}
              target="_blank"
              rel="noreferrer"
            >
              <Navigation className="mr-1 h-3.5 w-3.5 shrink-0" />
              Navigate
            </a>
          </Button>
        )}
        {/* Remove now lives inside the edit flow (G7), not exposed on the list. */}
        <Button size="sm" variant="ghost" onClick={() => startEdit(s)} aria-label={`Edit ${s.label}`}>
          <Pencil className="h-3.5 w-3.5 shrink-0" />
        </Button>
      </div>
    </li>
  );

  return (
    <section className="rounded-lg border bg-card shadow-sm p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">Waste stations</h2>
        <div className="flex items-center gap-2">
          {/* With several properties the header button's target is ambiguous —
              renumbering then lives inside the form, scoped to the property
              picked there. */}
          {stations.length > 1 && properties.length === 1 && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              disabled={renumberMut.isPending}
              onClick={() => renumberMut.mutate(properties[0].id)}
            >
              Renumber
            </Button>
          )}
          {!formOpen && (
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={() => {
                setShowErrors(false);
                setDraft((d) => emptyDraft(d.propertyId));
                setFormOpen(true);
              }}
            >
              Add station
            </Button>
          )}
        </div>
      </div>

      {/* Overview: every placed station on one satellite map (click a marker
          to edit it). Shown whenever stations exist — the map is no longer
          only the add-form picker. */}
      {stations.length > 0 && (
        <div className="mt-3">
          <StationsOverviewMap
            stations={stations}
            center={mapCenter}
            onSelect={(id) => {
              const s = stations.find((x) => x.id === id);
              if (s) startEdit(s);
            }}
          />
          {stations.some((s) => s.latitude == null) && (
            <p className="mt-1 text-xs text-amber-600">
              Stations without a map marker don't appear on the map. Open them and drop a marker.
            </p>
          )}
        </div>
      )}

      {stations.length > 0 ? (
        groups ? (
          <div className="mt-3 space-y-3 text-sm">
            {groups.map(([section, rows]) => (
              <div key={section}>
                <SectionLabel>{section}</SectionLabel>
                <ul className="divide-y">{rows.map(renderRow)}</ul>
              </div>
            ))}
          </div>
        ) : (
          <ul className="mt-3 divide-y text-sm">{stations.map(renderRow)}</ul>
        )
      ) : (
        <div className="mt-3">
          <EmptyState
            compact
            icon={MapPin}
            title="No stations added yet"
            description="Add waste stations so techs know what to service and refill."
          />
        </div>
      )}

      {formOpen && (
      <form
        ref={formRef}
        noValidate
        // `grid-cols-1`, not a bare `grid`: an implicit column is sized to
        // its widest item's content, and the action row below does not wrap,
        // so with "Renumber this property's stations" in it the whole form
        // was as wide as that row and ran out of the card on a phone.
        className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.propertyId) return;
          // New stations need a marker; EDITING a legacy marker-less station
          // must still be possible (rename, liner size) or those rows would
          // be permanently locked for anyone not standing on site.
          if (labelError || needsMarker) {
            // Every field with a problem says so, and focus goes to the first.
            setShowErrors(true);
            focusFirstInvalid(formRef.current);
            return;
          }
          upsertMut.mutate({
            id: draft.id ?? undefined,
            clientId,
            propertyId: draft.propertyId,
            label: draft.label,
            locationDescription: draft.notes || null,
            linerSize: draft.linerSize || null,
            section: draft.section || null,
            ...(draft.position
              ? { latitude: draft.position.lat, longitude: draft.position.lng }
              : {}),
          });
        }}
      >
        <div className="sm:col-span-2">
          <Label htmlFor="station-property">Property</Label>
          <select
            id="station-property"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            value={draft.propertyId}
            // A marker dropped on property A must not silently become the
            // location on property B: clear it with the section.
            onChange={(e) =>
              setDraft({ ...draft, propertyId: e.target.value, section: "", position: null })
            }
          >
            {properties.map((p: any) => (
              <option key={p.id} value={p.id}>
                {p.street}
              </option>
            ))}
          </select>
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor="station-label">Label</Label>
          <Input
            id="station-label"
            value={draft.label}
            onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            placeholder="Building A, north lot"
            required
            aria-invalid={showLabelError}
            aria-describedby={showLabelError ? "station-label-error" : undefined}
            className={showLabelError ? "border-destructive" : undefined}
          />
          {showLabelError && (
            <p id="station-label-error" className="mt-1 text-xs text-destructive">
              {labelError}
            </p>
          )}
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor="station-liner">Liner size (optional)</Label>
          <select
            id="station-liner"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            value={draft.linerSize}
            onChange={(e) => setDraft({ ...draft, linerSize: e.target.value })}
          >
            <option value="">Select size…</option>
            {LINER_SIZES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        {sections.length > 0 && (
          <div className="sm:col-span-2">
            <Label htmlFor="station-section">Section (optional)</Label>
            <select
              id="station-section"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              value={draft.section}
              onChange={(e) => setDraft({ ...draft, section: e.target.value })}
            >
              <option value="">No section</option>
              {sections.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className={sections.length > 0 ? "sm:col-span-4" : "sm:col-span-6"}>
          <Label htmlFor="station-notes">Notes (optional)</Label>
          <Input
            id="station-notes"
            value={draft.notes}
            onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            placeholder="Near mail kiosk"
          />
        </div>
        <div className="sm:col-span-6">
          <Label id="station-location-label">
            Station location{draft.id ? " (optional)" : ""}
          </Label>
          {/* Focusable only so a failed submit can bring it into view: a map
              has no field to put a caret in. */}
          <div
            className={`mt-1 rounded-md ${showMarkerError ? "ring-2 ring-destructive ring-offset-2 ring-offset-background" : ""}`}
            tabIndex={-1}
            role="group"
            aria-labelledby="station-location-label"
            aria-invalid={showMarkerError}
            aria-describedby="station-location-hint"
          >
            <StationMapPicker
              value={draft.position}
              center={mapCenter}
              onChange={(p) => {
                setDraft((d) => ({ ...d, position: p }));
              }}
            />
          </div>
          <p
            id="station-location-hint"
            className={`mt-1 text-xs ${showMarkerError ? "text-destructive" : "text-muted-foreground"}`}
          >
            {draft.position
              ? "Drag the marker to fine-tune the station's spot."
              : showMarkerError
                ? "Tap the map where the station sits to drop its marker. A new station needs one."
                : "Tap the map to drop a marker where the station sits. That marker is the station's location."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:col-span-6">
          <Button type="submit" disabled={upsertMut.isPending}>
            {draft.id ? "Save station" : "Add station"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setShowErrors(false);
              setDraft((d) => emptyDraft(d.propertyId));
              setFormOpen(false);
            }}
          >
            Cancel
          </Button>
          {properties.length > 1 && stations.some((s) => s.property_id === draft.propertyId) && (
            <Button
              type="button"
              variant="ghost"
              className="text-xs"
              disabled={renumberMut.isPending}
              onClick={() => renumberMut.mutate(draft.propertyId)}
            >
              Renumber this property's stations
            </Button>
          )}
          {/* Destructive remove lives inside the edit flow (G7). */}
          {draft.id && (
            <Button
              type="button"
              variant="ghost"
              className="ml-auto text-destructive hover:text-destructive"
              onClick={() => {
                const s = stations.find((x) => x.id === draft.id);
                if (s) removeStation(s);
              }}
            >
              Remove station
            </Button>
          )}
        </div>
      </form>
      )}
      {dialog}
    </section>
  );
}
