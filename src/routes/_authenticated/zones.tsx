import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { listZones, deleteZone, normalizeUsZip } from "@/lib/zones.functions";
import { getZoneCoverage, rerunZoneDetection } from "@/lib/zone-coverage.functions";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { useRowSelection } from "@/hooks/useRowSelection";
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
  const del = useServerFn(deleteZone);
  const qc = useQueryClient();
  const { confirm, dialog: bulkDialog } = useConfirmDialog();
  const { data } = useQuery({ queryKey: ["zones"], queryFn: () => list() });
  // Recomputed from the matcher, not read from properties.zone_id -- that
  // column is the thing that goes stale. See src/lib/zone-coverage.ts.
  const { data: coverage } = useQuery({
    queryKey: ["zone-coverage"],
    queryFn: () => getZoneCoverage(),
  });

  // The remedy for what the banner reports. Same permission as editing a zone,
  // because it rewrites properties.zone_id across the organization.
  const redetectM = useMutation({
    mutationFn: () => rerunZoneDetection(),
    onSuccess: (r: { propertiesUpdated: number }) => {
      toast.success(
        r.propertiesUpdated === 0
          ? "Detection re-run. Nothing changed, so every property already agreed with the rules."
          : `Detection re-run. ${r.propertiesUpdated} propert${r.propertiesUpdated === 1 ? "y" : "ies"} updated.`,
      );
      qc.invalidateQueries({ queryKey: ["zone-coverage"] });
      qc.invalidateQueries({ queryKey: ["zones"] });
    },
    // Deliberately loud. The side-effect version of this swallows its failure
    // and logs it; a person who pressed a button is owed the error.
    onError: (e: unknown) =>
      toast.error(`Could not re-run detection: ${(e as Error).message}`),
  });
  const { can } = usePermissions();
  const canEdit = can("manage_pricing");

  // null = closed, "new" = create, otherwise the zone row being edited.
  const [drawer, setDrawer] = useState<"new" | any | null>(null);

  const zones = data?.zones ?? [];
  const noGeoZones = zones.filter((z: any) => !zoneHasGeo(z as OverviewZone));

  // Multi-select for bulk delete (Invoices-page pattern). Only offered to
  // roles that can edit zones — deleteZone is manage_pricing-gated anyway.
  const visibleIds = useMemo(() => zones.map((z: any) => z.id as string), [zones]);
  const sel = useRowSelection(visibleIds);

  // Bulk delete loops the existing per-zone deleteZone fn (same permission
  // gate + property re-detection as the card's Delete action).
  const bulkDeleteM = useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(ids.map((id) => del({ data: { id } })));
      const ok = results.filter((r) => r.status === "fulfilled").length;
      return { ok, failed: results.length - ok };
    },
    onSuccess: (r) => {
      if (r.failed)
        toast.error(`Deleted ${r.ok} of ${r.ok + r.failed} zones, ${r.failed} failed`);
      else toast.success(`Deleted ${r.ok} zone${r.ok === 1 ? "" : "s"}`);
      sel.clear();
      qc.invalidateQueries({ queryKey: ["zones"] });
    },
    onError: (e: Error) => toast.error(e.message),
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
            <Plus className="mr-1 h-4 w-4 shrink-0" /> New zone
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
      {coverage?.problem ? (
        <div
          role="status"
          className="rounded-lg border border-amber-300/60 bg-amber-50/60 p-3 text-sm dark:border-amber-900/60 dark:bg-amber-950/20"
        >
          <p className="font-medium">{coverage.problem}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Checked by running the matching rules over every property again, so this
            reflects the zones as they are saved right now, not what was recorded the
            last time a property was matched.
            {coverage.summary.orphaned > 0
              ? " A property that keeps a zone the rules would no longer give it still shows that zone everywhere else in the app."
              : ""}
          </p>
          {canEdit && coverage.summary.stale > 0 ? (
            <Button
              variant="outline"
              size="sm"
              className="mt-3 min-h-[44px]"
              disabled={redetectM.isPending}
              onClick={async () => {
                const c = coverage.summary;
                const willClear = c.orphaned;
                const lines = [
                  willClear > 0
                    ? `${willClear} propert${willClear === 1 ? "y" : "ies"} will lose the zone they currently show, because no zone matches them under the rules as saved right now.`
                    : null,
                  c.reassigned > 0
                    ? `${c.reassigned} will move to a different zone.`
                    : null,
                  c.unassigned > 0 ? `${c.unassigned} will gain a zone.` : null,
                ].filter(Boolean) as string[];
                const ok = await confirm({
                  title: "Re-run zone detection?",
                  description: `${lines.join(" ")} Pricing for existing services is not changed by this; it updates which zone each property is recorded in. If the zones themselves are wrong, fix those first, because this makes the properties agree with whatever the zones currently say.`,
                  confirmLabel: "Re-run detection",
                  destructive: willClear > 0,
                });
                if (ok) redetectM.mutate();
              }}
            >
              {redetectM.isPending ? "Re-running…" : "Re-run zone detection"}
            </Button>
          ) : null}
        </div>
      ) : null}

      {noGeoZones.length > 0 && (
        <p className="text-xs text-amber-600">
          No map coverage yet: {noGeoZones.map((z: any) => `"${z.name}"`).join(", ")}. Open Edit to
          draw coverage so these zones appear on the map and match by location.
        </p>
      )}

      {canEdit && zones.length > 0 && (
        <label className="flex min-h-8 w-fit items-center gap-2 px-1 text-xs text-muted-foreground">
          <Checkbox
            checked={sel.allSelected}
            onCheckedChange={sel.toggleAll}
            aria-label="Select all zones"
          />
          Select all
        </label>
      )}

      {/* Bulk action bar */}
      {canEdit && sel.count > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-accent/40 px-4 py-2 text-sm shadow-sm">
          <span className="font-medium">{sel.count} selected</span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="destructive"
              disabled={bulkDeleteM.isPending}
              onClick={async () => {
                if (
                  await confirm({
                    title: `Delete ${sel.count} zone${sel.count === 1 ? "" : "s"}?`,
                    description:
                      "This removes the zones and their pricing. Clients and properties are not deleted; their zone is re-detected and any that only matched these zones become unassigned. This can't be undone.",
                    destructive: true,
                    confirmLabel: "Delete zones",
                  })
                )
                  bulkDeleteM.mutate(sel.selectedIds);
              }}
            >
              {bulkDeleteM.isPending ? "Deleting…" : "Delete"}
            </Button>
            <Button size="sm" variant="ghost" onClick={sel.clear}>
              Clear
            </Button>
          </div>
        </div>
      )}

      <div className="grid gap-3">
        {zones.map((z: any) => (
          <ZoneCard
            key={z.id}
            zone={z}
            canEdit={canEdit}
            onEdit={() => setDrawer(z)}
            selected={sel.isSelected(z.id)}
            onToggleSelect={canEdit ? (next) => sel.toggle(z.id, next) : undefined}
          />
        ))}
        {data && zones.length === 0 && (
          <Card className="p-10 text-center text-muted-foreground">
            <MapPin className="mx-auto mb-2 h-8 w-8 opacity-50 shrink-0" />
            No zones yet. Create your first zone to enable instant quoting.
          </Card>
        )}
      </div>

      {bulkDialog}
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

function ZoneCard({
  zone,
  canEdit,
  onEdit,
  selected = false,
  onToggleSelect,
}: {
  zone: any;
  canEdit: boolean;
  onEdit: () => void;
  selected?: boolean;
  onToggleSelect?: (next: boolean) => void;
}) {
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
  // Only the ones shown — a value hidden behind "+N more" cannot be pointed at,
  // and claiming it here would send somebody looking for a chip that is not on
  // screen. Opening the zone still surfaces the rest.
  const deadZips = zipList.slice(0, 12).filter((z) => normalizeUsZip(z) !== z);
  const hasGeo = zoneHasGeo(zone as OverviewZone);
  const summary = coverageSummary(zone);

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        {onToggleSelect && (
          <Checkbox
            className="mt-1"
            checked={selected}
            onCheckedChange={(v) => onToggleSelect(v === true)}
            aria-label={`Select zone ${zone.name}`}
          />
        )}
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
          {/* A chip that cannot match anything must not look like one that can.
              Zone matching is exact string equality against
              `properties.postal_code`, so a stored value that is not a US
              5-digit ZIP covers nothing — and the live database has one: a
              zone whose ZIP list is the single word "Michigan", matching zero
              properties. The drawer refuses these on save now, but a list you
              never open is a list that never tells you, and this card is where
              somebody looks to find out what a zone covers. */}
          {zipList.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {zipList.slice(0, 12).map((z) => (
                <Badge
                  key={z}
                  variant={normalizeUsZip(z) === z ? "secondary" : "destructive"}
                  className="text-xs"
                  title={
                    normalizeUsZip(z) === z
                      ? undefined
                      : `"${z}" is not a US 5-digit ZIP, so it matches no address. Edit the zone to correct it.`
                  }
                >
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
          {deadZips.length > 0 && (
            // Named, not counted: "1 invalid ZIP" sends you hunting through
            // twelve chips for it, and the whole point of the colour above is
            // that you should not have to.
            <p className="mt-2 text-xs text-destructive">
              {deadZips.length === 1
                ? `${deadZips[0]} is not a US 5-digit ZIP and matches no address.`
                : `${deadZips.join(", ")} are not US 5-digit ZIPs and match no addresses.`}{" "}
              Edit the zone to correct {deadZips.length === 1 ? "it" : "them"}.
            </p>
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
              {zone.area_max_charge_cents != null
                ? ` · max ${money(zone.area_max_charge_cents)}`
                : " · no maximum"}
            </div>
          )}
          {zone.pricing_mode === "per_acre" && (
            <div className="mt-1 text-xs text-primary">
              {money(zone.price_per_acre_cents)}/acre
              {zone.area_min_charge_cents > 0 && ` · min ${money(zone.area_min_charge_cents)}`}
              {zone.area_max_charge_cents != null
                ? ` · max ${money(zone.area_max_charge_cents)}`
                : " · no maximum"}
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
            <Eye className="mr-1 h-3.5 w-3.5 shrink-0" /> View coverage
          </Button>
        )}
        {canEdit && (
          <>
            <Button size="sm" variant="outline" onClick={onEdit}>
              <Pencil className="mr-1 h-3.5 w-3.5 shrink-0" /> Edit
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="ghost" aria-label="More actions">
                  <MoreHorizontal className="h-4 w-4 shrink-0" />
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
