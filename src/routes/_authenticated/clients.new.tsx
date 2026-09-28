import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { lookupAddressPoint } from "@/lib/geocode.functions";
import { useEffect, useMemo, useState } from "react";
import { onboardClient, getInternalQuote } from "@/lib/clients.functions";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupSegment } from "@/components/ui/radio-group";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { BoundarySketch, formatArea, type PolygonGeoJSON } from "@/components/BoundarySketch";
import { AddressAutocomplete, type ResolvedAddress } from "@/components/AddressAutocomplete";
import { Check, ChevronRight, Trash2, Plus } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/clients/new")({
  component: NewClientWizard,
});

type Dog = {
  name: string;
  breed: string;
  weightClass: string;
  temperament: "friendly" | "shy" | "anxious" | "aggressive" | "unknown";
  notes: string;
};

const FREQS = [
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Every 2 weeks" },
  { value: "twice_weekly", label: "Twice weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "one_time", label: "One-time" },
] as const;

const STEPS = ["Contact", "Property", "Yard", "Dogs", "Plan"] as const;

function money(cents: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    (cents ?? 0) / 100,
  );
}

function polyAreaSqm(g: PolygonGeoJSON): number {
  const ring = g.coordinates[0];
  if (!ring || ring.length < 4) return 0;
  const R = 6378137;
  const latMean = (ring.reduce((s, p) => s + p[1], 0) / ring.length) * (Math.PI / 180);
  const cosLat = Math.cos(latMean);
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const x1 = xi * (Math.PI / 180) * R * cosLat;
    const y1 = yi * (Math.PI / 180) * R;
    const x2 = xj * (Math.PI / 180) * R * cosLat;
    const y2 = yj * (Math.PI / 180) * R;
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a / 2);
}



function NewClientWizard() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const onboardFn = useServerFn(onboardClient);
  const quoteFn = useServerFn(getInternalQuote);
  const geocodeFn = useServerFn(lookupAddressPoint);

  const [step, setStep] = useState(0);
  // Turn on inline "required" messages after the user tries to advance —
  // showing red text on first render would be too noisy.
  const [attempted, setAttempted] = useState(false);

  // contact
  const [displayName, setDisplayName] = useState("");
  const [accountType, setAccountType] = useState<"residential" | "commercial">("residential");
  const [primaryEmail, setPrimaryEmail] = useState("");
  const [primaryPhone, setPrimaryPhone] = useState("");

  // property
  const [street, setStreet] = useState("");
  const [city, setCity] = useState("");
  const [region, setRegion] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [gateCode, setGateCode] = useState("");
  const [hazardNotes, setHazardNotes] = useState("");
  // P3.5 optional on-site visit contact (tenant/property manager)
  const [vcName, setVcName] = useState("");
  const [vcPhone, setVcPhone] = useState("");
  const [vcEmail, setVcEmail] = useState("");
  const [hz, setHz] = useState({
    doNotEnterIfDogOut: false,
    aggressiveDog: false,
    escapeRisk: false,
    invisibleFence: false,
    dogInYardDuringService: false,
    beesWasps: false,
    sharpObjects: false,
    slipperySurfaces: false,
  });

  // yard boundary
  const [boundary, setBoundary] = useState<PolygonGeoJSON | null>(null);
  const [geo, setGeo] = useState<{ lat: number; lng: number } | null>(null);
  // Geocode outcome for the Yard step, so a failure surfaces a clear message
  // instead of silently rendering a zoomed-out world map (finding #13).
  const [geoStatus, setGeoStatus] = useState<"idle" | "loading" | "ok" | "notfound" | "error">("idle");
  const boundaryAreaSqm = useMemo(() => (boundary ? polyAreaSqm(boundary) : null), [boundary]);

  // Address entry, same contract as PropertyDrawer: a matched address fills
  // every field at once and brings its own coordinates, and any hand edit
  // afterwards throws those coordinates away.
  //
  // Throwing them away matters more here than it looks. The Yard step's
  // geocode effect is guarded by `if (geo) return;`, so a pin left over from
  // the address the user has just corrected would be the pin they draw a
  // boundary on — for the wrong house, with no way to tell from the map.
  function applyResolvedAddress(r: ResolvedAddress) {
    setStreet(r.address.street);
    setCity(r.address.city);
    if (r.address.region) setRegion(r.address.region);
    setPostalCode(r.address.postalCode);
    if (r.address.latitude != null && r.address.longitude != null) {
      // A provider match is a better pin than the Yard step's Nominatim
      // lookup, and it saves the round trip: the effect there is a fallback
      // for hand-typed addresses now.
      setGeo({ lat: r.address.latitude, lng: r.address.longitude });
      setGeoStatus("ok");
    } else {
      setGeo(null);
      setGeoStatus("idle");
    }
  }
  function setAddressField(set: (v: string) => void, v: string) {
    set(v);
    setGeo(null);
    setGeoStatus("idle");
  }

  // Best-effort geocode when entering the Yard step
  useEffect(() => {
    if (step !== 2) return;
    if (geo) return;
    const q = [street, city, region, postalCode].filter(Boolean).join(", ");
    if (q.length < 6) {
      setGeoStatus("notfound");
      return;
    }
    // A `cancelled` flag rather than an AbortController: a server function
    // takes no signal, so the guard this needs is against a STALE result
    // landing after the address changed, which is what the abort was doing
    // here anyway.
    let cancelled = false;
    setGeoStatus("loading");
    (async () => {
      try {
        const { geo: g } = await geocodeFn({ data: { query: q } });
        if (cancelled) return;
        if (g) {
          setGeo({ lat: g.latitude, lng: g.longitude });
          setGeoStatus("ok");
        } else {
          setGeoStatus("notfound");
        }
      } catch {
        if (cancelled) return;
        setGeoStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [step, street, city, region, postalCode, geo, geocodeFn]);

  // dogs
  const [dogs, setDogs] = useState<Dog[]>([
    { name: "", breed: "", weightClass: "", temperament: "unknown", notes: "" },
  ]);
  const validDogs = dogs.filter((d) => d.name.trim().length > 0);

  // plan
  const [frequency, setFrequency] = useState<(typeof FREQS)[number]["value"]>("weekly");
  const [billingCadence, setBillingCadence] = useState<"postpaid" | "prepaid">("postpaid");
  const [unitCount, setUnitCount] = useState("1");
  const [priceOverride, setPriceOverride] = useState<string>("");
  const [skipPlan, setSkipPlan] = useState(false);

  // Auto-quote (residential)
  const quoteKey = useMemo(
    () => ({
      postalCode: postalCode.trim(),
      accountType,
      dogCount: Math.max(1, validDogs.length),
      frequency: frequency === "one_time" ? "weekly" : frequency,
      boundaryAreaSqm: boundaryAreaSqm ?? undefined,
    }),
    [postalCode, accountType, validDogs.length, frequency, boundaryAreaSqm],
  );

  const quoteQ = useQuery({
    enabled:
      step === 4 &&
      !skipPlan &&
      accountType === "residential" &&
      quoteKey.postalCode.length >= 3 &&
      frequency !== "one_time",
    queryKey: ["internal-quote", quoteKey],
    queryFn: () => quoteFn({ data: quoteKey as any }),
    staleTime: 30_000,
  });

  const suggestedCents =
    accountType === "residential" && quoteQ.data && "quote" in quoteQ.data
      ? (quoteQ.data as any).quote.recurringPriceCents
      : null;

  const priceCents = (() => {
    const override = parseFloat(priceOverride);
    if (!isNaN(override) && override > 0) return Math.round(override * 100);
    if (suggestedCents != null) return suggestedCents;
    return 2500;
  })();

  const mutation = useMutation({
    mutationFn: () =>
      onboardFn({
        data: {
          displayName,
          accountType,
          primaryEmail: primaryEmail || undefined,
          primaryPhone: primaryPhone || undefined,
          street,
          city,
          region: region || undefined,
          postalCode,
          gateCode: gateCode || undefined,
          hazardNotes: hazardNotes || undefined,
          visitContactName: vcName || undefined,
          visitContactPhone: vcPhone || undefined,
          visitContactEmail: vcEmail || undefined,
          hazards: hz,
          boundary: boundary ?? undefined,
          boundaryAreaSqm: boundaryAreaSqm ?? undefined,
          dogs: validDogs.length
            ? validDogs.map((d) => ({
                name: d.name.trim(),
                breed: d.breed || undefined,
                weightClass: d.weightClass || undefined,
                temperament: d.temperament,
                notes: d.notes || undefined,
              }))
            : undefined,
          subscription: skipPlan
            ? undefined
            : {
                frequency,
                priceCents,
                dogCount: accountType === "residential" ? Math.max(1, validDogs.length) : undefined,
                unitCount:
                  accountType === "commercial" ? Math.max(1, parseInt(unitCount, 10) || 1) : undefined,
                zoneId:
                  quoteQ.data && "quote" in quoteQ.data
                    ? ((quoteQ.data as any).quote.zoneId as string)
                    : undefined,
                billingCadence,
              },
        },
      }),
    onSuccess: ({ id }) => {
      toast.success("Client created");
      qc.invalidateQueries({ queryKey: ["clients"] });
      qc.invalidateQueries({ queryKey: ["my-org"] });
      navigate({ to: "/clients/$clientId", params: { clientId: id } });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const canNext = (() => {
    if (step === 0) return displayName.trim().length > 0;
    // Region/State is required — the property is unusable downstream without it
    // (routing, zone pricing, geocoding all need it). Finding #13.
    if (step === 1) return !!(street && city && region && postalCode);
    if (step === 2) return true; // yard boundary optional
    if (step === 3) return true;
    return true;
  })();

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <Link to="/clients" className="text-sm text-muted-foreground hover:underline">
          ← Clients
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">New client</h1>
      </div>

      {/* Stepper.
          MEASURED 2026-08-19: five numbered chips, their labels and four
          chevrons come to 565px, so at 360px steps 3, 4 and 5 hung off the
          side of the screen and the page scrolled sideways. At 768px step 5
          still did.
          This is the case CLAUDE.md names outright — "wide content … wide
          toolbars — scrolls inside its own `overflow-x: auto` container. The
          page body does not." A stepper is a toolbar: it has a natural width,
          it is read left to right, and squeezing it is worse than scrolling
          it. `shrink-0` on each chip so they scroll at full size rather than
          being compressed into each other, and the dots take the touch floor
          because a completed step is a button you can go back to. */}
      <div className="-mx-1 flex items-center gap-2 overflow-x-auto px-1 text-sm">
        {STEPS.map((label, i) => {
          const state = i < step ? "done" : i === step ? "current" : "todo";
          return (
            <div key={label} className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => i < step && setStep(i)}
                disabled={i > step}
                className={
                  "flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium touch:h-11 touch:w-11 " +
                  (state === "done"
                    ? "bg-primary text-primary-foreground"
                    : state === "current"
                      ? "bg-primary/15 text-primary ring-2 ring-primary"
                      : "bg-muted text-muted-foreground")
                }
              >
                {state === "done" ? <Check className="h-3.5 w-3.5 shrink-0" /> : i + 1}
              </button>
              <span className={state === "current" ? "font-medium" : "text-muted-foreground"}>
                {label}
              </span>
              {i < STEPS.length - 1 && (
                <ChevronRight className="mx-1 h-4 w-4 text-muted-foreground shrink-0" />
              )}
            </div>
          );
        })}
      </div>

      <Card className="p-6">
        {/* STEP 0 — Contact */}
        {step === 0 && (
          <div className="space-y-5">
            <div className="space-y-2">
              {/* MEASURED 2026-08-19: as two radio dots these were 16.0px, the
                  last finding on this page. A radio cannot be grown to 44px —
                  the border is on the element, so height and padding both
                  enlarge the visible circle. Two mutually exclusive options
                  with short labels are a segmented control anyway, and a
                  segment is 44px without argument.
                  Still a Radix radiogroup underneath, so the arrow keys, the
                  single tab stop and the ARIA all survive the change. */}
              <Label id="account-type-label">Account type</Label>
              <RadioGroup
                aria-labelledby="account-type-label"
                value={accountType}
                onValueChange={(v) => setAccountType(v as typeof accountType)}
                className="flex gap-2"
              >
                <RadioGroupSegment value="residential">Residential</RadioGroupSegment>
                <RadioGroupSegment value="commercial">Commercial / HOA</RadioGroupSegment>
              </RadioGroup>
            </div>
            <div className="space-y-2">
              <Label htmlFor="dn">Display name</Label>
              <Input
                id="dn"
                required
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={accountType === "commercial" ? "Oakwood HOA" : "Jane Doe"}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="em">Email</Label>
                <Input id="em" type="email" value={primaryEmail} onChange={(e) => setPrimaryEmail(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ph">Phone</Label>
                <Input id="ph" value={primaryPhone} onChange={(e) => setPrimaryPhone(e.target.value)} placeholder="(555) 123-4567" />
              </div>
            </div>
          </div>
        )}

        {/* STEP 1 — Property */}
        {step === 1 && (
          <div className="space-y-5">
            {attempted && !(street && city && region && postalCode) && (
              <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                Please fill in Street, City, State, and ZIP to continue.
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2 space-y-2">
                <Label htmlFor="st">Street address</Label>
                {/* Autocomplete when a provider is configured, a plain text
                    input when none is — which is the state today. Nothing
                    about the required-field validation below changes either
                    way: it reads `street`, which this writes on every
                    keystroke exactly as the bare <Input> did. */}
                <AddressAutocomplete
                  id="st"
                  required
                  value={street}
                  onChangeText={(t) => setAddressField(setStreet, t)}
                  onResolved={applyResolvedAddress}
                  ariaInvalid={attempted && !street ? true : undefined}
                  className={attempted && !street ? "border-destructive focus-visible:ring-destructive" : undefined}
                />
                {attempted && !street && <p className="text-xs text-destructive">Street address is required.</p>}
              </div>
              <div className="space-y-2">
                <Label htmlFor="ci">City</Label>
                <Input
                  id="ci"
                  required
                  value={city}
                  onChange={(e) => setAddressField(setCity, e.target.value)}
                  aria-invalid={attempted && !city ? true : undefined}
                  className={attempted && !city ? "border-destructive focus-visible:ring-destructive" : undefined}
                />
                {attempted && !city && <p className="text-xs text-destructive">City is required.</p>}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="rg">State/Region</Label>
                  <Input
                    id="rg"
                    required
                    value={region}
                    onChange={(e) => setAddressField(setRegion, e.target.value)}
                    aria-invalid={attempted && !region ? true : undefined}
                    className={attempted && !region ? "border-destructive focus-visible:ring-destructive" : undefined}
                  />
                  {attempted && !region && <p className="text-xs text-destructive">Required.</p>}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="pc">ZIP / Postal</Label>
                  <Input
                    id="pc"
                    required
                    value={postalCode}
                    onChange={(e) => setAddressField(setPostalCode, e.target.value)}
                    aria-invalid={attempted && !postalCode ? true : undefined}
                    className={attempted && !postalCode ? "border-destructive focus-visible:ring-destructive" : undefined}
                  />
                  {attempted && !postalCode && <p className="text-xs text-destructive">Required.</p>}
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="gc">Gate code (optional)</Label>
                <Input id="gc" value={gateCode} onChange={(e) => setGateCode(e.target.value)} />
              </div>
              {/* No yard-size picker. It is derived from the property
                  boundary by a database trigger, and properties.functions.ts
                  says so where it stopped writing the field: "yard_size is
                  derived from the boundary by a DB trigger now; the field is
                  still accepted (older forms send it) but never written."
                  This wizard was the older form. A hand-picked size is worse
                  than none, because the tech reading it in the field cannot
                  tell a guess from a measurement — and nothing here has a
                  boundary to measure yet, since one is drawn afterwards. */}
            </div>

            <div className="rounded-md border bg-muted/20 p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                On-site visit contact <span className="normal-case font-normal">(optional)</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                For rentals/managed properties: this person gets visit texts and emails.
                Invoices still go to the account contact from the previous step.
              </p>
              <div className="mt-2 grid gap-3 sm:grid-cols-3">
                <div>
                  <Label htmlFor="vc-name" className="text-xs">Name</Label>
                  <Input id="vc-name" value={vcName} onChange={(e) => setVcName(e.target.value)} placeholder="Tenant / manager" />
                </div>
                <div>
                  <Label htmlFor="vc-phone" className="text-xs">Phone</Label>
                  <Input id="vc-phone" type="tel" value={vcPhone} onChange={(e) => setVcPhone(e.target.value)} />
                </div>
                <div>
                  <Label htmlFor="vc-email" className="text-xs">Email</Label>
                  <Input id="vc-email" type="email" value={vcEmail} onChange={(e) => setVcEmail(e.target.value)} />
                </div>
              </div>
            </div>

            <div className="rounded-md border bg-muted/20 p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Safety & access
              </div>
              <div className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
                {(
                  [
                    ["doNotEnterIfDogOut", "Do NOT enter if dog is outside"],
                    ["aggressiveDog", "Aggressive dog"],
                    ["escapeRisk", "Escape risk (close gate)"],
                    ["invisibleFence", "Invisible fence"],
                    ["dogInYardDuringService", "Dog in yard during service"],
                    ["beesWasps", "Bees / wasps"],
                    ["sharpObjects", "Sharp objects"],
                    ["slipperySurfaces", "Slippery surfaces"],
                  ] as const
                ).map(([k, label]) => (
                  <label key={k} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={(hz as any)[k]}
                      onChange={() => setHz((s) => ({ ...s, [k]: !(s as any)[k] }))}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
              <div className="mt-2 space-y-1">
                <Label htmlFor="hn" className="text-xs">Notes for the tech</Label>
                <Input
                  id="hn"
                  value={hazardNotes}
                  onChange={(e) => setHazardNotes(e.target.value)}
                  placeholder="e.g. Latch is tricky, pool uncovered in summer"
                />
              </div>
            </div>
          </div>
        )}

        {/* STEP 2 — Yard (optional boundary sketch) */}
        {step === 2 && (
          <div className="space-y-4">
            <div>
              <h2 className="text-base font-medium">Sketch the yard (optional)</h2>
              <p className="text-sm text-muted-foreground">
                Draw the service area on the satellite map so the tech and pricing know the exact footprint. Skip to price a flat visit instead.
              </p>
            </div>
            {(geoStatus === "notfound" || geoStatus === "error") && (
              <div className="rounded-md border border-amber-400/50 bg-amber-50 p-3 text-sm text-amber-900">
                {geoStatus === "error"
                  ? "We couldn't reach the map service to locate this address. Check your connection, or draw the service area manually on the map below."
                  : "We couldn't find this address on the map. Double-check the address on the previous step, or draw the service area manually on the map below."}
              </div>
            )}
            <BoundarySketch
              center={geo}
              initial={boundary}
              areaSqm={boundaryAreaSqm}
              onSave={(poly) => {
                setBoundary(poly);
                toast.success(poly ? "Boundary saved" : "Boundary cleared");
              }}
            />
            {boundaryAreaSqm != null && (
              <p className="text-xs text-muted-foreground">
                Saved area: <strong>{formatArea(boundaryAreaSqm)}</strong>. If your zone uses per-sqft or per-acre pricing, the plan step will price from this area.
              </p>
            )}
          </div>
        )}

        {/* STEP 3 — Dogs */}
        {step === 3 && (
          <div className="space-y-4">
            {accountType === "commercial" && (
              <p className="text-sm text-muted-foreground">
                Skip if this is a commercial/HOA account. Otherwise add any resident dogs.
              </p>
            )}
            {dogs.map((d, i) => (
              <div key={i} className="rounded-md border bg-muted/10 p-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label className="text-xs">Name</Label>
                    <Input
                      value={d.name}
                      onChange={(e) => {
                        const next = [...dogs];
                        next[i] = { ...next[i], name: e.target.value };
                        setDogs(next);
                      }}
                      placeholder="Bailey"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Breed</Label>
                    <Input
                      value={d.breed}
                      onChange={(e) => {
                        const next = [...dogs];
                        next[i] = { ...next[i], breed: e.target.value };
                        setDogs(next);
                      }}
                      placeholder="Lab mix"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Weight</Label>
                    <select
                      value={d.weightClass}
                      onChange={(e) => {
                        const next = [...dogs];
                        next[i] = { ...next[i], weightClass: e.target.value };
                        setDogs(next);
                      }}
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                    >
                      <option value="">-</option>
                      <option value="small">Small (&lt; 25 lb)</option>
                      <option value="medium">Medium (25-60 lb)</option>
                      <option value="large">Large (60-100 lb)</option>
                      <option value="xlarge">XL (100+ lb)</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Temperament</Label>
                    <select
                      value={d.temperament}
                      onChange={(e) => {
                        const next = [...dogs];
                        next[i] = { ...next[i], temperament: e.target.value as any };
                        setDogs(next);
                      }}
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                    >
                      <option value="unknown">Unknown</option>
                      <option value="friendly">Friendly</option>
                      <option value="shy">Shy</option>
                      <option value="anxious">Anxious</option>
                      <option value="aggressive">Aggressive</option>
                    </select>
                  </div>
                </div>
                <div className="mt-2 flex justify-end">
                  {dogs.length > 1 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDogs(dogs.filter((_, idx) => idx !== i))}
                    >
                      <Trash2 className="mr-1 h-3.5 w-3.5 shrink-0" /> Remove
                    </Button>
                  )}
                </div>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setDogs([
                  ...dogs,
                  { name: "", breed: "", weightClass: "", temperament: "unknown", notes: "" },
                ])
              }
            >
              <Plus className="mr-1 h-3.5 w-3.5 shrink-0" /> Add another dog
            </Button>
          </div>
        )}

        {/* STEP 3 — Plan */}
        {step === 4 && (
          <div className="space-y-5">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={skipPlan}
                onChange={(e) => setSkipPlan(e.target.checked)}
              />
              <span>Skip subscription for now (I'll set it up later)</span>
            </label>

            {!skipPlan && (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Frequency</Label>
                    <select
                      value={frequency}
                      onChange={(e) => setFrequency(e.target.value as any)}
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                    >
                      {FREQS.map((f) => (
                        <option key={f.value} value={f.value}>
                          {f.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-2">
                    <Label>Billing</Label>
                    <select
                      value={billingCadence}
                      onChange={(e) => setBillingCadence(e.target.value as any)}
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                    >
                      <option value="postpaid">Bill after each visit</option>
                      <option value="prepaid">Prepaid credits</option>
                    </select>
                  </div>
                  {accountType === "commercial" && (
                    <div className="space-y-2">
                      <Label>Units / stations</Label>
                      <Input
                        type="number"
                        min={1}
                        value={unitCount}
                        onChange={(e) => setUnitCount(e.target.value)}
                      />
                    </div>
                  )}
                </div>

                {accountType === "residential" && (
                  <div className="rounded-md border bg-primary/5 p-4">
                    <div className="flex items-baseline justify-between">
                      <div>
                        <div className="text-xs uppercase tracking-wide text-muted-foreground">
                          Suggested price / visit
                        </div>
                        {quoteQ.isFetching && (
                          <div className="text-sm text-muted-foreground">Calculating…</div>
                        )}
                        {!quoteQ.isFetching && suggestedCents != null && (
                          <div className="text-2xl font-semibold">
                            {money(suggestedCents, (quoteQ.data as any)?.quote?.currency)}
                          </div>
                        )}
                        {!quoteQ.isFetching &&
                          quoteQ.data &&
                          !("quote" in (quoteQ.data as any)) && (
                            <div className="text-sm text-amber-600">
                              No zone matches ZIP {postalCode}. Set price manually below.
                            </div>
                          )}
                      </div>
                      {quoteQ.data && "quote" in (quoteQ.data as any) && (
                        <Badge variant="secondary">
                          Zone: {(quoteQ.data as any).quote.zoneName}
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Based on {Math.max(1, validDogs.length)} dog
                      {validDogs.length === 1 ? "" : "s"} · {FREQS.find((f) => f.value === frequency)?.label}
                    </p>
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="po">Price per visit (override)</Label>
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">$</span>
                    <Input
                      id="po"
                      inputMode="decimal"
                      placeholder={
                        suggestedCents != null ? (suggestedCents / 100).toFixed(2) : "25.00"
                      }
                      value={priceOverride}
                      onChange={(e) => setPriceOverride(e.target.value)}
                      className="max-w-[160px]"
                    />
                    <span className="text-xs text-muted-foreground">
                      Final: <strong>{money(priceCents)}</strong> / visit
                    </span>
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* Nav */}
        <div className="mt-6 flex items-center justify-between border-t pt-4">
          <Button
            type="button"
            variant="ghost"
            onClick={() => (step === 0 ? navigate({ to: "/clients" }) : setStep(step - 1))}
          >
            {step === 0 ? "Cancel" : "Back"}
          </Button>
          {step < STEPS.length - 1 ? (
            <Button
              type="button"
              onClick={() => {
                if (!canNext) {
                  setAttempted(true);
                  return;
                }
                setAttempted(false);
                setStep(step + 1);
              }}
            >
              Continue
            </Button>
          ) : (
            <Button
              type="button"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate()}
            >
              {mutation.isPending ? "Creating…" : "Create client"}
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}
