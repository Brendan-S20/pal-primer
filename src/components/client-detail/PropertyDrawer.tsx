// Property add/edit drawer (medium). No yard-size picker: size is derived
// from the drawn boundary. Commercial-only fields (sections, building
// labels) appear only for commercial properties; residential never sees
// them (spec: conditional fields).
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  createProperty,
  updateProperty,
  updatePropertyBoundary,
  setPropertyZoneOverride,
  setPropertyEstimateOverride,
  geocodePreview,
} from "@/lib/properties.functions";
import { BoundarySketch, type PolygonGeoJSON } from "@/components/BoundarySketch";
import { EditDrawer, DrawerFooter } from "@/components/client-detail/EditDrawer";
import { AddressAutocomplete, type ResolvedAddress } from "@/components/AddressAutocomplete";
// (Badge replaced by MetaChip per Stage 3 taxonomy.)
import { MetaChip, SectionLabel } from "@/components/client-detail/primitives";
import { useServiceLines } from "@/components/CommercialOnly";
import {
  ACCESS_CODE_MAX,
  ACCESS_METHODS,
  ACCESS_METHOD_LABEL,
  ALARM_NOTES_MAX,
  KEY_TAG_MAX,
  gateCodeSave,
  isAccessMethod,
  showsWalkAccess,
  walkAccessSave,
  type AccessMethod,
} from "@/lib/walk-access";

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
  const boundaryFn = useServerFn(updatePropertyBoundary);

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
      hazardNotes: property?.hazard_notes ?? "",
      vcName: property?.visit_contact_name ?? "",
      vcPhone: property?.visit_contact_phone ?? "",
      vcEmail: property?.visit_contact_email ?? "",
      sections: ((property?.commercial_sections ?? []) as string[]).join(", "),
      buildings: ((property?.building_labels ?? []) as string[]).join(", "),
      hasUnits: !!property?.has_units,
      totalUnits: property?.total_units != null ? String(property.total_units) : "",
      doNotEnterIfDogOut: !!property?.do_not_enter_if_dog_out,
      aggressiveDog: !!property?.aggressive_dog,
      escapeRisk: !!property?.escape_risk,
      invisibleFence: !!property?.invisible_fence,
      dogInYardDuringService: !!property?.dog_in_yard_during_service,
      beesWasps: !!property?.bees_wasps,
      sharpObjects: !!property?.sharp_objects,
      slipperySurfaces: !!property?.slippery_surfaces,
      accessMethod: (isAccessMethod(property?.access_method) ? property.access_method : "") as
        | AccessMethod
        | "",
      keyHeld: !!property?.key_held,
      keyTag: (property?.key_tag ?? "") as string,
      lockBoxCode: (property?.lock_box_code ?? "") as string,
      keyLocation: (property?.key_location ?? "") as string,
      alarmNotes: (property?.alarm_notes ?? "") as string,
    }),
    [property, client],
  );
  // Walker access (#410): a dog-walking business sees it, and so does any
  // property that already has a value. A pet-waste-only business sees the
  // drawer exactly as before, and its saves do not send these fields.
  const { lines: serviceLines, known: linesKnown } = useServiceLines();
  const walkAccess = linesKnown && showsWalkAccess(serviceLines, property);
  // listPropertiesForClient says whether property_access_codes returned this
  // row. When it did not, the code fields open blank over stored values.
  const codesNotLoaded = !!property && property.access_codes_loaded === false;
  const { t } = useTranslation();
  const initialBoundary = useMemo(
    () => ((property?.boundary as PolygonGeoJSON | null) ?? null),
    [property],
  );
  const [form, setForm] = useState(initial);
  // Reset only on closed -> open; background refetches must not wipe edits.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setForm(initial);
      setMatchedZoneName(null);
      setOverridesDirty(false);
      setPendingBoundary(null);
      setEditedBoundary(initialBoundary);
    }
    wasOpen.current = open;
  }, [open, initial, initialBoundary]);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const [matchedZoneName, setMatchedZoneName] = useState<string | null>(null);
  // The override inputs carry their own unsaved state; the close guard has
  // to know about it too.
  const [overridesDirty, setOverridesDirty] = useState(false);
  // Create mode: the sketched polygon rides along with the create call
  // (UX round 4: the boundary map must be available before the first save).
  const [pendingBoundary, setPendingBoundary] = useState<PolygonGeoJSON | null>(null);
  // Edit mode: the sketch lifts its polygon here and the form's single Save
  // persists it (UX round 6: no separate "Save boundary" button).
  const [editedBoundary, setEditedBoundary] = useState<PolygonGeoJSON | null>(initialBoundary);
  const boundaryDirty = property
    ? JSON.stringify(editedBoundary) !== JSON.stringify(initialBoundary)
    : pendingBoundary != null;

  // A sketched-but-unsaved boundary describes one specific location; any
  // address change makes it wrong, so it must not ride along silently.
  function discardPendingBoundary() {
    setPendingBoundary((prev) => {
      if (prev) {
        toast.info("Boundary sketch removed because the address changed. Redraw it below.");
      }
      return null;
    });
  }

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
    if (!property) discardPendingBoundary();
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
    if (!property) discardPendingBoundary();
  }

  const isCommercial = form.accountType === "commercial";
  const splitList = (s: string) =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);

  const saveMut = useMutation({
    mutationFn: async () => {
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
        // Sent only when changed, so a drawer that could not load the codes
        // does not wipe the gate code (gateCodeSave).
        ...gateCodeSave(initial, form),
        hazardNotes: form.hazardNotes || undefined,
        visitContactName: form.vcName || undefined,
        visitContactPhone: form.vcPhone || undefined,
        visitContactEmail: form.vcEmail || undefined,
        commercialSections: isCommercial ? splitList(form.sections) : [],
        buildingLabels: isCommercial ? splitList(form.buildings) : [],
        hasUnits: isCommercial ? form.hasUnits : false,
        totalUnits:
          isCommercial && form.hasUnits && form.totalUnits.trim() !== ""
            ? Math.max(0, parseInt(form.totalUnits, 10) || 0)
            : null,
        doNotEnterIfDogOut: form.doNotEnterIfDogOut,
        aggressiveDog: form.aggressiveDog,
        escapeRisk: form.escapeRisk,
        invisibleFence: form.invisibleFence,
        dogInYardDuringService: form.dogInYardDuringService,
        beesWasps: form.beesWasps,
        sharpObjects: form.sharpObjects,
        slipperySurfaces: form.slipperySurfaces,
        // Codes go out only when the user changed them (walkAccessSave).
        ...(walkAccess ? walkAccessSave(initial, form) : {}),
      };
      if (property) {
        await updateFn({ data: { propertyId: property.id, ...common } });
        // The sketch has no save button of its own (UX round 6): a changed
        // boundary rides along with the form's single Save.
        if (boundaryDirty) {
          try {
            await boundaryFn({ data: { propertyId: property.id, boundary: editedBoundary } });
          } catch (e) {
            // The property update already succeeded; closing anyway avoids
            // inviting a duplicate save from a half-failed state.
            return { boundaryError: (e as Error).message };
          }
        }
      } else {
        await createFn({ data: { clientId, ...common, boundary: pendingBoundary ?? undefined } });
      }
      return { boundaryError: null as string | null };
    },
    onSuccess: (r) => {
      if (r.boundaryError) {
        toast.error(
          `Property saved, but the boundary didn't: ${r.boundaryError}. Reopen the editor to retry.`,
        );
      } else {
        toast.success(property ? "Property saved" : "Property added");
      }
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
      dirty={dirty || boundaryDirty || overridesDirty}
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
                Map pin placed automatically. Draw the boundary below to set yard size.
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
            {codesNotLoaded && !walkAccess && (
              <p className="mt-1 text-xs text-muted-foreground" role="note">
                {t("walk.codesNotLoaded")}
              </p>
            )}
          </div>
        </div>

        {walkAccess && (
          <div className="rounded-md border bg-muted/20 p-3">
            <SectionLabel>How the walker gets in</SectionLabel>
            <p className="mt-1 text-xs text-muted-foreground">
              Only the walker on a visit here and the office can see these. They never go in a
              calendar or the client portal.
            </p>
            {codesNotLoaded && (
              <p className="mt-1 text-xs text-muted-foreground" role="note">
                {t("walk.codesNotLoaded")}
              </p>
            )}
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <div className="min-w-0">
                <Label htmlFor="pd-access-method" className="text-xs">
                  Way in
                </Label>
                <select
                  id="pd-access-method"
                  value={form.accessMethod}
                  onChange={(e) => set("accessMethod", e.target.value as AccessMethod | "")}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                >
                  <option value="">Not set</option>
                  {ACCESS_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {ACCESS_METHOD_LABEL[m]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="min-w-0">
                <Label htmlFor="pd-lockbox" className="text-xs">
                  Lock box code
                </Label>
                <Input
                  id="pd-lockbox"
                  value={form.lockBoxCode}
                  maxLength={ACCESS_CODE_MAX}
                  autoComplete="off"
                  onChange={(e) => set("lockBoxCode", e.target.value)}
                />
              </div>
              <div className="min-w-0 sm:col-span-2">
                <Label htmlFor="pd-key-location" className="text-xs">
                  Where the key is
                </Label>
                <Input
                  id="pd-key-location"
                  value={form.keyLocation}
                  maxLength={200}
                  onChange={(e) => set("keyLocation", e.target.value)}
                  placeholder="Under the blue pot by the back door"
                />
              </div>
              <div className="min-w-0 sm:col-span-2">
                <Label htmlFor="pd-alarm" className="text-xs">
                  Alarm
                </Label>
                <Input
                  id="pd-alarm"
                  value={form.alarmNotes ?? ""}
                  maxLength={ALARM_NOTES_MAX}
                  autoComplete="off"
                  onChange={(e) => set("alarmNotes", e.target.value)}
                  placeholder="Panel by the garage door, code 2580"
                />
              </div>
              <label className="flex items-center gap-2 text-sm touch:min-h-11">
                <input
                  type="checkbox"
                  checked={form.keyHeld}
                  onChange={(e) => set("keyHeld", e.target.checked)}
                />
                <span>We hold a key</span>
              </label>
              {form.keyHeld && (
                <div className="min-w-0">
                  <Label htmlFor="pd-key-tag" className="text-xs">
                    Key tag
                  </Label>
                  <Input
                    id="pd-key-tag"
                    value={form.keyTag}
                    maxLength={KEY_TAG_MAX}
                    onChange={(e) => set("keyTag", e.target.value)}
                    placeholder="K-12"
                  />
                </div>
              )}
            </div>
          </div>
        )}

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
            <div className="mt-3 border-t pt-3">
              <label className="flex items-center gap-2 text-sm touch:min-h-11">
                <input
                  type="checkbox"
                  checked={form.hasUnits}
                  onChange={(e) => set("hasUnits", e.target.checked as never)}
                />
                <span>This property has units (HOA / multi-unit)</span>
              </label>
              {form.hasUnits && (
                <div className="mt-2 max-w-[12rem]">
                  <Label htmlFor="pd-total-units" className="text-xs">
                    Total units
                  </Label>
                  <Input
                    id="pd-total-units"
                    type="number"
                    min="0"
                    value={form.totalUnits}
                    onChange={(e) => set("totalUnits", e.target.value)}
                    placeholder="e.g. 48"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Commercial zone pricing bills by total units, not just dog-owning units.
                  </p>
                </div>
              )}
            </div>
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

        {property ? (
          <BoundarySection property={property} onBoundaryChange={setEditedBoundary} />
        ) : (
          <NewBoundarySection
            street={form.street}
            city={form.city}
            region={form.region}
            postalCode={form.postalCode}
            latitude={form.latitude}
            longitude={form.longitude}
            onLocate={(p) => setForm((f) => ({ ...f, latitude: p.latitude, longitude: p.longitude }))}
            pendingBoundary={pendingBoundary}
            onBoundary={setPendingBoundary}
          />
        )}

        {property && canManagePricing && (
          <OverridesSection
            property={property}
            clientId={clientId}
            zones={zones}
            onDirtyChange={setOverridesDirty}
          />
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


// ── Boundary while creating (UX round 4: no save-then-reopen) ──────────────
// The property doesn't exist yet, so the sketch stashes its polygon locally
// and the create call carries it. Manual addresses have no pin until saved;
// "Locate on map" geocodes what's typed so the sketch can center.

function NewBoundarySection({
  street,
  city,
  region,
  postalCode,
  latitude,
  longitude,
  onLocate,
  pendingBoundary,
  onBoundary,
}: {
  street: string;
  city: string;
  region: string;
  postalCode: string;
  latitude: number | null;
  longitude: number | null;
  onLocate: (p: { latitude: number; longitude: number }) => void;
  pendingBoundary: PolygonGeoJSON | null;
  onBoundary: (p: PolygonGeoJSON | null) => void;
}) {
  const geocodeFn = useServerFn(geocodePreview);
  const locateMut = useMutation({
    mutationFn: () =>
      geocodeFn({
        data: { street, city, region: region || undefined, postalCode },
      }),
    onSuccess: (r: any) => {
      if (r?.point) onLocate(r.point);
      else toast.error("Couldn't find that address on the map. Check the street, city, and ZIP.");
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const hasPoint = latitude != null && longitude != null;
  const canLocate = street.trim() !== "" && city.trim() !== "" && postalCode.trim() !== "";

  return (
    <div className="rounded-md border bg-muted/20 p-3">
      <SectionLabel>Service boundary</SectionLabel>
      <p className="mt-1 text-xs text-muted-foreground">
        Outline the serviced yard now; it saves with the property. Yard size and estimated time
        are derived from it automatically.
      </p>
      {!hasPoint ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!canLocate || locateMut.isPending}
            onClick={() => locateMut.mutate()}
          >
            {locateMut.isPending ? "Locating…" : "Locate on map"}
          </Button>
          <span className="text-xs text-muted-foreground">
            {canLocate
              ? "Find the address on the map to start drawing."
              : "Enter the street, city, and ZIP first."}
          </span>
        </div>
      ) : (
        <div className="mt-2">
          <BoundarySketch
            key={`${latitude},${longitude}`}
            center={{ lat: Number(latitude), lng: Number(longitude) }}
            initial={pendingBoundary}
            hideSave
            onChange={onBoundary}
            areaSqm={null}
            height={340}
          />
          {pendingBoundary && (
            <p className="mt-1 text-xs text-muted-foreground">
              Boundary drawn; it saves with the property.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Inline boundary editing (UX round 3: no page hop) ──────────────────────
// No save button of its own (UX round 6): the sketch lifts its polygon into
// the drawer and the form's single Save persists it. The DB trigger still
// recalculates yard size + estimate when the boundary is saved.

function BoundarySection({
  property,
  onBoundaryChange,
}: {
  property: any;
  onBoundaryChange: (polygon: PolygonGeoJSON | null) => void;
}) {
  const center =
    property.latitude != null && property.longitude != null
      ? { lat: Number(property.latitude), lng: Number(property.longitude) }
      : null;

  return (
    <div className="rounded-md border bg-muted/20 p-3">
      <SectionLabel>Service boundary</SectionLabel>
      <p className="mt-1 text-xs text-muted-foreground">
        Outline the serviced yard; it saves with your changes. Yard size and estimated time are
        derived from it automatically.
      </p>
      <div className="mt-2">
        <BoundarySketch
          center={center}
          initial={(property.boundary as PolygonGeoJSON) ?? null}
          hideSave
          onChange={onBoundaryChange}
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
  onDirtyChange,
}: {
  property: any;
  clientId: string;
  zones: any[];
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const qc = useQueryClient();
  const zoneFn = useServerFn(setPropertyZoneOverride);
  const estFn = useServerFn(setPropertyEstimateOverride);
  const [zoneId, setZoneId] = useState<string>(property.zone_id ?? "");
  const [zoneReason, setZoneReason] = useState("");
  const [minutes, setMinutes] = useState<string>(String(property.service_duration_min ?? ""));
  const [estReason, setEstReason] = useState("");

  useEffect(() => {
    onDirtyChange?.(!!zoneReason.trim() || !!estReason.trim());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoneReason, estReason]);

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
