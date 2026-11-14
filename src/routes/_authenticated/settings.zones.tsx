import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { listZones, deleteZone, normalizeUsZip, fillEmptyZoneZips } from "@/lib/zones.functions";
import { zoneNeedsZipBackfill } from "@/lib/zone-zip-backfill";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import {
  Plus,
  MapPin,
  MoreHorizontal,
  Eye,
  Pencil,
  Trash2,
  Search,
  ChevronDown,
  Map as MapIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DEFAULT_ZONE_QUERY,
  filterAndSortZones,
  zipOverlaps,
  zipOverlapSentence,
  zoneQueryIsFiltered,
  zoneShapeDetail,
  type ZoneListQuery,
  type ZoneListRow,
  type ZoneShapeFilter,
  type ZoneSort,
  type ZipOverlap,
  type ZoneStatusFilter,
} from "@/lib/zone-list";
import { toast } from "sonner";
import { useMyRole, usePermissions } from "@/hooks/useMyRole";
import { useDismissed } from "@/lib/dismissible";
import { DismissButton } from "@/components/DismissButton";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { ZoneDrawer } from "@/components/ZoneDrawer";
import {
  ZonesOverviewMap,
  ZONE_COLORS,
  OFF_ZONE_COLOR,
  zoneHasGeo,
  type OverviewZone,
} from "@/components/ZonesOverviewMap";
import { HelpTip } from "@/components/HelpTip";
import { ZoneEnabledSwitch } from "@/components/ZoneEnabledSwitch";
import { ZoneRankingPanel, ZipFillPendingNote } from "@/components/ZoneRanking";
import { offZoneNotice } from "@/lib/zone-enabled";
import { FirstCleanupPricingCard } from "@/components/FirstCleanupPricingCard";
import { useServiceLines } from "@/components/CommercialOnly";
import { showsZoneVisitPrice } from "@/lib/service-lines";
import { getFirstCleanupPricing } from "@/lib/first-cleanup.functions";
import { titleHead } from "@/lib/page-title";
import { getStandardPricing } from "@/lib/subscriptions.functions";
import { standardPriceLine, zoneOverridesPrice } from "@/lib/standard-price";

// Settings → Zones & pricing (#864). Until 2026-11-10 this was /zones, outside
// the Settings layout, so the Settings menu disappeared the moment an owner
// opened it from Settings ("it takes you out of the settings"). /zones now
// forwards here (zones.tsx), so the sidebar, the command palette, bookmarks
// and older links all land inside Settings.
export const Route = createFileRoute("/_authenticated/settings/zones")({
  head: () => titleHead("Zones & pricing"),
  // Wide — see src/components/PageShell.tsx. A map beside the zone list; the map
  // is the thing being edited.
  staticData: { pageWidth: "wide" },
  component: ZonesPage,
});

// A row as listZones returns it. The select is untyped, so this names the
// fields the list reads; the rest pass through to the card and the drawer.
type ZoneRow = OverviewZone & ZoneListRow & Record<string, unknown>;

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
    onError: (e: unknown) => toast.error(`Could not re-run detection: ${(e as Error).message}`),
  });
  const { can } = usePermissions();
  const canEdit = can("manage_pricing");
  // The coverage warning can be put away (2026-10-03). Its version is the
  // sentence itself, which carries every count it reports ("12 of 40
  // properties fall outside every zone"), so it comes back the moment a zone
  // edit or a new property changes any of them, and not before. No timed
  // snooze: an unchanged gap is not news. Rule in src/lib/dismissible.ts.
  const { orgId } = useMyRole();
  const coverageNotice = useDismissed("zone-coverage", coverage?.problem ?? null, { orgId });
  // A zone's own first-cleanup fee is only a price in "flat" mode; in the
  // other two it is a number nothing charges, so the card does not show it.
  const firstCleanupFn = useServerFn(getFirstCleanupPricing);
  const firstCleanupQ = useQuery({
    queryKey: ["first-cleanup-pricing"],
    queryFn: () => firstCleanupFn(),
  });
  const zoneFeeIsCharged = firstCleanupQ.data?.pricing.mode === "flat";
  // The first cleanup prices a yard nobody has scooped for a while: a
  // pet-waste idea. Hidden from a business that does not run pet waste, but
  // only while it is off -- once configured it is charging new customers, and
  // the owner must be able to find the switch (PET_WASTE_MODULES).
  const { petWaste } = useServiceLines();
  const showFirstCleanup =
    petWaste || (!!firstCleanupQ.data && firstCleanupQ.data.pricing.mode !== "off");

  // null = closed, "new" = create, otherwise the zone row being edited.
  const [drawer, setDrawer] = useState<"new" | any | null>(null);
  // Set when the drawer was opened by a card's "Fill ZIPs from the area".
  const [fillOnOpen, setFillOnOpen] = useState(false);

  const zones = useMemo(() => (data?.zones ?? []) as ZoneRow[], [data]);
  const activeClientsKnown = data?.activeClientsKnown ?? false;
  // Zones that are off stay on the map, muted, unless this is unticked (#449).
  const [showOffOnMap, setShowOffOnMap] = useState(true);
  const offCount = zones.filter((z) => z.enabled === false).length;
  // Memoised: the map refits when this array changes, and hovering a row
  // re-renders the page.
  const mapZones = useMemo(
    () =>
      (showOffOnMap ? zones : zones.filter((z) => z.enabled !== false)).filter((z) =>
        zoneHasGeo(z as OverviewZone),
      ),
    [zones, showOffOnMap],
  );
  const noGeoZones = zones.filter((z) => !zoneHasGeo(z as OverviewZone));
  // One colour per zone, fixed by the zone's place in the full list, so a row's
  // swatch and its shape on the map agree whatever the list is filtered to.
  const zoneColors = useMemo(() => {
    const out: Record<string, string> = {};
    zones.forEach((z, i: number) => {
      out[z.id] = ZONE_COLORS[i % ZONE_COLORS.length];
    });
    return out;
  }, [zones]);
  const swatchOf = (z: { id: string; enabled?: boolean | null }) =>
    z.enabled === false ? OFF_ZONE_COLOR : zoneColors[z.id];

  // Search, filter and sort (#450). Kept on the page, not in the URL: it is a
  // way of looking at a short list, not a place to link to.
  const [query, setQuery] = useState<ZoneListQuery>(DEFAULT_ZONE_QUERY);
  const shown = useMemo(() => filterAndSortZones(zones, query), [zones, query]);
  const filtered = zoneQueryIsFiltered(query);
  // The zone a row is pointing at on the map: hover, or focus inside the row.
  const [highlightId, setHighlightId] = useState<string | null>(null);
  // Below lg the map is behind a toggle so the list comes first on a phone.
  const [mapOpen, setMapOpen] = useState(false);
  const hasMap = zones.some((z) => zoneHasGeo(z as OverviewZone));
  // Drawn areas that list no ZIPs (#793): saved before setup filled them
  // (#778), so the signup page and lead form quote nobody in them. One click
  // fills them all, the same way "Fill ZIPs from the area" fills one.
  const emptyZipAreas = zones.filter((z) => zoneNeedsZipBackfill(z as any));
  const fillEmptyM = useMutation({
    mutationFn: () => fillEmptyZoneZips({ data: {} }),
    onSuccess: (r: { summary: string | null; written: string[] }) => {
      if (r.written.length > 0) toast.success(r.summary ?? "ZIPs added.");
      else toast.error(r.summary ?? "No ZIPs could be added.");
      qc.invalidateQueries({ queryKey: ["zones"] });
      qc.invalidateQueries({ queryKey: ["zone-coverage"] });
    },
    onError: (e: unknown) => toast.error(`Could not fill ZIPs: ${(e as Error).message}`),
  });

  // Multi-select for bulk delete (Invoices-page pattern). Only offered to
  // roles that can edit zones — deleteZone is manage_pricing-gated anyway.
  // Select all means the rows on screen; a filter change clears the selection.
  const visibleIds = useMemo(() => shown.map((z) => z.id as string), [shown]);
  const sel = useRowSelection(visibleIds, `${query.search}|${query.status}|${query.shape}`);

  // Bulk delete loops the existing per-zone deleteZone fn (same permission
  // gate + property re-detection as the card's Delete action).
  const bulkDeleteM = useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(ids.map((id) => del({ data: { id } })));
      const ok = results.filter((r) => r.status === "fulfilled").length;
      return { ok, failed: results.length - ok };
    },
    onSuccess: (r) => {
      if (r.failed) toast.error(`Deleted ${r.ok} of ${r.ok + r.failed} zones, ${r.failed} failed`);
      else toast.success(`Deleted ${r.ok} zone${r.ok === 1 ? "" : "s"}`);
      sel.clear();
      qc.invalidateQueries({ queryKey: ["zones"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            Zones &amp; pricing <HelpTip article="zones" />
          </h2>
          <p className="text-sm text-muted-foreground">
            {canEdit
              ? "Service areas drawn on the map, with ZIPs for exact matching. Zone pricing powers the instant quote for new clients."
              : "View-only: zone boundaries and rates for routing context. Pricing changes require an owner or office manager."}
          </p>
          {canEdit && (
            <p className="mt-1 text-xs text-muted-foreground">
              Each service&apos;s standard price is set in{" "}
              <Link to="/settings/services" className="underline underline-offset-2">
                Settings → Services
              </Link>
              . A zone with its own price overrides it, only inside that zone.
            </p>
          )}
        </div>
        {canEdit && (
          <Button
            onClick={() => {
              setFillOnOpen(false);
              setDrawer("new");
            }}
          >
            <Plus className="mr-1 h-4 w-4 shrink-0" /> New zone
          </Button>
        )}
      </div>

      {coverage?.problem && !coverageNotice.dismissed ? (
        <div
          role="status"
          className="relative rounded-lg border border-amber-300/60 bg-amber-50/60 p-3 pe-12 text-sm dark:border-amber-900/60 dark:bg-amber-950/20"
        >
          {/* In the corner rather than in a row: the body below is a sentence,
              a paragraph and sometimes a button, and the X should not push any
              of them sideways. `pe-12` keeps the text clear of it. */}
          <DismissButton
            onClick={coverageNotice.dismiss}
            label="Hide the zone coverage warning"
            className="absolute end-0 top-0"
          />
          <p className="font-medium">{coverage.problem}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Checked by running the matching rules over every property again, so this reflects the
            zones as they are saved right now, not what was recorded the last time a property was
            matched.
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
                  c.reassigned > 0 ? `${c.reassigned} will move to a different zone.` : null,
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
        <p className="text-xs text-amber-700 dark:text-amber-400">
          No map coverage yet: {noGeoZones.map((z) => `"${z.name}"`).join(", ")}. Open Edit to draw
          coverage so these zones appear on the map and match by location.
        </p>
      )}

      {canEdit && emptyZipAreas.length > 0 && (
        <div
          role="status"
          data-testid="empty-zip-areas"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300/60 bg-amber-50/60 p-3 text-sm dark:border-amber-900/60 dark:bg-amber-950/20"
        >
          <p className="min-w-0 basis-full sm:basis-0 sm:grow">
            {emptyZipAreas.length === 1
              ? `"${emptyZipAreas[0].name}" lists no ZIPs, so the signup page and lead form can't quote it.`
              : `${emptyZipAreas.length} areas list no ZIPs, so the signup page and lead form can't quote them.`}{" "}
            <span className="text-xs text-muted-foreground">
              Adds the ZIPs whose center is inside each area. A ZIP another zone already lists is
              left with that zone.
            </span>
          </p>
          <Button
            size="sm"
            variant="outline"
            className="shrink-0"
            disabled={fillEmptyM.isPending}
            onClick={() => fillEmptyM.mutate()}
          >
            {fillEmptyM.isPending
              ? "Filling…"
              : emptyZipAreas.length === 1
                ? "Fill its ZIPs"
                : "Fill ZIPs for all"}
          </Button>
        </div>
      )}

      {/* Split view (#450): the list on the left, the map beside it from lg
          up and sticky while the list scrolls. Below lg the list comes first
          and the map opens from the toolbar, above the list. */}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        {hasMap && (
          <div
            data-testid="zones-map-panel"
            className={cn(
              "min-w-0 space-y-2 lg:sticky lg:top-4 lg:order-2 lg:block",
              mapOpen ? "block" : "hidden",
            )}
          >
            {/* All-zones overview: fits the map to the org's coverage. Zones
                still missing map coverage (legacy ZIP-only) are called out by
                name above the list until someone draws them. */}
            <ZonesOverviewMap
              zones={mapZones as OverviewZone[]}
              colors={zoneColors}
              highlightId={highlightId}
              height={420}
            />
            {offCount > 0 && (
              <label className="inline-flex min-h-11 items-center gap-2 text-xs text-muted-foreground">
                <Checkbox
                  checked={showOffOnMap}
                  onCheckedChange={(v) => setShowOffOnMap(v === true)}
                />
                Show zones that are off ({offCount})
              </label>
            )}
          </div>
        )}

        <div className="min-w-0 space-y-3 lg:order-1">
          {/* Which zone wins a ZIP two of them list (#858). */}
          <ZoneRankingPanel zones={zones as any} canEdit={canEdit} />
          {zones.length > 1 && (
            // Inside Settings (#864) the list shares the row with the Settings
            // menu and the map from lg up, so three filters side by side
            // clipped their labels at 1280px. Two per row there; three
            // again on a wide screen.
            <div
              className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-2 2xl:grid-cols-3"
              data-testid="zones-toolbar"
            >
              <div className="relative col-span-2 min-w-0 sm:col-span-3 lg:col-span-2 2xl:col-span-3">
                <Search className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 shrink-0 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query.search}
                  onChange={(e) => setQuery((q) => ({ ...q, search: e.target.value }))}
                  placeholder="Search name or ZIP"
                  aria-label="Search zones"
                  className="ps-8"
                />
              </div>
              <Select
                value={query.sort}
                onValueChange={(v) => setQuery((q) => ({ ...q, sort: v as ZoneSort }))}
              >
                <SelectTrigger aria-label="Sort zones" className="min-w-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="rank">Sort: Ranking</SelectItem>
                  <SelectItem value="name">Sort: Name</SelectItem>
                  <SelectItem value="clients">Sort: Most clients</SelectItem>
                  <SelectItem value="price">Sort: Highest price</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={query.status}
                onValueChange={(v) => setQuery((q) => ({ ...q, status: v as ZoneStatusFilter }))}
              >
                <SelectTrigger aria-label="Filter by status" className="min-w-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">On and off</SelectItem>
                  <SelectItem value="on">On only</SelectItem>
                  <SelectItem value="off">Off only</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={query.shape}
                onValueChange={(v) => setQuery((q) => ({ ...q, shape: v as ZoneShapeFilter }))}
              >
                <SelectTrigger aria-label="Filter by shape" className="min-w-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All shapes</SelectItem>
                  <SelectItem value="polygon">Polygon</SelectItem>
                  <SelectItem value="radius">Radius</SelectItem>
                  <SelectItem value="drive_time">Drive time</SelectItem>
                  <SelectItem value="zip">ZIP list</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {(zones.length > 0 || hasMap) && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
                {canEdit && shown.length > 0 && (
                  <label className="flex min-h-11 w-fit items-center gap-2 px-1 text-xs text-muted-foreground">
                    <Checkbox
                      checked={sel.allSelected}
                      onCheckedChange={sel.toggleAll}
                      aria-label={filtered ? "Select all shown zones" : "Select all zones"}
                    />
                    {filtered ? "Select all shown" : "Select all"}
                  </label>
                )}
                <span className="text-xs text-muted-foreground" data-testid="zones-count">
                  {filtered
                    ? `${shown.length} of ${zones.length} zones`
                    : `${zones.length} ${zones.length === 1 ? "zone" : "zones"}`}
                </span>
              </div>
              {hasMap && (
                <Button
                  size="sm"
                  variant="outline"
                  className="lg:hidden"
                  aria-expanded={mapOpen}
                  onClick={() => setMapOpen((o) => !o)}
                >
                  <MapIcon className="h-4 w-4 shrink-0" /> {mapOpen ? "Hide map" : "Show map"}
                </Button>
              )}
            </div>
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

          <ul className="grid gap-2" aria-label="Zones">
            {shown.map((z) => (
              <li
                key={z.id}
                onMouseEnter={() => setHighlightId(z.id)}
                onMouseLeave={() => setHighlightId((h) => (h === z.id ? null : h))}
                onFocus={() => setHighlightId(z.id)}
              >
                <ZoneCard
                  zone={z}
                  swatch={swatchOf(z)}
                  overlaps={zipOverlaps(z, zones)}
                  highlighted={highlightId === z.id}
                  canEdit={canEdit}
                  onEdit={() => {
                    setFillOnOpen(false);
                    setDrawer(z);
                  }}
                  onFillZips={() => {
                    setFillOnOpen(true);
                    setDrawer(z);
                  }}
                  showFirstCleanup={zoneFeeIsCharged}
                  activeClientsKnown={activeClientsKnown}
                  selected={sel.isSelected(z.id)}
                  onToggleSelect={canEdit ? (next) => sel.toggle(z.id, next) : undefined}
                />
              </li>
            ))}
          </ul>
          {filtered && shown.length === 0 && zones.length > 0 && (
            <Card className="p-6 text-center text-sm text-muted-foreground">
              No zones match.{" "}
              <Button
                variant="link"
                className="h-auto p-0"
                onClick={() => setQuery(DEFAULT_ZONE_QUERY)}
              >
                Clear search and filters
              </Button>
            </Card>
          )}
          {data && zones.length === 0 && (
            <Card className="p-10 text-center text-muted-foreground">
              <MapPin className="mx-auto mb-2 h-8 w-8 opacity-50 shrink-0" />
              No zones yet. Create your first zone to enable instant quoting.
            </Card>
          )}
        </div>
      </div>

      {showFirstCleanup && <FirstCleanupPricingCard canEdit={canEdit} />}

      {bulkDialog}
      {drawer !== null && (
        <ZoneDrawer
          key={drawer === "new" ? "new" : drawer.id}
          open
          onClose={() => setDrawer(null)}
          zone={drawer === "new" ? null : drawer}
          fillOnOpen={drawer !== "new" && fillOnOpen}
          activeClientsKnown={activeClientsKnown}
        />
      )}
    </div>
  );
}

/** Fewer listed ZIPs than this on a drawn zone, and the card offers a fill. */
const FEW_ZIPS = 3;

function coverageSummary(zone: any): string {
  const mode = (zone.geo_match_mode ?? "zip") as string;
  if (mode === "polygon" && zone.boundary) return "Polygon on map";
  if (mode === "radius" && zone.radius_meters)
    return `${(zone.radius_meters / 1609).toFixed(1)} mi radius`;
  if (mode === "drive_time" && zone.drive_time_minutes)
    return `~${zone.drive_time_minutes} min drive`;
  return "No map coverage yet";
}

function accountTypeLabel(t: string | null | undefined): string {
  return t === "commercial" ? "Commercial" : t === "residential" ? "Residential" : "All accounts";
}

// One zone in the list (#450). The first line answers "which zone, what
// shape, is it on, how many clients, what does it cost"; the ZIPs fold into a
// count; anything that needs the owner's attention (a ZIP that matches
// nothing, a drawn zone the signup page cannot quote, a ZIP two zones both
// claim) is always shown, never behind the fold. Edit, coverage and delete
// live in the row menu so "New zone" is the one primary action on the page.
function ZoneCard({
  zone,
  swatch,
  overlaps = [],
  highlighted = false,
  canEdit,
  onEdit,
  onFillZips,
  showFirstCleanup = false,
  activeClientsKnown = true,
  selected = false,
  onToggleSelect,
}: {
  zone: any;
  /** The colour this zone is drawn in on the map. */
  swatch?: string;
  overlaps?: ZipOverlap[];
  /** The map is pointing at this zone. */
  highlighted?: boolean;
  canEdit: boolean;
  onEdit: () => void;
  /** Open the drawer and fill the ZIP list from the zone's drawn area. */
  onFillZips?: () => void;
  showFirstCleanup?: boolean;
  activeClientsKnown?: boolean;
  selected?: boolean;
  onToggleSelect?: (next: boolean) => void;
}) {
  const del = useServerFn(deleteZone);
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirmDialog();
  const [viewingCoverage, setViewingCoverage] = useState(false);
  // The per-visit price is a scooping plan's (R2-38), as in ZoneDrawer:
  // shown to a business that runs pet waste, or while the zone prices a yard.
  const { lines } = useServiceLines();
  const showsVisitPrice = showsZoneVisitPrice(lines, zone);
  // #860: a zone with no price of its own charges the standard price.
  const stdFn = useServerFn(getStandardPricing);
  const std = useQuery({
    queryKey: ["std-pricing"],
    queryFn: () => stdFn(),
    enabled: showsVisitPrice && !zoneOverridesPrice(zone),
    staleTime: 60_000,
  });

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
  // The chips fold into "12 ZIPs" (#450), except when one of them is broken:
  // the warning below names it, so it has to be on screen to be found.
  const [zipsOpen, setZipsOpen] = useState(deadZips.length > 0);
  const zipsId = `zone-zips-${zone.id}`;
  const hasGeo = zoneHasGeo(zone as OverviewZone);
  const summary = coverageSummary(zone);
  const isOff = zone.enabled === false;
  const nameClass = isOff
    ? "min-w-0 break-words font-semibold text-muted-foreground"
    : "min-w-0 break-words font-semibold";
  const clients = Number(zone.active_clients ?? 0);

  return (
    <Card
      data-testid="zone-row"
      className={cn("p-3 sm:p-4", isOff && "bg-muted/40", highlighted && "ring-2 ring-primary/40")}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        {/* Below sm this column takes the whole row, so the price block wraps
            under it instead of squeezing the ZIP warning into a word per line
            beside it (#493). From sm up the zero basis gives today's layout.
            The checkbox lives inside it so it stays beside the zone name. */}
        {/* sm:min-w-48: inside Settings (#864) the list column is narrow from
            lg up, and with a zero basis the price block took the row and left
            the name one letter per line (measured at 1280). The name keeps
            12rem; when both do not fit, the price block wraps under it. */}
        <div className="flex min-w-0 grow basis-full items-start gap-3 sm:min-w-48 sm:basis-0">
          {onToggleSelect && (
            <Checkbox
              className="mt-1"
              checked={selected}
              onCheckedChange={(v) => onToggleSelect(v === true)}
              aria-label={`Select zone ${zone.name}`}
            />
          )}
          <span
            aria-hidden
            className="mt-1.5 inline-block h-3 w-3 shrink-0 rounded-full border border-black/10"
            style={{ background: swatch ?? OFF_ZONE_COLOR }}
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h3 className={nameClass}>{zone.name}</h3>
              {isOff && <Badge variant="outline">Off</Badge>}
            </div>
            {/* The facts, in one wrapping line of plain text rather than a
                row of chips that all look equally important. */}
            <p className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
              <span>{zoneShapeDetail(zone)}</span>
              {activeClientsKnown && (
                <span>
                  {clients} active {clients === 1 ? "client" : "clients"}
                </span>
              )}
              <span>{accountTypeLabel(zone.account_type)}</span>
              {zone.postal_prefix && <span>ZIP prefix {zone.postal_prefix}</span>}
            </p>
            {zipList.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                className="-ms-2 mt-1 h-7 gap-1 px-2 text-xs"
                aria-expanded={zipsOpen}
                aria-controls={zipsId}
                onClick={() => setZipsOpen((o) => !o)}
              >
                {zipList.length} {zipList.length === 1 ? "ZIP" : "ZIPs"}
                <ChevronDown
                  className={cn(
                    "h-3.5 w-3.5 shrink-0 transition-transform",
                    zipsOpen && "rotate-180",
                  )}
                />
              </Button>
            )}
            {/* A chip that cannot match anything must not look like one that can.
                Zone matching is exact string equality against
                `properties.postal_code`, so a stored value that is not a US
                5-digit ZIP covers nothing, and the live database has one: a
                zone whose ZIP list is the single word "Michigan", matching zero
                properties. The drawer refuses these on save now, but a list you
                never open is a list that never tells you, and this card is where
                somebody looks to find out what a zone covers. */}
            {zipList.length > 0 && zipsOpen && (
              <div id={zipsId} className="mt-1 flex flex-wrap gap-1">
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
            <ZipFillPendingNote zone={zone} />
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
            {/* Two zones that list the same ZIP both match it at the exact-ZIP
                level, so the ranking decides (src/lib/zone-match.ts). Said here,
                beside the zone, rather than left for a quote to surprise. */}
            {overlaps.length > 0 && (
              <ul className="mt-2 space-y-0.5 text-xs text-amber-700 dark:text-amber-300">
                {overlaps.map((o) => (
                  <li key={o.otherId}>{zipOverlapSentence(o)}</li>
                ))}
              </ul>
            )}
            {/* A drawn zone with no ZIPs quotes nobody on the signup page or the
                lead form: public_quote matches a visitor by ZIP alone. Zones
                drawn before 2026-10-01 were never filled, so say so and offer
                the fill -- one click that opens the zone with the ZIPs inside
                its area added, for the owner to look over and save. Not a
                silent backfill: a ZIP list decides which zone an address goes
                to, and that is the owner's call. Below sm the warning takes
                its own full line and the button wraps under it; so it does
                from lg to 2xl, where the list is half of a split view. */}
            {hasGeo && zipList.length < FEW_ZIPS && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <p className="min-w-0 grow basis-full text-xs text-amber-700 sm:basis-0 lg:basis-full 2xl:basis-0 dark:text-amber-300">
                  {zipList.length === 0
                    ? "No ZIPs listed, so the signup page and lead form can't quote this area."
                    : `Only ${zipList.length} ${zipList.length === 1 ? "ZIP" : "ZIPs"} listed. The signup page and lead form quote by ZIP.`}
                </p>
                {canEdit && onFillZips && (
                  <Button size="sm" variant="outline" onClick={onFillZips}>
                    Fill ZIPs from the area
                  </Button>
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
            {isOff && (
              <p className="mt-2 text-xs text-muted-foreground">
                {offZoneNotice(zone.active_clients ?? 0)}
              </p>
            )}
          </div>
        </div>
        {/* On its own line below sm, so it reads from the left like the rest.
            Indented to the name's edge there, past the checkbox and swatch. */}
        <div className="min-w-0 ps-7 sm:ps-0 sm:text-end">
          {showsVisitPrice &&
            (zoneOverridesPrice(zone) ? (
              <>
                <div className="text-lg font-semibold">{money(zone.base_price_cents)}</div>
                <div className="text-xs text-muted-foreground">
                  base + {money(zone.per_dog_addl_cents ?? 0)} / extra dog · zone price
                </div>
              </>
            ) : (
              <>
                <div className="text-sm font-medium">Standard price</div>
                <div className="text-xs text-muted-foreground" data-testid="zone-standard-price">
                  {std.data
                    ? standardPriceLine(std.data.basePriceCents)
                    : "Uses the standard price"}
                </div>
              </>
            ))}
          {showFirstCleanup && zone.initial_cleanup_cents > 0 && (
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

      {/* The switch on the left, the row menu on the right. */}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t pt-2">
        <ZoneEnabledSwitch zone={zone} activeClientsKnown={activeClientsKnown} />
        {(hasGeo || canEdit) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" aria-label={`More actions for ${zone.name}`}>
                <MoreHorizontal className="h-4 w-4 shrink-0" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canEdit && (
                <DropdownMenuItem className="touch:min-h-11" onClick={onEdit}>
                  <Pencil className="h-4 w-4 shrink-0" /> Edit zone
                </DropdownMenuItem>
              )}
              {hasGeo && (
                <DropdownMenuItem
                  className="touch:min-h-11"
                  onClick={() => setViewingCoverage(true)}
                >
                  <Eye className="h-4 w-4 shrink-0" /> View coverage
                </DropdownMenuItem>
              )}
              {canEdit && (
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive touch:min-h-11"
                  disabled={delMut.isPending}
                  onClick={handleDelete}
                >
                  <Trash2 className="h-4 w-4 shrink-0" /> Delete zone
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
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
