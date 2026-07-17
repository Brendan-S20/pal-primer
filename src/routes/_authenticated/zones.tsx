import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { listZones, deleteZone } from "@/lib/zones.functions";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Plus, MapPin, MoreHorizontal, Eye, Pencil } from "lucide-react";
import { toast } from "sonner";
import { usePermissions } from "@/hooks/useMyRole";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { ZoneDrawer } from "@/components/ZoneDrawer";
import { MetaChip } from "@/components/client-detail/primitives";
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
  n && n > 0 ? `${verb}. ${n} ${n === 1 ? "property" : "properties"} re-assigned.` : verb;

function ZonesPage() {
  const list = useServerFn(listZones);
  const { data } = useQuery({ queryKey: ["zones"], queryFn: () => list() });
  const { can } = usePermissions();
  const canEdit = can("manage_pricing");

  // null = closed, "new" = create, otherwise the zone row being edited.
  const [drawer, setDrawer] = useState<"new" | any | null>(null);

  const zones = data?.zones ?? [];
  const noGeoZones = zones.filter((z: any) => !zoneHasGeo(z as OverviewZone));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            Zones <HelpTip article="zones" />
          </h1>
          <p className="text-sm text-muted-foreground">
            {canEdit
              ? "Service areas drawn on the map, with ZIPs for exact matching. Zone pricing powers the instant quote for new clients."
              : "View-only: zone boundaries and rates for routing context. Pricing changes require an owner or office manager."}
          </p>
          {canEdit && (
            <p className="mt-1 text-xs text-muted-foreground">
              Standard pricing now lives in{" "}
              <Link to="/settings/preferences" className="underline underline-offset-2">
                Settings &gt; Preferences
              </Link>
              .
            </p>
          )}
        </div>
        {canEdit && (
          <Button onClick={() => setDrawer("new")}>
            <Plus className="mr-1 h-4 w-4" /> New zone
          </Button>
        )}
      </div>

      {/* All-zones overview: fits the map to the org's coverage. Zones still
          missing map coverage (legacy ZIP-only) are called out by name below
          the map until someone draws them. */}
      {zones.some((z: any) => zoneHasGeo(z as OverviewZone)) && (
        <div className="space-y-2">
          <ZonesOverviewMap zones={zones as OverviewZone[]} />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {zones
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
          </div>
        </div>
      )}
      {noGeoZones.length > 0 && (
        <p className="text-xs text-amber-600">
          No map coverage yet: {noGeoZones.map((z: any) => `"${z.name}"`).join(", ")}. Open Edit to
          draw coverage so these zones appear on the map and match by location.
        </p>
      )}

      <div className="grid gap-3">
        {zones.map((z: any) => (
          <ZoneCard key={z.id} zone={z} canEdit={canEdit} onEdit={() => setDrawer(z)} />
        ))}
        {data && zones.length === 0 && (
          <Card className="p-10 text-center text-muted-foreground">
            <MapPin className="mx-auto mb-2 h-8 w-8 opacity-50" />
            No zones yet. Create your first zone to enable instant quoting.
          </Card>
        )}
      </div>

      {drawer !== null && (
        <ZoneDrawer
          key={drawer === "new" ? "new" : drawer.id}
          open
          onClose={() => setDrawer(null)}
          zone={drawer === "new" ? null : drawer}
        />
      )}
    </div>
  );
}

function coverageSummary(zone: any): string {
  const mode = (zone.geo_match_mode ?? "zip") as string;
  if (mode === "polygon" && zone.boundary) return "Polygon on map";
  if (mode === "radius" && zone.radius_meters)
    return `${(zone.radius_meters / 1609).toFixed(1)} mi radius`;
  if (mode === "drive_time" && zone.drive_time_minutes)
    return `~${zone.drive_time_minutes} min drive`;
  return "No map coverage yet";
}

function ZoneCard({ zone, canEdit, onEdit }: { zone: any; canEdit: boolean; onEdit: () => void }) {
  const del = useServerFn(deleteZone);
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirmDialog();
  const [viewingCoverage, setViewingCoverage] = useState(false);

  const delMut = useMutation({
    mutationFn: () => del({ data: { id: zone.id } }),
    onSuccess: (res: any) => {
      toast.success(reassignedToastMsg("Zone deleted", res?.propertiesUpdated));
      qc.invalidateQueries({ queryKey: ["zones"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const handleDelete = async () => {
    const ok = await confirm({
      title: `Delete zone "${zone.name}"?`,
      description:
        "This removes the zone and its pricing. Clients and properties are not deleted; their zone is re-detected and any that only matched this zone become unassigned. This can't be undone.",
      confirmLabel: "Delete zone",
      destructive: true,
    });
    if (ok) delMut.mutate();
  };

  const zipList: string[] = zone.zip_codes ?? [];
  const hasGeo = zoneHasGeo(zone as OverviewZone);
  const summary = coverageSummary(zone);

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">{zone.name}</h3>
            <MetaChip>
              {zone.account_type === "commercial"
                ? "Commercial"
                : zone.account_type === "residential"
                  ? "Residential"
                  : "All accounts"}
            </MetaChip>
            {zone.postal_prefix && (
              <Badge variant="outline" className="text-xs">
                prefix {zone.postal_prefix}
              </Badge>
            )}
            {(zone.priority ?? 0) !== 0 && (
              <Badge
                variant="outline"
                className="text-xs"
                title="When zones overlap at the same match level, the higher priority wins."
              >
                priority {zone.priority}
              </Badge>
            )}
            <Badge variant={hasGeo ? "secondary" : "outline"} className="text-xs">
              {summary}
            </Badge>
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
          {zipList.length === 0 && !zone.postal_prefix && !hasGeo && (
            <p className="mt-2 text-xs text-amber-600">
              No ZIPs or map coverage set. This zone won't match any address.
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
              {Number(zone.price_per_sqft_cents ?? 0).toFixed(2)} cents/sq ft
              {zone.area_min_charge_cents > 0 && ` · min ${money(zone.area_min_charge_cents)}`}
            </div>
          )}
          {zone.pricing_mode === "per_acre" && (
            <div className="mt-1 text-xs text-primary">
              {money(zone.price_per_acre_cents)}/acre
              {zone.area_min_charge_cents > 0 && ` · min ${money(zone.area_min_charge_cents)}`}
            </div>
          )}
          {(zone.commercial_base_cents ?? 0) +
            (zone.commercial_per_unit_cents ?? 0) +
            (zone.commercial_per_acre_cents ?? 0) +
            (zone.commercial_per_station_cents ?? 0) >
            0 && (
            <div className="mt-1 text-xs text-muted-foreground">
              Commercial: {money(zone.commercial_base_cents ?? 0)} base +{" "}
              {money(zone.commercial_per_unit_cents ?? 0)}/unit +{" "}
              {money(zone.commercial_per_acre_cents ?? 0)}/acre
              {(zone.commercial_per_station_cents ?? 0) > 0 &&
                ` + ${money(zone.commercial_per_station_cents ?? 0)}/station`}
            </div>
          )}
        </div>
      </div>

      <div className="mt-3 flex items-center justify-end gap-2 border-t pt-3">
        {hasGeo && (
          <Button size="sm" variant="ghost" onClick={() => setViewingCoverage(true)}>
            <Eye className="mr-1 h-3.5 w-3.5" /> View coverage
          </Button>
        )}
        {canEdit && (
          <>
            <Button size="sm" variant="outline" onClick={onEdit}>
              <Pencil className="mr-1 h-3.5 w-3.5" /> Edit
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="ghost" aria-label="More actions">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  disabled={delMut.isPending}
                  onClick={handleDelete}
                >
                  Delete zone
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>

      {viewingCoverage && (
        <Dialog open onOpenChange={(o) => !o && setViewingCoverage(false)}>
          <DialogContent className="sm:max-w-3xl">
            <DialogHeader>
              <DialogTitle>{zone.name} coverage</DialogTitle>
              <DialogDescription>{summary}</DialogDescription>
            </DialogHeader>
            <ZonesOverviewMap zones={[zone as OverviewZone]} height={420} />
          </DialogContent>
        </Dialog>
      )}
      {dialog}
    </Card>
  );
}
