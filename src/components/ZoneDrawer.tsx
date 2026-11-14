// Zone create/edit drawer (QA round 3, C5/G5): the Zones page used inline
// cards with a ZIP-only creation form. This drawer follows the app-wide
// EditDrawer pattern and carries everything a zone needs up front: name,
// residential/commercial type, ZIPs, REQUIRED map coverage
// (centered on the first typed ZIP), residential pricing, and commercial
// rates. Server-side validation in zones.functions.ts mirrors every rule.
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Plus, X } from "lucide-react";
import {
  createZone,
  updateZone,
  listZones,
  zipsInZoneShape,
  geocodePostal,
  getNewZoneCenter,
  splitZipInput,
  parseUsZips,
  normalizeUsZip,
  rejectedZipMessage,
} from "@/lib/zones.functions";
import { EditDrawer, DrawerFooter } from "@/components/client-detail/EditDrawer";
import { SectionLabel } from "@/components/client-detail/primitives";
import { ZoneCoverageMap, type CoverageValue } from "@/components/ZoneCoverageMap";
import { Badge } from "@/components/ui/badge";
import { getStandardPricing } from "@/lib/subscriptions.functions";
import { standardPriceLine } from "@/lib/standard-price";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ZoneEnabledSwitch } from "@/components/ZoneEnabledSwitch";
import { offZoneNotice } from "@/lib/zone-enabled";
import { useCommercialAccounts, useServiceLines } from "@/components/CommercialOnly";
import { showsZoneVisitPrice } from "@/lib/service-lines";
import {
  addTyped,
  applyShapeFill,
  baselineFill,
  claimedElsewhere,
  initialZipState,
  isBaselineLookup,
  removeZips,
  shapeKey,
  fillStatusText,
  IDLE_FILL,
  type FillView,
  type ZipListState,
} from "@/lib/zone-zip-fill";

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
//
// What the drawer adds (2026-10-01, "a zone you drew named no ZIPs"): chips
// can be many -- a fill from a 20-mile circle is a few hundred -- so past
// COLLAPSE_AFTER they fold behind "N ZIPs · show all"; a chip another zone
// already lists is drawn amber and named below the box; and every remove
// button is a 44px target on touch, because a fill is exactly when somebody
// prunes a list with a thumb.
const COLLAPSE_AFTER = 16;

function ZipChips({
  value,
  onAdd,
  onRemove,
  claimed,
  placeholder,
  describedBy,
}: {
  value: string[];
  onAdd: (zips: string[]) => void;
  onRemove: (zips: string[]) => void;
  /** ZIP -> the other zone that already lists it. */
  claimed?: Map<string, string>;
  placeholder?: string;
  describedBy?: string;
}) {
  const [buf, setBuf] = useState("");
  const [rejected, setRejected] = useState<string[]>([]);
  const [expanded, setExpanded] = useState(false);

  const commit = (raw: string) => {
    const { zips, rejected: bad } = parseUsZips(splitZipInput(raw));
    setRejected(bad);
    const fresh = zips.filter((z) => !value.includes(z));
    if (fresh.length) onAdd(fresh);
    // Whatever could not be read goes back in the box; everything else clears.
    setBuf(bad.join(" "));
  };

  // Legacy chips: anything that is not already its own normalized form.
  const stale = value.filter((z) => normalizeUsZip(z) !== z);
  const collapsed = !expanded && value.length > COLLAPSE_AFTER;
  // A chip that blocks saving is never folded away out of sight.
  const shown = collapsed
    ? Array.from(new Set([...value.slice(0, COLLAPSE_AFTER), ...stale]))
    : value;

  return (
    <div className="space-y-1">
      <div className="flex min-h-[44px] flex-wrap items-center gap-1.5 rounded-md border bg-background p-2">
        {shown.map((z) => {
          const bad = normalizeUsZip(z) !== z;
          const other = claimed?.get(z);
          return (
            <Badge
              key={z}
              variant={bad ? "destructive" : "secondary"}
              className={
                "gap-1 pr-0.5" +
                (other && !bad
                  ? " border-amber-400 bg-amber-50 text-amber-900 dark:border-amber-500/60 dark:bg-amber-950/40 dark:text-amber-200"
                  : "")
              }
              title={
                bad
                  ? "Not a US 5-digit ZIP, so this matches no address"
                  : other
                    ? `Also listed on ${other}`
                    : undefined
              }
              data-zip-chip={z}
            >
              {z}
              <button
                type="button"
                className="inline-flex items-center justify-center rounded-full p-0.5 hover:bg-muted-foreground/20 touch:min-h-11 touch:min-w-11"
                onClick={() => onRemove([z])}
                aria-label={`Remove ${z}`}
              >
                <X className="h-3 w-3 shrink-0" />
              </button>
            </Badge>
          );
        })}
        {value.length > COLLAPSE_AFTER && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2"
            aria-expanded={!collapsed}
            onClick={() => setExpanded((v) => !v)}
          >
            {collapsed ? `${value.length} ZIPs · show all` : "Show fewer"}
          </Button>
        )}
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
              onRemove([value[value.length - 1]]);
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
  fillOnOpen = false,
  activeClientsKnown = true,
}: {
  open: boolean;
  onClose: () => void;
  /** Null/undefined = create a new zone. */
  zone?: any | null;
  /** Opened from a zone card's "Fill ZIPs from the area": run that fill as
   *  soon as the zone's area is looked up. The owner asked for it; the save
   *  is still theirs. */
  fillOnOpen?: boolean;
  /** From listZones: false when active client counts could not be read. */
  activeClientsKnown?: boolean;
}) {
  const isNew = !zone;
  const getCenter = useServerFn(getNewZoneCenter);
  const { data: openingCenter } = useQuery({
    queryKey: ["new-zone-center"],
    queryFn: () => getCenter(),
    enabled: open && isNew,
    staleTime: 60_000,
  });
  // The switch saves on its own (#449); this only keeps the drawer's copy of
  // the status current while it stays open.
  const [enabledNow, setEnabledNow] = useState<boolean>(zone?.enabled !== false);
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
  const [suggestedName, setSuggestedName] = useState<string | null>(null);
  const [priceNote, setPriceNote] = useState<string>(zone?.price_note ?? "");
  // A NEW zone defaults to the kind of work this business actually does.
  // It used to default to "all", which meant every operator — including one
  // with forty driveways and no HOAs — was shown a commercial pricing block
  // (base + per unit + per acre + per station) before they had typed a name.
  // An EXISTING zone always shows what it is; this only chooses the default
  // for a zone being created.
  const { enabled: commercialEnabled } = useCommercialAccounts();
  // Per-sq-ft and per-acre pricing price the YARD, which only a pet-waste
  // business measures. Hidden from one that does not run pet waste, unless
  // this zone already prices that way -- then it is what the zone charges and
  // has to stay editable (PET_WASTE_MODULES.area_pricing).
  const { petWaste } = useServiceLines();
  const showAreaPricing = petWaste || (zone?.pricing_mode ?? "flat") !== "flat";
  // The zone's first-cleanup fee, on the same terms: shown while it holds a
  // price. Hidden, the drawer still saves the loaded value back unchanged.
  const showInitialCleanup = petWaste || Number(zone?.initial_cleanup_cents ?? 0) > 0;
  // A zone's per-visit price and per-dog charge are what a SCOOPING plan is
  // quoted from (R2-38). A walk, a sit, a groom or a lesson is priced from
  // its own service, so a business that runs no pet waste was asked "Base
  // price / visit" and "Each additional dog" for numbers nothing reads. They
  // are shown while the zone prices a yard some other way (area pricing, a
  // first-cleanup fee); hidden, the drawer saves the loaded values back.
  const { lines } = useServiceLines();
  const showVisitPricing = showsZoneVisitPrice(lines, zone ?? null);
  const [zoneType, setZoneType] = useState<ZoneType>(
    (zone?.account_type as ZoneType) ?? (commercialEnabled ? "all" : "residential"),
  );
  const [zipState, setZipState] = useState<ZipListState>(() => initialZipState(zone?.zip_codes));
  const zips = zipState.zips;

  // Residential pricing (#860). The standard price is the service's, set in
  // Settings → Services. A zone's own price is an OVERRIDE: blank means this
  // zone charges the standard price, so a new zone starts blank rather than
  // with a copy of the standard (a copy would stop following it). Shown beside
  // the field as "Standard: $X" so nobody has to guess which price applies.
  const [basePrice, setBasePrice] = useState<string>(
    zone && zone.base_price_cents != null ? (zone.base_price_cents / 100).toFixed(2) : "",
  );
  const [perDog, setPerDog] = useState<string>(
    zone && zone.base_price_cents != null ? ((zone.per_dog_addl_cents ?? 0) / 100).toFixed(2) : "",
  );
  const stdFn = useServerFn(getStandardPricing);
  const stdQ = useQuery({
    queryKey: ["std-pricing"],
    queryFn: () => stdFn(),
    staleTime: 60_000,
  });
  const std = stdQ.data;

  // An existing zone that uses a note or a non-default type shows them;
  // anything else starts with them folded away. (The zone's rank in the
  // business's list is set on Settings > Zones & pricing since #858, not typed here.)
  const [moreOpen, setMoreOpen] = useState<boolean>(
    !!zone &&
      (!!zone.price_note ||
        // Typed other than a new zone here would be: worth seeing.
        (zone.account_type ?? "all") !== (commercialEnabled ? "all" : "residential")),
  );
  const showMore = moreOpen || !!priceNote;
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
      if (res?.point) {
        // The map seeds a circle around it: a shape nobody drew (R2-38).
        autoPlacedPending.current = true;
        setFocusPoint({ lat: res.point.latitude, lng: res.point.longitude });
      }
      // A new zone with no name yet is offered the town its first ZIP is in.
      // Typed into the box, so it is plainly a suggestion and one edit away.
      if (isNew && res?.place && !name.trim()) {
        setName(String(res.place));
        setSuggestedName(String(res.place));
      }
    },
  });
  const handleAddZips = (added: string[]) => {
    setDirty(true);
    setZipState((st) => addTyped(st, added));
    const first = zips[0] ?? added[0];
    const hasPlacement =
      coverage.mode === "polygon"
        ? !!coverage.polygon
        : coverage.centerLat != null && coverage.centerLng != null;
    if (first && !hasPlacement && first !== geocodedZip && !geocodeMut.isPending) {
      geocodeMut.mutate(first);
    }
  };
  const handleRemoveZips = (gone: string[]) => {
    setDirty(true);
    setZipState((st) => removeZips(st, gone));
  };

  // ── Filling the ZIP list from the drawn area ──────────────────────────
  //
  // Owner, 2026-10-01: drawing a radius, drive time or polygon "does not auto
  // insert all the zip codes that are within that". Now it does: every change
  // to the shape looks up the ZIPs whose centers are inside it (the matcher's
  // own geometry, see src/lib/zone-zip-fill.ts) and merges them in -- adding
  // the new ones, dropping ZIPs only the OLD shape held, never touching one
  // the owner typed or a chip they removed.
  //
  // An EXISTING zone is not filled on open. Its area is looked up so the
  // drawer can say what is missing and offer "Fill ZIPs from the area", but
  // the list only changes when the owner moves the shape or clicks.
  const zipsFn = useServerFn(zipsInZoneShape);
  const listZonesFn = useServerFn(listZones);
  // Same key as the Zones page, so this is the page's own cached list.
  const zonesQ = useQuery({ queryKey: ["zones"], queryFn: () => listZonesFn() });
  const claimed = useMemo(
    () => claimedElsewhere(zips, (zonesQ.data as any)?.zones ?? [], zone?.id ?? null),
    [zips, zonesQ.data, zone?.id],
  );

  // The fill reads the list as it stands when its answer arrives, not as it
  // stood when the lookup started -- the owner may have typed in between.
  const zipStateRef = useRef(zipState);
  zipStateRef.current = zipState;
  const [fill, setFill] = useState<FillView>(IDLE_FILL);
  const initialKey = useMemo(() => shapeKey(initialCoverage), [initialCoverage]);
  const baselinePending = useRef(!isNew && initialKey != null);
  // Set when the map is handed a typed ZIP's center to seed a circle from.
  const autoPlacedPending = useRef(false);
  const fillOnOpenPending = useRef(fillOnOpen);
  const lastKey = useRef<string | null>(null);
  const seq = useRef(0);
  const key = shapeKey(coverage);

  useEffect(() => {
    if (!key || key === lastKey.current) return;
    lastKey.current = key;
    const mine = ++seq.current;
    // A shape nobody drew adds no ZIPs (R2-38). Two such shapes: the first
    // one an existing zone reports, whatever its key, and the circle the map
    // seeds around a typed ZIP's center (autoPlacedPending, below). A 4-ZIP
    // zone was handed the ZIPs inside a default 1-mile circle around the
    // first one, silently, and Save re-assigned 39 properties. Either is a
    // baseline: the drawer says what the area holds and offers "Fill ZIPs
    // from the area". The owner's own move of the shape still adds.
    const firstOfExisting = baselinePending.current;
    const isBaseline = isBaselineLookup({
      existingZoneFirstLookup: firstOfExisting,
      autoPlaced: autoPlacedPending.current,
    });
    setFill((f) => ({ ...f, status: "loading" }));
    // The radius slider reports every step; wait for the hand to stop.
    const t = setTimeout(async () => {
      try {
        const res: any = await zipsFn({
          data: {
            mode: coverage.mode,
            polygon: coverage.polygon,
            centerLat: coverage.centerLat,
            centerLng: coverage.centerLng,
            radiusMeters: coverage.radiusMeters,
            driveTimeMinutes: coverage.driveTimeMinutes,
          } as any,
        });
        if (mine !== seq.current) return;
        const inside: string[] = res?.inside ?? [];
        // Computed from the state as it stands, then set, so the counts shown
        // are the counts applied.
        let next = zipStateRef.current;
        let added = 0;
        let removed = 0;
        baselinePending.current = false;
        autoPlacedPending.current = false;
        if (isBaseline) {
          // An existing zone's list is sorted into "from the shape" and
          // "typed" against its own area. A seeded circle leaves what the
          // owner typed as typed: it only offers the rest.
          if (firstOfExisting) next = baselineFill(next, inside).state;
          if (fillOnOpenPending.current) {
            fillOnOpenPending.current = false;
            const r = applyShapeFill(next, inside, { explicit: true });
            next = r.state;
            added = r.added.length;
          }
        } else {
          const r = applyShapeFill(next, inside);
          next = r.state;
          added = r.added.length;
          removed = r.removed.length;
        }
        setZipState(next);
        if (added || removed) setDirty(true);
        setFill({
          status: "done",
          inside,
          insideTotal: res?.insideTotal ?? inside.length,
          edge: res?.edge ?? [],
          added,
          removed,
          candidatesCapped: !!res?.candidatesCapped,
          tooLarge: !!res?.tooLarge,
          baseline: isBaseline && !added,
        });
      } catch {
        if (mine !== seq.current) return;
        setFill((f) => ({ ...f, status: "error" }));
      }
    }, 450);
    return () => {
      clearTimeout(t);
      // A lookup cancelled before it started must be able to run again for
      // this same shape.
      if (mine === seq.current && lastKey.current === key) lastKey.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const missingFromArea = fill.inside.filter((z) => !zips.includes(z));
  const edgeOffered = fill.edge.filter((z) => !zips.includes(z));
  const fillFromArea = () => {
    const r = applyShapeFill(zipState, fill.inside, { explicit: true });
    setZipState(r.state);
    setDirty(true);
    setFill((f) => ({ ...f, added: r.added.length, removed: r.removed.length, baseline: false }));
  };
  const areaWord =
    coverage.mode === "polygon"
      ? "the area you drew"
      : coverage.mode === "drive_time"
        ? "the drive-time circle"
        : "the circle";
  const claimedList = Array.from(claimed.entries());
  // Grouped by the zone that already lists them: one long zone name, said once.
  const claimedByZone = Array.from(
    claimedList.reduce((m, [zip, zoneName]) => {
      m.set(zoneName, [...(m.get(zoneName) ?? []), zip]);
      return m;
    }, new Map<string, string[]>()),
  );

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
        zipCodes: zipState.zips,
        postalPrefix: zone?.postal_prefix ?? undefined,
        accountType: zoneType === "all" ? null : zoneType,
        priceNote: priceNote || null,
        // Chips the owner removed during this edit: the server's save-time
        // fill (#858) leaves them out rather than putting them back.
        zipCodesRemoved: zipState.dismissed,
        // Blank is "no override: charge the standard price" (#860).
        basePriceCents: basePrice.trim() ? Math.round((parseFloat(basePrice) || 0) * 100) : null,
        perDogAddlCents: basePrice.trim() ? Math.round((parseFloat(perDog) || 0) * 100) : null,
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
      // A pet-waste business's setup price step is a zone (R2-47).
      qc.invalidateQueries({ queryKey: ["onboarding-status"] });
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
      description="Coverage, ZIPs and pricing for this service area."
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
        {!isNew && (
          <div className="space-y-1 rounded-md border p-3">
            <div className="flex flex-wrap items-center justify-between gap-x-3">
              <span className="text-sm font-medium">Zone status</span>
              <ZoneEnabledSwitch
                zone={{ ...zone, enabled: enabledNow }}
                activeClientsKnown={activeClientsKnown}
                onChanged={setEnabledNow}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {enabledNow
                ? "On. This zone is used for new addresses, the signup page and the lead form."
                : offZoneNotice(zone.active_clients ?? 0)}{" "}
              The switch saves right away.
            </p>
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor="zone-name">Zone name</Label>
          <Input
            id="zone-name"
            value={name}
            onChange={(e) => {
              mark(setName)(e.target.value);
              setSuggestedName(null);
            }}
            placeholder="Central Austin"
            required
          />
          {suggestedName && name === suggestedName && (
            <p className="text-xs text-muted-foreground">
              Suggested from the first ZIP you typed. Change it to anything.
            </p>
          )}
          {name.length > 0 && !nameOk && (
            <p className="text-xs text-destructive">
              Zone name must include letters, not just numbers.
            </p>
          )}
        </div>

        {/* Note and type: each has a sensible default and most zones never
            change one, so on a NEW zone they wait behind one button. A zone
            that already uses either opens with them showing. */}
        {showMore ? (
          <>
            <div className="space-y-2">
              <Label htmlFor="zone-note">Internal note (optional)</Label>
              <Input
                id="zone-note"
                value={priceNote}
                onChange={(e) => mark(setPriceNote)(e.target.value)}
                placeholder="Weekday only, gate codes"
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="zone-type">Zone type</Label>
                <select
                  id="zone-type"
                  value={zoneType}
                  onChange={(e) => mark(setZoneType)(e.target.value as ZoneType)}
                  className="h-10 w-full rounded-md border bg-background px-2 text-sm touch:min-h-11"
                >
                  <option value="all">All accounts</option>
                  <option value="residential">Residential</option>
                  <option value="commercial">Commercial</option>
                </select>
                <p className="text-xs text-muted-foreground">
                  When zones overlap, a property prefers a zone typed for its account.
                </p>
              </div>
              <p className="text-xs text-muted-foreground sm:self-end" data-testid="zone-rank-note">
                {isNew
                  ? "A new zone starts at the bottom of the ranking. Move it up on the Zones & pricing page."
                  : "Which zone wins a ZIP both list is set by the ranking on the Zones & pricing page."}
              </p>
            </div>
          </>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-expanded={false}
            onClick={() => setMoreOpen(true)}
          >
            <Plus className="mr-1 h-3.5 w-3.5 shrink-0" /> Note and zone type
          </Button>
        )}

        {/* The map and the ZIP list it fills are one step, so on a laptop they
            sit side by side: the drawer is 896px wide there, and stacked, a
            300px map pushed the ZIPs below the fold at 1280x800 under copy
            that said they "fill in below". A phone stacks them. */}
        <div className="space-y-5 lg:grid lg:grid-cols-2 lg:gap-5 lg:space-y-0">
          <div className="space-y-2">
            <SectionLabel>Map coverage (required)</SectionLabel>
            <p className="text-xs text-muted-foreground">
              Draw a polygon or set a center with a radius or drive time. The ZIPs inside it fill in
              the list.
            </p>
            <ZoneCoverageMap
              initial={initialCoverage}
              openingCenter={isNew ? openingCenter : null}
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

          <div className="space-y-2" data-testid="zone-zips">
            <Label>ZIP codes served (US)</Label>
            <ZipChips
              value={zips}
              onAdd={handleAddZips}
              onRemove={handleRemoveZips}
              claimed={claimed}
              describedBy="zone-zips-help"
            />
            <p
              className="text-xs text-muted-foreground"
              aria-live="polite"
              data-testid="zone-zip-fill-status"
            >
              {fillStatusText(fill, areaWord)}
            </p>
            {fill.status === "done" && missingFromArea.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed p-2 text-xs">
                <span className="min-w-0 flex-1 text-muted-foreground">
                  {missingFromArea.length} {missingFromArea.length === 1 ? "ZIP" : "ZIPs"} inside{" "}
                  {areaWord} {missingFromArea.length === 1 ? "is" : "are"} not on the list.
                </span>
                <Button type="button" size="sm" variant="outline" onClick={fillFromArea}>
                  Fill ZIPs from the area
                </Button>
              </div>
            )}
            {claimedList.length > 0 && (
              <div
                className="space-y-1 text-xs text-amber-700 dark:text-amber-300"
                data-testid="zone-zip-overlap"
              >
                {claimedByZone.map(([zoneName, list]) => (
                  <p key={zoneName} className="break-words">
                    {list.length === 1 ? "1 ZIP is" : `${list.length} ZIPs are`} also listed on{" "}
                    <span className="font-medium">{zoneName}</span>: {list.slice(0, 12).join(", ")}
                    {list.length > 12 ? `, and ${list.length - 12} more` : ""}.
                  </p>
                ))}
                <p>
                  An address in a ZIP two zones list goes to the one ranked higher on the Zones
                  &amp; pricing page. Remove the chip here to leave it to the other zone.
                </p>
              </div>
            )}
            {fill.status === "done" && edgeOffered.length > 0 && (
              <div className="space-y-1.5 rounded-md bg-muted/40 p-2" data-testid="zone-zip-edge">
                <p className="text-xs font-medium">Nearby ZIPs that only partly overlap</p>
                <p className="text-xs text-muted-foreground">
                  Not added for you, because a listed ZIP claims every address in it, including the
                  part outside {areaWord}. Tap one to add it anyway.
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {edgeOffered.slice(0, 40).map((z) => (
                    <Button
                      key={z}
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 tabular-nums"
                      aria-label={`Add ${z}`}
                      onClick={() => handleAddZips([z])}
                    >
                      + {z}
                    </Button>
                  ))}
                </div>
              </div>
            )}
            <p id="zone-zips-help" className="text-xs text-muted-foreground">
              US 5-digit ZIPs only. Type one and press Enter, or paste a list. A ZIP+4 keeps its
              first five digits, and four digits are read as a ZIP whose leading zero was lost (1810
              becomes 01810). An address in a listed ZIP always beats another zone's radius.
            </p>
          </div>
        </div>

        {showResidential && !showVisitPricing && (
          <p className="text-sm text-muted-foreground" data-zone-priced-by-service>
            Your services are priced in Settings, Services. This zone says where you work.
          </p>
        )}
        {showResidential && showVisitPricing && (
          <div className="space-y-3">
            <SectionLabel>Residential pricing</SectionLabel>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="zone-bp">Zone price / visit</Label>
                <MoneyInput
                  id="zone-bp"
                  value={basePrice}
                  onChange={mark(setBasePrice)}
                  placeholder={
                    std?.basePriceCents != null ? (std.basePriceCents / 100).toFixed(2) : undefined
                  }
                />
                <p className="text-xs text-muted-foreground" data-testid="zone-standard-line">
                  {standardPriceLine(std ? std.basePriceCents : null)}.{" "}
                  {basePrice.trim()
                    ? "This price applies only inside this zone."
                    : "Blank: this zone charges the standard price."}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="zone-pd">Each additional dog</Label>
                <MoneyInput
                  id="zone-pd"
                  value={perDog}
                  onChange={mark(setPerDog)}
                  placeholder={
                    std?.perDogAddlCents != null
                      ? (std.perDogAddlCents / 100).toFixed(2)
                      : undefined
                  }
                />
                {!basePrice.trim() && (
                  <p className="text-xs text-muted-foreground">
                    Used with a zone price. Without one, the standard extra-dog price applies.
                  </p>
                )}
              </div>
              {showInitialCleanup && (
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
              )}
            </div>

            {showAreaPricing && (
              <div className="space-y-2 rounded-md border bg-muted/20 p-3">
                {/* Label above, select full width (Product visual review): beside
                    the label, the long Flat rate option ran past the drawer at 390
                    and 768. A native select cannot wrap, so the box takes the whole
                    row and a value still too long ends in an ellipsis inside it. */}
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Label htmlFor="zone-pricing-mode" className="text-sm font-medium">
                    Pricing mode
                  </Label>
                  <select
                    id="zone-pricing-mode"
                    value={pricingMode}
                    onChange={(e) => mark(setPricingMode)(e.target.value as any)}
                    className="h-9 w-full min-w-0 max-w-full truncate rounded-md border bg-background px-2 text-sm touch:min-h-11"
                  >
                    <option value="flat">
                      Flat rate (zone price, or the standard price when blank)
                    </option>
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
            )}
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
