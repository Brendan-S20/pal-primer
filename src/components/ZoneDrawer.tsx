// Zone create/edit drawer (QA round 3, C5/G5): the Zones page used inline
// cards with a ZIP-only creation form. This drawer follows the app-wide
// EditDrawer pattern and carries everything a zone needs up front: name,
// residential/commercial type, priority, ZIPs, REQUIRED map coverage
// (centered on the first typed ZIP), residential pricing, and commercial
// rates. Server-side validation in zones.functions.ts mirrors every rule.
import { useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { X } from "lucide-react";
import {
  createZone,
  updateZone,
  geocodePostal,
  splitZipInput,
  parseUsZips,
  normalizeUsZip,
  rejectedZipMessage,
} from "@/lib/zones.functions";
import { EditDrawer, DrawerFooter } from "@/components/client-detail/EditDrawer";
import { SectionLabel } from "@/components/client-detail/primitives";
import { ZoneCoverageMap, type CoverageValue } from "@/components/ZoneCoverageMap";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCommercialAccounts } from "@/components/CommercialOnly";

// Zone saves re-run zone detection across the org's properties (QA round 8:
// "I updated a zone and none of the properties adjusted to it").
const reassignedToastMsg = (verb: string, n: number | undefined) =>
  n && n > 0 ? `${verb}. ${n} ${n === 1 ? "property" : "properties"} re-assigned.` : verb;

// ZIP entry assumes the United States (owner QA, 2026-08-19: "When entering a
// zip code for zones, it should automatically assume it's a United States zip
// code"). The normalization rules and the reasoning behind each of them live
// with the server-side validator in @/lib/zones.functions — one definition, so
// the chip you see and the row that is written cannot disagree. What is
// specific to this component is only how a refusal is SHOWN:
//
//   - refused tokens stay in the input box rather than vanishing, so a paste
//     of twenty ZIPs with two bad ones leaves those two sitting there to be
//     corrected, next to a message naming them. Silently dropping them is
//     worse than accepting them: the owner reads twenty chips as twenty ZIPs.
//   - chips already on the zone that are not normalized US ZIPs (rows written
//     before this rule existed) are drawn as destructive and named. They are
//     not rewritten on open — that would edit the zone behind the owner's
//     back — and they block saving, because the server refuses them too and a
//     red toast at the end of a long form is a worse place to learn it.
function ZipChips({
  value,
  onChange,
  placeholder,
  describedBy,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  describedBy?: string;
}) {
  const [buf, setBuf] = useState("");
  const [rejected, setRejected] = useState<string[]>([]);

  const commit = (raw: string) => {
    const { zips, rejected: bad } = parseUsZips(splitZipInput(raw));
    setRejected(bad);
    if (zips.length) onChange(Array.from(new Set([...value, ...zips])));
    // Whatever could not be read goes back in the box; everything else clears.
    setBuf(bad.join(" "));
  };

  // Legacy chips: anything that is not already its own normalized form.
  const stale = value.filter((z) => normalizeUsZip(z) !== z);

  return (
    <div className="space-y-1">
      <div className="flex min-h-[44px] flex-wrap items-center gap-1.5 rounded-md border bg-background p-2">
        {value.map((z) => {
          const bad = normalizeUsZip(z) !== z;
          return (
            <Badge
              key={z}
              variant={bad ? "destructive" : "secondary"}
              className="gap-1 pr-1"
              title={bad ? "Not a US 5-digit ZIP, so this matches no address" : undefined}
            >
              {z}
              <button
                type="button"
                className="rounded-full p-0.5 hover:bg-muted-foreground/20"
                onClick={() => onChange(value.filter((x) => x !== z))}
                aria-label={`Remove ${z}`}
              >
                <X className="h-3 w-3 shrink-0" />
              </button>
            </Badge>
          );
        })}
        <input
          value={buf}
          inputMode="numeric"
          autoComplete="postal-code"
          aria-label="Add a US 5-digit ZIP code"
          aria-describedby={describedBy}
          aria-invalid={rejected.length > 0 || undefined}
          onChange={(e) => {
            setBuf(e.target.value);
            if (rejected.length) setRejected([]);
          }}
          onKeyDown={(e) => {
            // Tab is deliberately NOT in this list. It used to be, and with a
            // commit that could now refuse its input that becomes a keyboard
            // trap: type "787", press Tab, the commit refuses it, the default
            // is prevented and focus never leaves the field. Tab still commits
            // — onBlur does it — it just also moves on.
            if (e.key === "Enter" || e.key === "," || e.key === " ") {
              if (buf.trim()) {
                e.preventDefault();
                commit(buf);
              }
            } else if (e.key === "Backspace" && !buf && value.length) {
              onChange(value.slice(0, -1));
            }
          }}
          onBlur={() => buf.trim() && commit(buf)}
          onPaste={(e) => {
            const text = e.clipboardData.getData("text");
            if (/[\s,;]/.test(text)) {
              e.preventDefault();
              commit(text);
            }
          }}
          className="min-h-[44px] min-w-[100px] flex-1 bg-transparent text-sm outline-none"
          placeholder={value.length ? "" : (placeholder ?? "78701, 78702…")}
        />
      </div>
      {rejected.length > 0 && (
        <p className="text-xs text-destructive" role="alert">
          {rejectedZipMessage(rejected)}
        </p>
      )}
      {stale.length > 0 && (
        <p className="text-xs text-destructive">
          {stale.length === 1 ? "This ZIP was" : "These ZIPs were"} saved before ZIPs were checked
          and {stale.length === 1 ? "matches" : "match"} no address: {stale.join(", ")}. Remove{" "}
          {stale.length === 1 ? "it" : "them"} to save.
        </p>
      )}
    </div>
  );
}

type ZoneType = "residential" | "commercial" | "all";

const dollarsOrBlank = (cents: number | null | undefined) =>
  cents != null ? (cents / 100).toFixed(2) : "";
const centsOrNull = (v: string) =>
  v.trim() === "" ? null : Math.round((parseFloat(v) || 0) * 100);

function MoneyInput({
  id,
  value,
  onChange,
  placeholder,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-muted-foreground">$</span>
      <Input
        id={id}
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}

export function ZoneDrawer({
  open,
  onClose,
  zone,
}: {
  open: boolean;
  onClose: () => void;
  /** Null/undefined = create a new zone. */
  zone?: any | null;
}) {
  const isNew = !zone;
  const qc = useQueryClient();
  const createFn = useServerFn(createZone);
  const updateFn = useServerFn(updateZone);
  const geocodeFn = useServerFn(geocodePostal);

  const [dirty, setDirty] = useState(false);
  const mark =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      setDirty(true);
      set(v);
    };

  const [name, setName] = useState<string>(zone?.name ?? "");
  const [priceNote, setPriceNote] = useState<string>(zone?.price_note ?? "");
  // A NEW zone defaults to the kind of work this business actually does.
  // It used to default to "all", which meant every operator — including one
  // with forty driveways and no HOAs — was shown a commercial pricing block
  // (base + per unit + per acre + per station) before they had typed a name.
  // An EXISTING zone always shows what it is; this only chooses the default
  // for a zone being created.
  const { enabled: commercialEnabled } = useCommercialAccounts();
  const [zoneType, setZoneType] = useState<ZoneType>(
    (zone?.account_type as ZoneType) ?? (commercialEnabled ? "all" : "residential"),
  );
  const [priority, setPriority] = useState<string>(String(zone?.priority ?? 0));
  const [zips, setZips] = useState<string[]>(zone?.zip_codes ?? []);

  // Residential pricing
  const [basePrice, setBasePrice] = useState<string>(
    zone ? ((zone.base_price_cents ?? 0) / 100).toFixed(2) : "25.00",
  );
  const [perDog, setPerDog] = useState<string>(
    zone ? ((zone.per_dog_addl_cents ?? 0) / 100).toFixed(2) : "5.00",
  );
  const [initialCleanup, setInitialCleanup] = useState<string>(
    zone ? ((zone.initial_cleanup_cents ?? 0) / 100).toFixed(2) : "0",
  );
  const [pricingMode, setPricingMode] = useState<"flat" | "per_sqft" | "per_acre">(
    (zone?.pricing_mode as any) ?? "flat",
  );
  const [perSqft, setPerSqft] = useState<string>(
    String(Number(zone?.price_per_sqft_cents ?? 0) / 100),
  );
  const [perAcre, setPerAcre] = useState<string>(
    ((zone?.price_per_acre_cents ?? 0) / 100).toFixed(2),
  );
  const [areaMin, setAreaMin] = useState<string>(
    ((zone?.area_min_charge_cents ?? 0) / 100).toFixed(2),
  );
  // Blank rather than "0.00" when unset: 0 and "no ceiling" are the same
  // number here and very different intentions, and every zone written before
  // 2026-09 carries NULL. Blank is what makes the field read as unanswered.
  const [areaMax, setAreaMax] = useState<string>(dollarsOrBlank(zone?.area_max_charge_cents));

  // Commercial (HOA) pricing: base + per-unit x units + per-acre x acres.
  const [commBase, setCommBase] = useState<string>(dollarsOrBlank(zone?.commercial_base_cents));
  const [commPerUnit, setCommPerUnit] = useState<string>(
    dollarsOrBlank(zone?.commercial_per_unit_cents),
  );
  const [commPerAcre, setCommPerAcre] = useState<string>(
    dollarsOrBlank(zone?.commercial_per_acre_cents),
  );
  const [commPerStation, setCommPerStation] = useState<string>(
    dollarsOrBlank(zone?.commercial_per_station_cents),
  );

  // Coverage: required. Existing geometry seeds the map; ZIP-only legacy
  // zones start on radius mode and must place a center before saving.
  const initialCoverage = useMemo<CoverageValue>(() => {
    const mode =
      zone?.geo_match_mode && zone.geo_match_mode !== "zip" ? zone.geo_match_mode : "radius";
    return {
      mode,
      polygon: zone?.boundary ?? null,
      centerLat:
        zone?.center_latitude != null
          ? Number(zone.center_latitude)
          : zone?.latitude != null
            ? Number(zone.latitude)
            : null,
      centerLng:
        zone?.center_longitude != null
          ? Number(zone.center_longitude)
          : zone?.longitude != null
            ? Number(zone.longitude)
            : null,
      radiusMeters: zone?.radius_meters ?? 1609,
      driveTimeMinutes: zone?.drive_time_minutes ?? 15,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [coverage, setCoverage] = useState<CoverageValue>(initialCoverage);
  // The map reports its (normalized) value once on mount; only edits after
  // that mark the form dirty, so closing an untouched drawer never asks
  // about discarding.
  const coverageRef = useRef<CoverageValue | null>(null);
  const handleCoverage = (v: CoverageValue) => {
    if (coverageRef.current && JSON.stringify(v) !== JSON.stringify(coverageRef.current)) {
      setDirty(true);
    }
    coverageRef.current = v;
    setCoverage(v);
  };
  const [focusPoint, setFocusPoint] = useState<{ lat: number; lng: number } | null>(null);
  const [geocodedZip, setGeocodedZip] = useState<string | null>(null);

  // Center the map on the first typed ZIP when no coverage is placed yet
  // (G5: "map centering on ZIP entry").
  const geocodeMut = useMutation({
    mutationFn: (postalCode: string) => geocodeFn({ data: { postalCode } }),
    onSuccess: (res: any, postalCode) => {
      setGeocodedZip(postalCode);
      if (res?.point) setFocusPoint({ lat: res.point.latitude, lng: res.point.longitude });
    },
  });
  const handleZips = (next: string[]) => {
    setDirty(true);
    setZips(next);
    const first = next[0];
    const hasPlacement =
      coverage.mode === "polygon"
        ? !!coverage.polygon
        : coverage.centerLat != null && coverage.centerLng != null;
    if (first && !hasPlacement && first !== geocodedZip && !geocodeMut.isPending) {
      geocodeMut.mutate(first);
    }
  };

  const trimmedName = name.trim();
  const nameOk = trimmedName.length >= 2 && /[A-Za-z]/.test(trimmedName);
  const coverageOk =
    coverage.mode === "polygon"
      ? !!coverage.polygon
      : coverage.centerLat != null &&
        coverage.centerLng != null &&
        (coverage.mode === "radius" ? !!coverage.radiusMeters : !!coverage.driveTimeMinutes);
  // A zone whose ZIPs cannot match anything is not savable — the server
  // refuses the same list, so failing here names the chip instead of the
  // request. Only chips carried in from an older row can be in this state;
  // nothing typed into the field gets here.
  const zipsOk = zips.every((z) => normalizeUsZip(z) === z);
  const canSave = nameOk && coverageOk && zipsOk;

  const saveMut = useMutation({
    mutationFn: () => {
      const payload: any = {
        name: trimmedName,
        zipCodes: zips,
        postalPrefix: zone?.postal_prefix ?? undefined,
        accountType: zoneType === "all" ? null : zoneType,
        priceNote: priceNote || null,
        priority: parseInt(priority, 10) || 0,
        basePriceCents: Math.round((parseFloat(basePrice) || 0) * 100),
        perDogAddlCents: Math.round((parseFloat(perDog) || 0) * 100),
        initialCleanupCents: Math.round((parseFloat(initialCleanup) || 0) * 100),
        pricingMode,
        pricePerSqftCents: parseFloat(perSqft) > 0 ? parseFloat(perSqft) * 100 : 0,
        pricePerAcreCents: Math.round((parseFloat(perAcre) || 0) * 100),
        areaMinChargeCents: Math.round((parseFloat(areaMin) || 0) * 100),
        areaMaxChargeCents: areaMax.trim() ? Math.round(parseFloat(areaMax) * 100) : null,
        commercialBaseCents: centsOrNull(commBase),
        commercialPerUnitCents: centsOrNull(commPerUnit),
        commercialPerAcreCents: centsOrNull(commPerAcre),
        commercialPerStationCents: centsOrNull(commPerStation),
        geoMatchMode: coverage.mode,
        boundary: coverage.mode === "polygon" ? coverage.polygon : null,
        centerLatitude: coverage.centerLat,
        centerLongitude: coverage.centerLng,
        radiusMeters: coverage.radiusMeters,
        driveTimeMinutes: coverage.driveTimeMinutes,
      };
      return isNew ? createFn({ data: payload }) : updateFn({ data: { ...payload, id: zone.id } });
    },
    onSuccess: (res: any) => {
      toast.success(
        reassignedToastMsg(isNew ? "Zone created" : "Zone saved", res?.propertiesUpdated),
      );
      qc.invalidateQueries({ queryKey: ["zones"] });
      setDirty(false);
      onClose();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const showResidential = zoneType !== "commercial";
  const showCommercial = zoneType !== "residential";

  return (
    <EditDrawer
      open={open}
      onClose={onClose}
      title={isNew ? "New zone" : `Edit ${zone.name}`}
      description="Coverage, priority, and pricing for this service area."
      size="lg"
      dirty={dirty}
    >
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave && !saveMut.isPending) saveMut.mutate();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="zone-name">Zone name</Label>
            <Input
              id="zone-name"
              value={name}
              onChange={(e) => mark(setName)(e.target.value)}
              placeholder="Central Austin"
              required
            />
            {name.length > 0 && !nameOk && (
              <p className="text-xs text-destructive">
                Zone name must include letters, not just numbers.
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="zone-note">Internal note (optional)</Label>
            <Input
              id="zone-note"
              value={priceNote}
              onChange={(e) => mark(setPriceNote)(e.target.value)}
              placeholder="Weekday only, gate codes"
            />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="zone-type">Zone type</Label>
            <select
              id="zone-type"
              value={zoneType}
              onChange={(e) => mark(setZoneType)(e.target.value as ZoneType)}
              className="h-10 w-full rounded-md border bg-background px-2 text-sm"
            >
              <option value="all">All accounts</option>
              <option value="residential">Residential</option>
              <option value="commercial">Commercial</option>
            </select>
            <p className="text-xs text-muted-foreground">
              When zones overlap, a property prefers a zone typed for its account.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="zone-priority">Priority</Label>
            <Input
              id="zone-priority"
              type="number"
              inputMode="numeric"
              className="w-32"
              value={priority}
              onChange={(e) => mark(setPriority)(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              When zones overlap at the same match level, the higher priority wins.
            </p>
          </div>
        </div>

        <div className="space-y-2">
          <Label>ZIP codes served (US)</Label>
          <ZipChips value={zips} onChange={handleZips} describedBy="zone-zips-help" />
          <p id="zone-zips-help" className="text-xs text-muted-foreground">
            US 5-digit ZIPs only. Type one and press Enter, comma, or space, or paste a list to bulk
            add. A ZIP+4 keeps its first five digits, and four digits are read as a ZIP whose
            leading zero was lost (1810 becomes 01810). An address in a listed ZIP always beats
            another zone's radius.
          </p>
        </div>

        <div className="space-y-2">
          <SectionLabel>Map coverage (required)</SectionLabel>
          <p className="text-xs text-muted-foreground">
            Draw a polygon or set a center with a radius or drive time. Typing a ZIP above centers
            the map for you.
          </p>
          <ZoneCoverageMap
            initial={initialCoverage}
            onChange={handleCoverage}
            focusPoint={focusPoint}
            height={300}
          />
          {!coverageOk && (
            <p className="text-xs text-destructive">
              Map coverage is required. Click the map to place the center or draw a polygon.
            </p>
          )}
        </div>

        {showResidential && (
          <div className="space-y-3">
            <SectionLabel>Residential pricing</SectionLabel>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="zone-bp">Base price / visit</Label>
                <MoneyInput id="zone-bp" value={basePrice} onChange={mark(setBasePrice)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="zone-pd">Each additional dog</Label>
                <MoneyInput id="zone-pd" value={perDog} onChange={mark(setPerDog)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="zone-ic">Initial cleanup fee</Label>
                <MoneyInput
                  id="zone-ic"
                  value={initialCleanup}
                  onChange={mark(setInitialCleanup)}
                />
                <p className="text-xs text-muted-foreground">
                  Charged when First cleanup on the Zones page is set to Flat price.
                </p>
              </div>
            </div>

            <div className="space-y-2 rounded-md border bg-muted/20 p-3">
              <div className="flex items-center justify-between gap-3">
                <Label className="text-sm font-medium">Pricing mode</Label>
                <select
                  value={pricingMode}
                  onChange={(e) => mark(setPricingMode)(e.target.value as any)}
                  className="h-9 rounded-md border bg-background px-2 text-sm"
                >
                  <option value="flat">Flat rate (use base price above)</option>
                  <option value="per_sqft">Per square foot of yard</option>
                  <option value="per_acre">Per acre of yard</option>
                </select>
              </div>
              {pricingMode !== "flat" && (
                <>
                  <p className="text-xs text-muted-foreground">
                    When the property has a sketched boundary, per-visit price = area x rate +
                    per-dog add-ons, then applies frequency multiplier. Falls back to base price
                    when no boundary is set.
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {pricingMode === "per_sqft" ? (
                      <div className="space-y-1">
                        <Label className="text-xs">Rate per sq ft (cents)</Label>
                        <Input
                          inputMode="decimal"
                          value={perSqft}
                          onChange={(e) => mark(setPerSqft)(e.target.value)}
                          placeholder="0.75"
                        />
                      </div>
                    ) : (
                      <div className="space-y-1">
                        <Label className="text-xs">Rate per acre ($)</Label>
                        <Input
                          inputMode="decimal"
                          value={perAcre}
                          onChange={(e) => mark(setPerAcre)(e.target.value)}
                          placeholder="300.00"
                        />
                      </div>
                    )}
                    <div className="space-y-1">
                      <Label className="text-xs">Minimum charge / visit ($)</Label>
                      <Input
                        inputMode="decimal"
                        value={areaMin}
                        onChange={(e) => mark(setAreaMin)(e.target.value)}
                        placeholder="25.00"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Maximum charge / visit ($)</Label>
                      <Input
                        inputMode="decimal"
                        value={areaMax}
                        onChange={(e) => mark(setAreaMax)(e.target.value)}
                        placeholder="60.00"
                      />
                      <p className="text-xs text-muted-foreground">
                        Required. The rate above times a big enough yard has no upper bound of its
                        own. This is the most the area part of a quote can ever reach.
                      </p>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {showCommercial && (
          <div className="space-y-3">
            <SectionLabel>Commercial pricing</SectionLabel>
            <p className="text-xs text-muted-foreground">
              For HOA and commercial properties: per-visit price = base + per-unit x units +
              per-acre x grounds acreage + per-station x waste stations, then the frequency
              multiplier.
              {zoneType === "all"
                ? " Leave blank if this zone doesn't serve commercial accounts."
                : ""}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label className="text-xs">Base / visit</Label>
                <MoneyInput value={commBase} onChange={mark(setCommBase)} placeholder="100.00" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Per unit</Label>
                <MoneyInput
                  value={commPerUnit}
                  onChange={mark(setCommPerUnit)}
                  placeholder="3.50"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Per acre</Label>
                <MoneyInput
                  value={commPerAcre}
                  onChange={mark(setCommPerAcre)}
                  placeholder="40.00"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Per waste station</Label>
                <MoneyInput
                  value={commPerStation}
                  onChange={mark(setCommPerStation)}
                  placeholder="8.00"
                />
              </div>
            </div>
          </div>
        )}

        <DrawerFooter>
          <Button type="submit" disabled={!canSave || saveMut.isPending}>
            {saveMut.isPending ? "Saving…" : isNew ? "Create zone" : "Save changes"}
          </Button>
        </DrawerFooter>
      </form>
    </EditDrawer>
  );
}
