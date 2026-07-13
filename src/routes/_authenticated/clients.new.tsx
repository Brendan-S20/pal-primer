import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { onboardClient, getInternalQuote } from "@/lib/clients.functions";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { BoundarySketch, formatArea, type PolygonGeoJSON } from "@/components/BoundarySketch";
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
  const [yardSize, setYardSize] = useState<"" | "small" | "medium" | "large" | "xlarge">("");
  const [hazardNotes, setHazardNotes] = useState("");
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

  // Best-effort geocode when entering the Yard step
  useEffect(() => {
    if (step !== 2) return;
    if (geo) return;
    const q = [street, city, region, postalCode].filter(Boolean).join(", ");
    if (q.length < 6) {
      setGeoStatus("notfound");
      return;
    }
    const ac = new AbortController();
    setGeoStatus("loading");
    (async () => {
      try {
        const r = await fetch(
          `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`,
          { signal: ac.signal, headers: { Accept: "application/json" } },
        );
        if (!r.ok) throw new Error(`geocoder ${r.status}`);
        const rows = (await r.json()) as Array<{ lat: string; lon: string }>;
        if (rows?.[0]) {
          setGeo({ lat: Number(rows[0].lat), lng: Number(rows[0].lon) });
          setGeoStatus("ok");
        } else {
          setGeoStatus("notfound");
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        setGeoStatus("error");
      }
    })();
    return () => ac.abort();
  }, [step, street, city, region, postalCode, geo]);

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
      dogCount: Math.max(1, validDogs.length),
      frequency: frequency === "one_time" ? "weekly" : frequency,
      boundaryAreaSqm: boundaryAreaSqm ?? undefined,
    }),
    [postalCode, validDogs.length, frequency, boundaryAreaSqm],
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
          yardSize: yardSize || undefined,
          hazardNotes: hazardNotes || undefined,
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

      {/* Stepper */}
      <div className="flex items-center gap-2 text-sm">
        {STEPS.map((label, i) => {
          const state = i < step ? "done" : i === step ? "current" : "todo";
          return (
            <div key={label} className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => i < step && setStep(i)}
                disabled={i > step}
                className={
                  "flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium " +
                  (state === "done"
                    ? "bg-primary text-primary-foreground"
                    : state === "current"
                      ? "bg-primary/15 text-primary ring-2 ring-primary"
                      : "bg-muted text-muted-foreground")
                }
              >
                {state === "done" ? <Check className="h-3.5 w-3.5" /> : i + 1}
              </button>
              <span className={state === "current" ? "font-medium" : "text-muted-foreground"}>
                {label}
              </span>
              {i < STEPS.length - 1 && (
                <ChevronRight className="mx-1 h-4 w-4 text-muted-foreground" />
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
              <Label>Account type</Label>
              <RadioGroup
                value={accountType}
                onValueChange={(v) => setAccountType(v as typeof accountType)}
                className="flex gap-6"
              >
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="residential" id="t-res" />
                  <Label htmlFor="t-res" className="font-normal">Residential</Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="commercial" id="t-com" />
                  <Label htmlFor="t-com" className="font-normal">Commercial / HOA</Label>
                </div>
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
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2 space-y-2">
                <Label htmlFor="st">Street address</Label>
                <Input id="st" required value={street} onChange={(e) => setStreet(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ci">City</Label>
                <Input id="ci" required value={city} onChange={(e) => setCity(e.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="rg">State/Region</Label>
                  <Input id="rg" required value={region} onChange={(e) => setRegion(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="pc">ZIP / Postal</Label>
                  <Input id="pc" required value={postalCode} onChange={(e) => setPostalCode(e.target.value)} />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="gc">Gate code (optional)</Label>
                <Input id="gc" value={gateCode} onChange={(e) => setGateCode(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ys">Yard size</Label>
                <select
                  id="ys"
                  value={yardSize}
                  onChange={(e) => setYardSize(e.target.value as any)}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                >
                  <option value="">— choose —</option>
                  <option value="small">Small (under 1/8 acre)</option>
                  <option value="medium">Medium (1/8 – 1/4 acre)</option>
                  <option value="large">Large (1/4 – 1/2 acre)</option>
                  <option value="xlarge">Extra large (1/2+ acre)</option>
                </select>
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
                  : "We couldn't find this address on the map — double-check the address on the previous step, or draw the service area manually on the map below."}
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
                      <option value="">—</option>
                      <option value="small">Small (&lt; 25 lb)</option>
                      <option value="medium">Medium (25–60 lb)</option>
                      <option value="large">Large (60–100 lb)</option>
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
                      <Trash2 className="mr-1 h-3.5 w-3.5" /> Remove
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
              <Plus className="mr-1 h-3.5 w-3.5" /> Add another dog
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
              <span>Skip subscription for now — I'll set it up later</span>
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
                              No zone matches ZIP {postalCode} — set price manually below.
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
            <Button type="button" disabled={!canNext} onClick={() => setStep(step + 1)}>
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
