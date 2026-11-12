// The Zones page list (#450): what each row says about its shape, how the
// list is searched, filtered and sorted, and which ZIPs two zones both claim.
// Pure, so the page and its tests read the same rules.

export type ZoneShape = "polygon" | "radius" | "drive_time" | "zip";

export interface ZoneListRow {
  id: string;
  name: string;
  enabled?: boolean | null;
  geo_match_mode?: string | null;
  boundary?: unknown;
  radius_meters?: number | null;
  drive_time_minutes?: number | null;
  zip_codes?: string[] | null;
  postal_prefix?: string | null;
  priority?: number | null;
  active_clients?: number | null;
  base_price_cents?: number | null;
}

/** The shape the zone matches by. A drawn mode with nothing drawn is a ZIP list. */
export function zoneShape(z: ZoneListRow): ZoneShape {
  const mode = z.geo_match_mode ?? "zip";
  if (mode === "polygon" && z.boundary) return "polygon";
  if (mode === "radius" && z.radius_meters) return "radius";
  if (mode === "drive_time" && z.drive_time_minutes) return "drive_time";
  return "zip";
}

export const SHAPE_LABEL: Record<ZoneShape, string> = {
  polygon: "Polygon",
  radius: "Radius",
  drive_time: "Drive time",
  zip: "ZIP list",
};

/** "Radius, 5.0 mi". The label a row shows next to the zone name. */
export function zoneShapeDetail(z: ZoneListRow): string {
  const shape = zoneShape(z);
  if (shape === "radius") return `Radius, ${((z.radius_meters ?? 0) / 1609).toFixed(1)} mi`;
  if (shape === "drive_time") return `Drive time, ${z.drive_time_minutes} min`;
  return SHAPE_LABEL[shape];
}

export type ZoneSort = "name" | "clients" | "price";
export type ZoneStatusFilter = "all" | "on" | "off";
export type ZoneShapeFilter = "all" | ZoneShape;

export interface ZoneListQuery {
  search: string;
  status: ZoneStatusFilter;
  shape: ZoneShapeFilter;
  sort: ZoneSort;
}

export const DEFAULT_ZONE_QUERY: ZoneListQuery = {
  search: "",
  status: "all",
  shape: "all",
  sort: "name",
};

export function zoneQueryIsFiltered(q: ZoneListQuery): boolean {
  return q.search.trim() !== "" || q.status !== "all" || q.shape !== "all";
}

/** A search matches the name, a listed ZIP, or the postal prefix. */
function matchesSearch(z: ZoneListRow, needle: string): boolean {
  if (!needle) return true;
  if (z.name.toLowerCase().includes(needle)) return true;
  if ((z.zip_codes ?? []).some((zip) => zip.toLowerCase().includes(needle))) return true;
  return !!z.postal_prefix && needle.startsWith(z.postal_prefix.toLowerCase());
}

export function filterAndSortZones<T extends ZoneListRow>(
  zones: readonly T[],
  q: ZoneListQuery,
): T[] {
  const needle = q.search.trim().toLowerCase();
  const byName = (a: T, b: T) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  const out = zones.filter(
    (z) =>
      matchesSearch(z, needle) &&
      (q.status === "all" || (q.status === "off") === (z.enabled === false)) &&
      (q.shape === "all" || zoneShape(z) === q.shape),
  );
  return out.sort((a, b) => {
    if (q.sort === "clients")
      return (b.active_clients ?? 0) - (a.active_clients ?? 0) || byName(a, b);
    if (q.sort === "price")
      return (b.base_price_cents ?? 0) - (a.base_price_cents ?? 0) || byName(a, b);
    return byName(a, b);
  });
}

export interface ZipOverlap {
  otherId: string;
  otherName: string;
  zips: string[];
  /** The zone that gets an address in these ZIPs, when the ranking settles it. */
  winner: "this" | "other" | null;
}

/**
 * ZIPs this zone lists that another zone that is on also lists. Both match at
 * the exact-ZIP level, so the ranking -- `priority`, zone-match.ts step 2 --
 * decides. Two zones with the same priority (a business the #858 migration
 * has not reached) are settled by account type and then a fixed order, which
 * the owner did not choose, so `winner` is null. Zones that are off are
 * skipped: they match nothing.
 */
export function zipOverlaps(zone: ZoneListRow, all: readonly ZoneListRow[]): ZipOverlap[] {
  if (zone.enabled === false) return [];
  const mine = new Set(zone.zip_codes ?? []);
  if (mine.size === 0) return [];
  const out: ZipOverlap[] = [];
  for (const other of all) {
    if (other.id === zone.id || other.enabled === false) continue;
    const zips = (other.zip_codes ?? []).filter((z) => mine.has(z));
    if (zips.length === 0) continue;
    const a = zone.priority ?? 0;
    const b = other.priority ?? 0;
    out.push({
      otherId: other.id,
      otherName: other.name,
      zips: [...new Set(zips)].sort(),
      winner: a === b ? null : a > b ? "this" : "other",
    });
  }
  return out;
}

/** One sentence per overlap, in plain words. */
export function zipOverlapSentence(o: ZipOverlap): string {
  const shown = o.zips.slice(0, 3).join(", ");
  const more = o.zips.length > 3 ? ` and ${o.zips.length - 3} more` : "";
  const list = `${shown}${more}`;
  const verb = o.zips.length === 1 ? "is" : "are";
  if (o.winner === "this")
    return `${list} ${verb} also in ${o.otherName}. This zone ranks higher, so it wins.`;
  if (o.winner === "other")
    return `${list} ${verb} also in ${o.otherName}, which ranks higher and wins.`;
  return `${list} ${verb} also in ${o.otherName}, at the same rank. Move one in the ranking to choose which wins.`;
}
