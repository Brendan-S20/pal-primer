// Property add/edit drawer (medium). No yard-size picker: size is derived
// from the drawn boundary. Commercial-only fields (sections, building
// labels) appear only for commercial properties; residential never sees
// them (spec: conditional fields).
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  createProperty,
  updateProperty,
  updatePropertyBoundary,
  setPropertyZoneOverride,
  setPropertyEstimateOverride,
} from "@/lib/properties.functions";
import { BoundarySketch, type PolygonGeoJSON } from "@/components/BoundarySketch";
import { updatePropertyWindow } from "@/lib/visits.functions";
import { EditDrawer, DrawerFooter } from "@/components/client-detail/EditDrawer";
import { AddressAutocomplete, type ResolvedAddress } from "@/components/AddressAutocomplete";
// (Badge replaced by MetaChip per Stage 3 taxonomy.)
import { TimeField } from "@/components/fields";
import { MetaChip, SectionLabel } from "@/components/client-detail/primitives";

const HAZARD_FIELDS: Array<[string, string]> = [
  ["doNotEnterIfDogOut", "Do NOT enter if dog is outside"],
  ["aggressiveDog", "Aggressive dog"],
  ["escapeRisk", "Escape risk (close gate)"],
  ["invisibleFence", "Invisible fence"],
  ["dogInYardDuringService", "Dog in yard during service"],
  ["beesWasps", "Bees / wasps"],
  ["sharpObjects", "Sharp objects"],
  ["slipperySurfaces", "Slippery surfaces"],
];

export function PropertyDrawer({
  open,
  onClose,
  clientId,
  client,
  property,
  zones = [],
  canManagePricing = false,
}: {
  open: boolean;
  onClose: () => void;
  clientId: string;
  client: any;
  /** null = adding a new property. */
  property: any | null;
  zones?: any[];
  canManagePricing?: boolean;
}) {
  const qc = useQueryClient();
  const createFn = useServerFn(createProperty);
  const updateFn = useServerFn(updateProperty);
  const windowFn = useServerFn(updatePropertyWindow);

  const initial = useMemo(
    () => ({
      street: property?.street ?? "",
      unit: property?.unit ?? "",
      city: property?.city ?? "",
      region: property?.region ?? "",
      postalCode: property?.postal_code ?? "",
      latitude: (property?.latitude ?? null) as number | null,
      longitude: (property?.longitude ?? null) as number | null,
      addressSource: (property?.address_source ?? "manual") as "matched" | "manual",
      label: property?.label ?? "",
      accountType: (property?.account_type ?? client?.account_type ?? "residential") as
        | "residential"
        | "commercial",
      gateCode: property?.gate_code ?? "",
      // Arrival window ("HH:MM", "" = anytime) — saved via updatePropertyWindow.
      earliestTime: (property?.earliest_service_time?.slice(0, 5) ?? "") as string,
      latestTime: (property?.latest_service_time?.slice(0, 5) ?? "") as string,
      hazardNotes: property?.hazard_notes ?? "",
      vcName: property?.visit_contact_name ?? "",
      vcPhone: property?.visit_contact_phone ?? "",
      vcEmail: property?.visit_contact_email ?? "",
      sections: ((property?.commercial_sections ?? []) as string[]).join(", "),
      buildings: ((property?.building_labels ?? []) as string[]).join(", "),
      doNotEnterIfDogOut: !!property?.do_not_enter_if_dog_out,
      aggressiveDog: !!property?.aggressive_dog,
      escapeRisk: !!property?.escape_risk,
      invisibleFence: !!property?.invisible_fence,
      dogInYardDuringService: !!property?.dog_in_yard_during_service,
      beesWasps: !!property?.bees_wasps,
      sharpObjects: !!property?.sharp_objects,
      slipperySurfaces: !!property?.slippery_surfaces,
    }),
    [property, client],
  );
  const [form, setForm] = useState(initial);
  // Reset only on closed -> open; background refetches must not wipe edits.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setForm(initial);
      setMatchedZoneName(null);
    }
    wasOpen.current = open;
  }, [open, initial]);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const [matchedZoneName, setMatchedZoneName] = useState<string | null>(null);

  function applyResolved(r: ResolvedAddress) {
    setForm((f) => ({
      ...f,
      street: r.address.street,
      // Each match owns the unit: carrying "#4" from a previous selection
      // onto a different address would save a wrong unit.
      unit: r.address.unit ?? "",
      city: r.address.city,
      region: r.address.region ?? "",
      postalCode: r.address.postalCode,
      latitude: r.address.latitude,
      longitude: r.address.longitude,
      addressSource: "matched",
    }));
    setMatchedZoneName(r.zoneName);
  }

  // Any hand edit to an address field invalidates whatever point we had:
  // for matched addresses it demotes them to manual, and for manual ones
  // the old geocoded pin no longer describes what's typed either — clearing
  // the coords makes the server re-geocode the new address on save.
  function setAddressField(k: "street" | "city" | "postalCode" | "region", v: string) {
    setForm((f) => ({
      ...f,
      [k]: v,
      addressSource: "manual" as const,
      latitude: null,
      longitude: null,
    }));
    setMatchedZoneName(null);
  }

  const isCommercial = form.accountType === "commercial";
  const splitList = (s: string) =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);

  const saveMut = useMutation({
    mutationFn: () => {
      const common = {
        street: form.street,
        unit: form.unit || undefined,
        city: form.city,
        region: form.region || undefined,
        postalCode: form.postalCode,
        latitude: form.latitude ?? undefined,
        longitude: form.longitude ?? undefined,
        addressSource: form.addressSource,
        label: form.label || undefined,
        accountType: form.accountType,
        gateCode: form.gateCode || undefined,
        hazardNotes: form.hazardNotes || undefined,
        visitContactName: form.vcName || undefined,
        visitContactPhone: form.vcPhone || undefined,
        visitContactEmail: form.vcEmail || undefined,
        commercialSections: isCommercial ? splitList(form.sections) : [],
        buildingLabels: isCommercial ? splitList(form.buildings) : [],
        doNotEnterIfDogOut: form.doNotEnterIfDogOut,
        aggressiveDog: form.aggressiveDog,
        escapeRisk: form.escapeRisk,
        invisibleFence: form.invisibleFence,
        dogInYardDuringService: form.dogInYardDuringService,
        beesWasps: form.beesWasps,
        sharpObjects: form.sharpObjects,
        slipperySurfaces: form.slipperySurfaces,
      };
      const run = property
        ? updateFn({ data: { propertyId: property.id, ...common } })
        : createFn({ data: { clientId, ...common } });
      return run.then(async (res: any) => {
        // Arrival window lives in its own server fn; save it after the main
        // create/update succeeds. Existing properties: only when changed.
        // New properties: only when a value was actually set.
        const windowChanged =
          form.earliestTime !== initial.earliestTime || form.latestTime !== initial.latestTime;
        const targetId = property ? property.id : (res?.id as string | undefined);
        const shouldSave = property ? windowChanged : !!(form.earliestTime || form.latestTime);
        if (shouldSave && targetId) {
          try {
            await windowFn({
              data: {
                propertyId: targetId,
                earliest_service_time: form.earliestTime || null,
                latest_service_time: form.latestTime || null,
              },
            });
          } catch (e) {
            // The property itself saved; failing the whole mutation here
            // would leave the drawer open and invite a duplicate create.
            toast.error(
              `Property saved, but the arrival window didn't: ${(e as Error).message}. Edit the property to retry.`,
            );
          }
        }
        return { ok: true };
      });
    },
    onSuccess: () => {
      toast.success(property ? "Property saved" : "Property added");
      qc.invalidateQueries({ queryKey: ["properties", clientId] });
      qc.invalidateQueries({ queryKey: ["client-activity", clientId] });
      onClose();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <EditDrawer
      open={open}
      onClose={onClose}
      title={property ? "Edit property" : "Add property"}
      description="The service zone is detected automatically from the address. Draw the boundary on the map to set yard size and estimated time."
      size="lg"
      dirty={dirty}
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          saveMut.mutate();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-6">
          <div className="sm:col-span-4">
            <Label htmlFor="pd-street">Street</Label>
            <AddressAutocomplete
              id="pd-street"
              value={form.street}
              onChangeText={(t) => setAddressField("street", t)}
              onResolved={applyResolved}
              required
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="pd-unit">Apt / unit (optional)</Label>
            <Input id="pd-unit" value={form.unit} onChange={(e) => set("unit", e.target.value)} />
          </div>
          <div className="sm:col-span-3">
            <Label htmlFor="pd-city">City</Label>
            <Input
              id="pd-city"
              value={form.city}
              onChange={(e) => setAddressField("city", e.target.value)}
              required
            />
          </div>
          <div className="sm:col-span-1">
            <Label htmlFor="pd-region">State</Label>
            <Input
              id="pd-region"
              value={form.region}
              onChange={(e) => setAddressField("region", e.target.value)}
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="pd-zip">ZIP</Label>
            <Input
              id="pd-zip"
              value={form.postalCode}
              onChange={(e) => setAddressField("postalCode", e.target.value)}
              required
            />
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:col-span-6">
            <MetaChip>
              {form.addressSource === "matched"
                ? "Address Matched, Not USPS Verified"
                : "Manual entry"}
            </MetaChip>
            {matchedZoneName && (
              <span className="text-xs text-muted-foreground">
                Detected zone: <span className="font-medium text-foreground">{matchedZoneName}</span>
              </span>
            )}
            {form.addressSource === "matched" && (
              <span className="text-xs text-muted-foreground">
                Map pin placed automatically. Draw the boundary after saving to set yard size.
              </span>
            )}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <Label htmlFor="pd-label">Label (optional)</Label>
            <Input
              id="pd-label"
              value={form.label}
              onChange={(e) => set("label", e.target.value)}
              placeholder="Home, Rental #2"
            />
          </div>
          <div>
            <Label htmlFor="pd-type">Property type</Label>
            <select
              id="pd-type"
              value={form.accountType}
              onChange={(e) => set("accountType", e.target.value as "residential" | "commercial")}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              <option value="residential">Residential</option>
              <option value="commercial">Commercial / HOA</option>
            </select>
          </div>
          <div>
            <Label htmlFor="pd-gate">Gate code</Label>
            <Input id="pd-gate" value={form.gateCode} onChange={(e) => set("gateCode", e.target.value)} />
          </div>
        </div>

        <div className="rounded-md border bg-muted/20 p-3">
          <SectionLabel>Service window</SectionLabel>
          <p className="mt-1 text-xs text-muted-foreground">
            When the team may arrive. This is a window, not the actual arrival time. Leave both on
            Anytime for no window.
          </p>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <TimeField
              label="Earliest arrival"
              value={form.earliestTime}
              onChange={(v) => set("earliestTime", v)}
            />
            <TimeField
              label="Latest arrival"
              value={form.latestTime}
              onChange={(v) => set("latestTime", v)}
            />
          </div>
        </div>

        {isCommercial && (
          <div className="rounded-md border bg-muted/20 p-3">
            <SectionLabel>Commercial details</SectionLabel>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="pd-sections" className="text-xs">
                  Sections
                </Label>
                <Input
                  id="pd-sections"
                  value={form.sections}
                  onChange={(e) => set("sections", e.target.value)}
                  placeholder="North lawn, dog park, pool area"
                />
              </div>
              <div>
                <Label htmlFor="pd-buildings" className="text-xs">
                  Building labels
                </Label>
                <Input
                  id="pd-buildings"
                  value={form.buildings}
                  onChange={(e) => set("buildings", e.target.value)}
                  placeholder="Bldg A, Bldg B, Clubhouse"
                />
              </div>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Separate entries with commas. Waste stations are managed in the Services tab.
            </p>
          </div>
        )}

        <div className="rounded-md border bg-muted/20 p-3">
          <SectionLabel>
            On-site visit contact <span className="font-normal normal-case">(optional)</span>
          </SectionLabel>
          <p className="mt-1 text-xs text-muted-foreground">
            For rentals/managed properties: this person gets visit texts and emails. Invoices still
            go to the account contact.
          </p>
          <div className="mt-2 grid gap-3 sm:grid-cols-3">
            <div>
              <Label htmlFor="pd-vc-name" className="text-xs">
                Name
              </Label>
              <Input id="pd-vc-name" value={form.vcName} onChange={(e) => set("vcName", e.target.value)} />
            </div>
            <div>
              <Label htmlFor="pd-vc-phone" className="text-xs">
                Phone
              </Label>
              <Input
                id="pd-vc-phone"
                type="tel"
                value={form.vcPhone}
                onChange={(e) => set("vcPhone", e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="pd-vc-email" className="text-xs">
                Email
              </Label>
              <Input
                id="pd-vc-email"
                type="email"
                value={form.vcEmail}
                onChange={(e) => set("vcEmail", e.target.value)}
              />
            </div>
          </div>
        </div>

        <div className="rounded-md border bg-muted/20 p-3">
          <SectionLabel>Safety &amp; access hazards</SectionLabel>
          <div className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
            {HAZARD_FIELDS.map(([k, label]) => (
              <label key={k} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form[k as keyof typeof form] as boolean}
                  onChange={(e) => set(k as keyof typeof form, e.target.checked as never)}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
          <div className="mt-2">
            <Label htmlFor="pd-hnotes" className="text-xs">
              Hazard notes
            </Label>
            <Input
              id="pd-hnotes"
              value={form.hazardNotes}
              onChange={(e) => set("hazardNotes", e.target.value)}
              placeholder="e.g. Pool uncovered in summer; loose board at back gate"
            />
          </div>
        </div>

        {property && (
          <BoundarySection property={property} clientId={clientId} />
        )}

        {property && canManagePricing && (
          <OverridesSection property={property} clientId={clientId} zones={zones} />
        )}

        <DrawerFooter>
          <Button type="submit" disabled={saveMut.isPending}>
            {saveMut.isPending ? "Saving…" : property ? "Save changes" : "Add property"}
          </Button>
        </DrawerFooter>
      </form>
    </EditDrawer>
  );
}


// ── Inline boundary editing (UX round 3: no page hop) ──────────────────────
// Its own save button: redrawing a yard shouldn't be coupled to the form's
// Save, and the DB trigger recalculates yard size + estimate on save.

function BoundarySection({ property, clientId }: { property: any; clientId: string }) {
  const qc = useQueryClient();
  const saveFn = useServerFn(updatePropertyBoundary);
  const mut = useMutation({
    mutationFn: (polygon: PolygonGeoJSON | null) =>
      saveFn({ data: { propertyId: property.id, boundary: polygon } }),
    onSuccess: (r: any) => {
      toast.success(
        r?.area_sqm ? "Boundary saved. Yard size and estimated time updated." : "Boundary cleared",
      );
      qc.invalidateQueries({ queryKey: ["properties", clientId] });
      qc.invalidateQueries({ queryKey: ["client-activity", clientId] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const center =
    property.latitude != null && property.longitude != null
      ? { lat: Number(property.latitude), lng: Number(property.longitude) }
      : null;

  return (
    <div className="rounded-md border bg-muted/20 p-3">
      <SectionLabel>Service boundary</SectionLabel>
      <p className="mt-1 text-xs text-muted-foreground">
        Outline the serviced yard. Yard size and estimated time are derived from it automatically.
      </p>
      <div className="mt-2">
        <BoundarySketch
          center={center}
          initial={(property.boundary as PolygonGeoJSON) ?? null}
          onSave={(polygon) => mut.mutate(polygon)}
          saving={mut.isPending}
          areaSqm={property.boundary_area_sqm ? Number(property.boundary_area_sqm) : null}
          height={340}
        />
      </div>
    </div>
  );
}

// ── Zone + estimated-time overrides (authorized roles) ─────────────────────

function OverridesSection({
  property,
  clientId,
  zones,
}: {
  property: any;
  clientId: string;
  zones: any[];
}) {
  const qc = useQueryClient();
  const zoneFn = useServerFn(setPropertyZoneOverride);
  const estFn = useServerFn(setPropertyEstimateOverride);
  const [zoneId, setZoneId] = useState<string>(property.zone_id ?? "");
  const [zoneReason, setZoneReason] = useState("");
  const [minutes, setMinutes] = useState<string>(String(property.service_duration_min ?? ""));
  const [estReason, setEstReason] = useState("");

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["properties", clientId] });
    qc.invalidateQueries({ queryKey: ["client-activity", clientId] });
  };
  const zoneMut = useMutation({
    mutationFn: (v: { zoneId: string | null; reason?: string }) =>
      zoneFn({ data: { propertyId: property.id, ...v } }),
    onSuccess: () => {
      toast.success("Zone updated");
      setZoneReason("");
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const estMut = useMutation({
    mutationFn: (v: { minutes: number | null; reason?: string }) =>
      estFn({ data: { propertyId: property.id, ...v } }),
    onSuccess: () => {
      toast.success("Estimated time updated");
      setEstReason("");
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const detected = zones.find((z: any) => z.id === property.auto_zone_id)?.name ?? "none";

  return (
    <div className="rounded-md border bg-muted/20 p-3">
      <SectionLabel>Zone & time overrides</SectionLabel>
      <p className="mt-1 text-xs text-muted-foreground">
        Both are set automatically. Overrides need a reason and show up on the activity timeline.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Zone</span>
            <MetaChip>Detected: {detected}</MetaChip>
            {property.zone_override_reason && <MetaChip>Overridden</MetaChip>}
          </div>
          <select
            aria-label="Effective zone"
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
          <Input
            aria-label="Zone override reason"
            value={zoneReason}
            onChange={(e) => setZoneReason(e.target.value)}
            placeholder="Reason (required to override)"
          />
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={zoneMut.isPending || !zoneId || !zoneReason.trim()}
              onClick={() => zoneMut.mutate({ zoneId, reason: zoneReason })}
            >
              Apply override
            </Button>
            {property.zone_override_reason && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={zoneMut.isPending}
                onClick={() => zoneMut.mutate({ zoneId: null })}
              >
                Back to detected
              </Button>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Time on site</span>
            {property.est_override_at ? <MetaChip>Overridden</MetaChip> : <MetaChip>Auto</MetaChip>}
          </div>
          <Input
            aria-label="Minutes on site"
            type="number"
            min="1"
            max="600"
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            placeholder="Minutes"
          />
          <Input
            aria-label="Time override reason"
            value={estReason}
            onChange={(e) => setEstReason(e.target.value)}
            placeholder="Reason (required to override)"
          />
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={estMut.isPending || !minutes || !estReason.trim()}
              onClick={() => estMut.mutate({ minutes: parseInt(minutes, 10), reason: estReason })}
            >
              Apply override
            </Button>
            {property.est_override_at && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={estMut.isPending}
                onClick={() => estMut.mutate({ minutes: null })}
              >
                Back to auto
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
