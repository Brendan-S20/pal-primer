import { createFileRoute } from "@tanstack/react-router";
import { AiSection, PricingPanel } from "@/components/ai/AiPanels";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { listZones, createZone, updateZone, deleteZone } from "@/lib/zones.functions";
import { getStandardPricing, updateStandardPricing } from "@/lib/subscriptions.functions";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ConfirmButton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { X, Plus, Trash2, MapPin } from "lucide-react";
import { toast } from "sonner";
import { usePermissions } from "@/hooks/useMyRole";
import { ZoneCoverageMap, type CoverageValue } from "@/components/ZoneCoverageMap";
import {
  ZonesOverviewMap,
  ZONE_COLORS,
  zoneHasGeo,
  type OverviewZone,
} from "@/components/ZonesOverviewMap";
import { HelpTip } from "@/components/HelpTip";

export const Route = createFileRoute("/_authenticated/zones")({
  component: ZonesPage,
});

const money = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format((cents ?? 0) / 100);

// Zone saves re-run zone detection across the org's properties (QA round 8:
// "I updated a zone and none of the properties adjusted to it").
const reassignedToastMsg = (verb: string, n: number | undefined) =>
  n && n > 0
    ? `${verb}. ${n} ${n === 1 ? "property" : "properties"} re-assigned.`
    : verb;

function ZipChips({
  value,
  onChange,
  placeholder,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  const [buf, setBuf] = useState("");

  const commit = (raw: string) => {
    const parts = raw
      .split(/[\s,]+/)
      .map((p) => p.trim().replace(/[^0-9A-Za-z-]/g, ""))
      .filter(Boolean);
    if (!parts.length) return;
    const next = Array.from(new Set([...value, ...parts]));
    onChange(next);
    setBuf("");
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border bg-background p-2 min-h-[42px]">
      {value.map((z) => (
        <Badge key={z} variant="secondary" className="gap-1 pr-1">
          {z}
          <button
            type="button"
            className="rounded-full p-0.5 hover:bg-muted-foreground/20"
            onClick={() => onChange(value.filter((x) => x !== z))}
            aria-label={`Remove ${z}`}
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}
      <input
        value={buf}
        onChange={(e) => setBuf(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "," || e.key === " " || e.key === "Tab") {
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
          if (/[\s,]/.test(text)) {
            e.preventDefault();
            commit(text);
          }
        }}
        className="flex-1 min-w-[100px] bg-transparent text-sm outline-none"
        placeholder={value.length ? "" : (placeholder ?? "78701, 78702…")}
      />
    </div>
  );
}

function ZonesPage() {
  const list = useServerFn(listZones);
  const create = useServerFn(createZone);
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["zones"], queryFn: () => list() });
  const { can } = usePermissions();
  const canEdit = can("manage_pricing");

  const [showNew, setShowNew] = useState(false);
  const [name, setName] = useState("");
  const [zips, setZips] = useState<string[]>([]);
  const [basePrice, setBasePrice] = useState("25.00");
  const [perDog, setPerDog] = useState("5.00");
  const [initialCleanup, setInitialCleanup] = useState("0");
  const [priceNote, setPriceNote] = useState("");
  const [priority, setPriority] = useState("0");

  const resetForm = () => {
    setName("");
    setZips([]);
    setBasePrice("25.00");
    setPerDog("5.00");
    setInitialCleanup("0");
    setPriceNote("");
    setPriority("0");
  };

  const mut = useMutation({
    mutationFn: () =>
      create({
        data: {
          name,
          zipCodes: zips,
          basePriceCents: Math.round((parseFloat(basePrice) || 0) * 100),
          perDogAddlCents: Math.round((parseFloat(perDog) || 0) * 100),
          initialCleanupCents: Math.round((parseFloat(initialCleanup) || 0) * 100),
          priceNote: priceNote || undefined,
          priority: parseInt(priority, 10) || 0,
        },
      }),
    onSuccess: (res: any) => {
      toast.success(reassignedToastMsg("Zone created", res?.propertiesUpdated));
      resetForm();
      setShowNew(false);
      qc.invalidateQueries({ queryKey: ["zones"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            Zones <HelpTip article="zones" />
          </h1>
          <p className="text-sm text-muted-foreground">
            {canEdit
              ? "Group service areas by ZIP code. Pricing here powers the instant quote for new clients."
              : "View-only: zone boundaries and rates for routing context. Pricing changes require an owner or office manager."}
          </p>
        </div>
        {canEdit && (
          <Button onClick={() => setShowNew((v) => !v)} variant={showNew ? "outline" : "default"}>
            <Plus className="mr-1 h-4 w-4" /> {showNew ? "Cancel" : "New zone"}
          </Button>
        )}
      </div>

      {canEdit && <StandardPricingCard />}

      {showNew && (
        <Card className="p-5">
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (name) mut.mutate();
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="name">Zone name</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Central Austin"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pn">Internal note (optional)</Label>
                <Input
                  id="pn"
                  value={priceNote}
                  onChange={(e) => setPriceNote(e.target.value)}
                  placeholder="Weekday only, gate codes"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="prio">Priority</Label>
              <Input
                id="prio"
                type="number"
                inputMode="numeric"
                className="w-32"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                When zones overlap, the higher priority wins.
              </p>
            </div>

            <div className="space-y-2">
              <Label>ZIP codes served</Label>
              <ZipChips value={zips} onChange={setZips} />
              <p className="text-xs text-muted-foreground">
                Type ZIPs and press Enter, comma, or space. Paste a list to bulk add.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="bp">Base price / visit</Label>
                <div className="flex items-center gap-1">
                  <span className="text-muted-foreground">$</span>
                  <Input
                    id="bp"
                    inputMode="decimal"
                    value={basePrice}
                    onChange={(e) => setBasePrice(e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="pd">Each additional dog</Label>
                <div className="flex items-center gap-1">
                  <span className="text-muted-foreground">$</span>
                  <Input
                    id="pd"
                    inputMode="decimal"
                    value={perDog}
                    onChange={(e) => setPerDog(e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="ic">Initial cleanup fee</Label>
                <div className="flex items-center gap-1">
                  <span className="text-muted-foreground">$</span>
                  <Input
                    id="ic"
                    inputMode="decimal"
                    value={initialCleanup}
                    onChange={(e) => setInitialCleanup(e.target.value)}
                  />
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 border-t pt-3">
              <Button type="button" variant="ghost" onClick={() => setShowNew(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={mut.isPending || !name}>
                {mut.isPending ? "Creating…" : "Create zone"}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {/* All-zones overview: the page used to be plain text cards for a
          geography product (P2). Zones without map coverage yet are listed
          under the map with a nudge. */}
      {(data?.zones ?? []).some((z: any) => zoneHasGeo(z as OverviewZone)) && (
        <div className="space-y-2">
          <ZonesOverviewMap zones={(data?.zones ?? []) as OverviewZone[]} />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {(data?.zones ?? [])
              .filter((z: any) => zoneHasGeo(z as OverviewZone))
              .map((z: any, i: number) => (
                <span key={z.id} className="inline-flex items-center gap-1.5">
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{ background: ZONE_COLORS[i % ZONE_COLORS.length] }}
                  />
                  {z.name}
                </span>
              ))}
            {(data?.zones ?? []).some((z: any) => !zoneHasGeo(z as OverviewZone)) && (
              <span className="italic">
                Zones without a map location:{" "}
                {(data?.zones ?? [])
                  .filter((z: any) => !zoneHasGeo(z as OverviewZone))
                  .map((z: any) => z.name)
                  .join(", ")}{" "}
                (set one in "Coverage" below).
              </span>
            )}
          </div>
        </div>
      )}

      <div className="grid gap-3">
        {(data?.zones ?? []).map((z: any) => (
          <ZoneCard key={z.id} zone={z} canEdit={canEdit} />
        ))}
        {data && data.zones.length === 0 && !showNew && (
          <Card className="p-10 text-center text-muted-foreground">
            <MapPin className="mx-auto mb-2 h-8 w-8 opacity-50" />
            No zones yet. Create your first zone to enable instant quoting.
          </Card>
        )}
      </div>
    </div>
  );
}

function ZoneCard({ zone, canEdit }: { zone: any; canEdit: boolean }) {
  const update = useServerFn(updateZone);
  const del = useServerFn(deleteZone);
  const qc = useQueryClient();

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(zone.name);
  const [zips, setZips] = useState<string[]>(zone.zip_codes ?? []);
  const [basePrice, setBasePrice] = useState(((zone.base_price_cents ?? 0) / 100).toFixed(2));
  const [perDog, setPerDog] = useState(((zone.per_dog_addl_cents ?? 0) / 100).toFixed(2));
  const [initialCleanup, setInitialCleanup] = useState(
    ((zone.initial_cleanup_cents ?? 0) / 100).toFixed(2),
  );
  const [priceNote, setPriceNote] = useState(zone.price_note ?? "");
  const [pricingMode, setPricingMode] = useState<"flat" | "per_sqft" | "per_acre">(
    (zone.pricing_mode as any) ?? "flat",
  );
  const [perSqft, setPerSqft] = useState<string>(
    String(Number(zone.price_per_sqft_cents ?? 0) / 100),
  );
  const [perAcre, setPerAcre] = useState<string>(
    ((zone.price_per_acre_cents ?? 0) / 100).toFixed(2),
  );
  const [areaMin, setAreaMin] = useState<string>(
    ((zone.area_min_charge_cents ?? 0) / 100).toFixed(2),
  );
  const [priority, setPriority] = useState<string>(String(zone.priority ?? 0));

  const saveMut = useMutation({
    mutationFn: () =>
      update({
        data: {
          id: zone.id,
          name,
          zipCodes: zips,
          basePriceCents: Math.round((parseFloat(basePrice) || 0) * 100),
          perDogAddlCents: Math.round((parseFloat(perDog) || 0) * 100),
          initialCleanupCents: Math.round((parseFloat(initialCleanup) || 0) * 100),
          priceNote: priceNote,
          pricingMode,
          pricePerSqftCents: parseFloat(perSqft) > 0 ? parseFloat(perSqft) * 100 : 0,
          pricePerAcreCents: Math.round((parseFloat(perAcre) || 0) * 100),
          areaMinChargeCents: Math.round((parseFloat(areaMin) || 0) * 100),
          priority: parseInt(priority, 10) || 0,
        },
      }),
    onSuccess: (res: any) => {
      toast.success(reassignedToastMsg("Zone saved", res?.propertiesUpdated));
      setEditing(false);
      qc.invalidateQueries({ queryKey: ["zones"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const delMut = useMutation({
    mutationFn: () => del({ data: { id: zone.id } }),
    onSuccess: (res: any) => {
      toast.success(reassignedToastMsg("Zone deleted", res?.propertiesUpdated));
      qc.invalidateQueries({ queryKey: ["zones"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  if (!editing) {
    const zipList: string[] = zone.zip_codes ?? [];
    return (
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="font-semibold">{zone.name}</h3>
              {zone.postal_prefix && (
                <Badge variant="outline" className="text-xs">
                  prefix {zone.postal_prefix}
                </Badge>
              )}
              {(zone.priority ?? 0) !== 0 && (
                <Badge variant="outline" className="text-xs" title="When zones overlap, the higher priority wins.">
                  priority {zone.priority}
                </Badge>
              )}
            </div>
            {zipList.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {zipList.slice(0, 12).map((z) => (
                  <Badge key={z} variant="secondary" className="text-xs">
                    {z}
                  </Badge>
                ))}
                {zipList.length > 12 && (
                  <Badge variant="outline" className="text-xs">
                    +{zipList.length - 12} more
                  </Badge>
                )}
              </div>
            )}
            {zipList.length === 0 && !zone.postal_prefix && (
              <p className="mt-2 text-xs text-amber-600">
                No ZIPs set. This zone won't match new signups.
              </p>
            )}
            {zone.price_note && (
              <p className="mt-2 text-xs text-muted-foreground">{zone.price_note}</p>
            )}
          </div>
          <div className="text-right">
            <div className="text-lg font-semibold">{money(zone.base_price_cents)}</div>
            <div className="text-xs text-muted-foreground">
              base + {money(zone.per_dog_addl_cents)} / extra dog
            </div>
            {zone.initial_cleanup_cents > 0 && (
              <div className="text-xs text-muted-foreground">
                First cleanup: {money(zone.initial_cleanup_cents)}
              </div>
            )}
            {zone.pricing_mode === "per_sqft" && (
              <div className="mt-1 text-xs text-primary">
                {Number(zone.price_per_sqft_cents ?? 0).toFixed(2)}¢/sq ft
                {zone.area_min_charge_cents > 0 && ` · min ${money(zone.area_min_charge_cents)}`}
              </div>
            )}
            {zone.pricing_mode === "per_acre" && (
              <div className="mt-1 text-xs text-primary">
                {money(zone.price_per_acre_cents)}/acre
                {zone.area_min_charge_cents > 0 && ` · min ${money(zone.area_min_charge_cents)}`}
              </div>
            )}
          </div>
        </div>
        <ZoneCoverageSection zone={zone} canEdit={canEdit} />
        {canEdit && (
          <div className="mt-3 flex justify-end gap-2 border-t pt-3">
            <ConfirmButton
              trigger={
                <Button size="sm" variant="ghost" disabled={delMut.isPending}>
                  <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete
                </Button>
              }
              title={`Delete zone "${zone.name}"?`}
              description="This removes the zone and its pricing. Clients and properties are not deleted, but any pricing tied to this zone will need to be reassigned. This can't be undone."
              confirmLabel="Delete zone"
              onConfirm={() => delMut.mutate()}
            />
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              Edit
            </Button>
          </div>
        )}
      </Card>
    );
  }

  return (
    <Card className="p-5">
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Zone name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Internal note</Label>
            <Input value={priceNote} onChange={(e) => setPriceNote(e.target.value)} />
          </div>
        </div>
        <div className="space-y-2">
          <Label>ZIP codes served</Label>
          <ZipChips value={zips} onChange={setZips} />
        </div>
        <div className="space-y-2">
          <Label>Priority</Label>
          <Input
            type="number"
            inputMode="numeric"
            className="w-32"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            When zones overlap, the higher priority wins.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <Label>Base price / visit</Label>
            <div className="flex items-center gap-1">
              <span className="text-muted-foreground">$</span>
              <Input
                inputMode="decimal"
                value={basePrice}
                onChange={(e) => setBasePrice(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Each additional dog</Label>
            <div className="flex items-center gap-1">
              <span className="text-muted-foreground">$</span>
              <Input
                inputMode="decimal"
                value={perDog}
                onChange={(e) => setPerDog(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Initial cleanup fee</Label>
            <div className="flex items-center gap-1">
              <span className="text-muted-foreground">$</span>
              <Input
                inputMode="decimal"
                value={initialCleanup}
                onChange={(e) => setInitialCleanup(e.target.value)}
              />
            </div>
          </div>
        </div>

        <div className="space-y-2 rounded-md border bg-muted/20 p-3">
          <div className="flex items-center justify-between gap-3">
            <Label className="text-sm font-medium">Pricing mode</Label>
            <select
              value={pricingMode}
              onChange={(e) => setPricingMode(e.target.value as any)}
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
                When the property has a sketched boundary, per-visit price = area × rate + per-dog
                add-ons, then applies frequency multiplier. Falls back to base price when no
                boundary is set.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                {pricingMode === "per_sqft" ? (
                  <div className="space-y-1">
                    <Label className="text-xs">Rate per sq ft (¢)</Label>
                    <Input
                      inputMode="decimal"
                      value={perSqft}
                      onChange={(e) => setPerSqft(e.target.value)}
                      placeholder="0.75"
                    />
                  </div>
                ) : (
                  <div className="space-y-1">
                    <Label className="text-xs">Rate per acre ($)</Label>
                    <Input
                      inputMode="decimal"
                      value={perAcre}
                      onChange={(e) => setPerAcre(e.target.value)}
                      placeholder="300.00"
                    />
                  </div>
                )}
                <div className="space-y-1">
                  <Label className="text-xs">Minimum charge / visit ($)</Label>
                  <Input
                    inputMode="decimal"
                    value={areaMin}
                    onChange={(e) => setAreaMin(e.target.value)}
                    placeholder="25.00"
                  />
                </div>
              </div>
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t pt-3">
          <Button variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>
            {saveMut.isPending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function ZoneCoverageSection({ zone, canEdit }: { zone: any; canEdit: boolean }) {
  const update = useServerFn(updateZone);
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const mode = (zone.geo_match_mode ?? "zip") as "zip" | "polygon" | "radius" | "drive_time";

  const saveMut = useMutation({
    mutationFn: (v: CoverageValue) =>
      update({
        data: {
          id: zone.id,
          geoMatchMode: v.mode,
          boundary: v.polygon,
          centerLatitude: v.centerLat,
          centerLongitude: v.centerLng,
          radiusMeters: v.radiusMeters,
          driveTimeMinutes: v.driveTimeMinutes,
        },
      }),
    onSuccess: (res: any) => {
      toast.success(reassignedToastMsg("Coverage saved", res?.propertiesUpdated));
      qc.invalidateQueries({ queryKey: ["zones"] });
      setOpen(false);
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const clearMut = useMutation({
    mutationFn: () =>
      update({
        data: {
          id: zone.id,
          geoMatchMode: "zip",
          boundary: null,
          centerLatitude: null,
          centerLongitude: null,
          radiusMeters: null,
          driveTimeMinutes: null,
        },
      }),
    onSuccess: (res: any) => {
      toast.success(reassignedToastMsg("Reverted to ZIP matching", res?.propertiesUpdated));
      qc.invalidateQueries({ queryKey: ["zones"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const summary =
    mode === "polygon" && zone.boundary
      ? "Polygon on map"
      : mode === "radius" && zone.radius_meters
        ? `${(zone.radius_meters / 1609).toFixed(1)} mi radius`
        : mode === "drive_time" && zone.drive_time_minutes
          ? `~${zone.drive_time_minutes} min drive`
          : "ZIP only";

  return (
    <div className="mt-3 border-t pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm">
          <span className="text-muted-foreground">Map coverage:</span>{" "}
          <Badge variant={mode === "zip" ? "outline" : "secondary"} className="text-xs">
            {summary}
          </Badge>
        </div>
        {canEdit && (
          <div className="flex gap-2">
            {mode !== "zip" && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => clearMut.mutate()}
                disabled={clearMut.isPending}
              >
                Clear
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => setOpen((v) => !v)}>
              {open ? "Close map" : "Set on map"}
            </Button>
          </div>
        )}
      </div>
      {open && (
        <div className="mt-3">
          <ZoneCoverageMap
            initial={{
              mode: mode === "zip" ? "radius" : mode,
              polygon: zone.boundary ?? null,
              centerLat:
                zone.center_latitude != null
                  ? Number(zone.center_latitude)
                  : zone.latitude != null
                    ? Number(zone.latitude)
                    : null,
              centerLng:
                zone.center_longitude != null
                  ? Number(zone.center_longitude)
                  : zone.longitude != null
                    ? Number(zone.longitude)
                    : null,
              radiusMeters: zone.radius_meters ?? 5000,
              driveTimeMinutes: zone.drive_time_minutes ?? 15,
            }}
            onSave={(v) => saveMut.mutate(v)}
            saving={saveMut.isPending}
          />
        </div>
      )}

      {/* Zone pricing suggestions live with the zones they price (punch list #11). */}
      <AiSection
        title="AI: zone pricing"
        description="Suggest per-zone price adjustments from the last 90 days."
      >
        <PricingPanel />
      </AiSection>
    </div>
  );
}


// Org-wide Standard Price (client detail refactor): the baseline the zone
// comparison is measured against in the service pricing panel. Optional —
// leave blank and the comparison row is hidden.
function StandardPricingCard() {
  const qc = useQueryClient();
  const getFn = useServerFn(getStandardPricing);
  const updateFn = useServerFn(updateStandardPricing);
  const { data } = useQuery({ queryKey: ["std-pricing"], queryFn: () => getFn() });

  const [base, setBase] = useState<string | null>(null);
  const [perDog, setPerDog] = useState<string | null>(null);
  const baseVal = base ?? (data?.basePriceCents != null ? (data.basePriceCents / 100).toFixed(2) : "");
  const perDogVal =
    perDog ?? (data?.perDogAddlCents != null ? (data.perDogAddlCents / 100).toFixed(2) : "");

  const mut = useMutation({
    mutationFn: () =>
      updateFn({
        data: {
          basePriceCents: baseVal ? Math.round(parseFloat(baseVal) * 100) : null,
          perDogAddlCents: perDogVal ? Math.round(parseFloat(perDogVal) * 100) : null,
        },
      }),
    onSuccess: () => {
      toast.success("Standard pricing saved");
      qc.invalidateQueries({ queryKey: ["std-pricing"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">Standard pricing</h2>
          <p className="mt-1 max-w-lg text-xs text-muted-foreground">
            Your company-wide baseline per visit. Service pricing shows this next to the zone price
            so nothing gets replaced silently. Leave blank to hide the comparison.
          </p>
        </div>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            mut.mutate();
          }}
        >
          <div>
            <Label htmlFor="std-base" className="text-xs">
              Base price ($/visit)
            </Label>
            <Input
              id="std-base"
              type="number"
              min="0"
              step="0.01"
              className="w-32"
              value={baseVal}
              onChange={(e) => setBase(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="std-dog" className="text-xs">
              Per extra dog ($)
            </Label>
            <Input
              id="std-dog"
              type="number"
              min="0"
              step="0.01"
              className="w-32"
              value={perDogVal}
              onChange={(e) => setPerDog(e.target.value)}
            />
          </div>
          <Button type="submit" size="sm" disabled={mut.isPending}>
            {mut.isPending ? "Saving…" : "Save"}
          </Button>
        </form>
      </div>
    </Card>
  );
}
