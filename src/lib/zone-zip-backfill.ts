// A zone drawn before #778 still lists no ZIPs (#793).
//
// #778 made Setup step 2 fill a new radius zone's ZIPs on the server. Every
// area saved BEFORE it -- from setup, or drawn on Zones before 2026-10-01 --
// still has `zip_codes = '{}'`, and public_quote (the signup page, the lead
// form) matches a visitor by ZIP and nothing else, because a form has a ZIP
// and no point. So a pilot with a 10-mile circle on Detroit gets "No service
// in that ZIP code yet" for 48226, the ZIP the circle is centred on.
//
// This file decides what filling those zones would write. Pure: the zones and
// the Census ZIP centers are passed in. Two callers apply it:
//
//   * fillEmptyZoneZips (zones.functions.ts), the owner's one click on Zones:
//     "Fill ZIPs for every area that lists none";
//   * scripts/backfill/793-zones-with-a-shape-and-no-zips.sql, the read-only
//     inventory an operator runs, which prints the same proposal as text.
//     Nothing runs its UPDATEs without Brendan's explicit approval.
//
// ── WHAT IT WILL AND WILL NOT DO ─────────────────────────────────────────
//
// It only ever makes an unquotable ZIP quotable. It never changes the zone an
// already-quotable ZIP goes to:
//
//   * Only a zone with a usable drawn shape, an EMPTY ZIP list and no postal
//     prefix is touched. A zone that lists even one ZIP was edited by a person
//     and is theirs; a prefix already quotes by ZIP.
//   * Only ZIPs whose Census center the matcher puts INSIDE the shape -- the
//     exact rule "Fill ZIPs from the area" and createZone's fill use
//     (classifyZipCentroids). Edge ZIPs are offered in the drawer, never
//     added, and never added here either.
//   * A ZIP another zone already lists, or another zone's prefix covers, is
//     left alone. public_quote ranks an exact ZIP above a prefix, so adding it
//     here would steal it from the zone quoting it today.
//   * A ZIP inside two empty zones goes to the one the matcher picks for that
//     ZIP's center (matchZone's precedence: polygon over radius, then
//     priority, then id), so the ZIP list agrees with what a pinned address
//     in the same spot is assigned to.
//   * A zone turned off is filled like one turned on: switching it back on
//     should not bring the empty list back.

import { zoneShape } from "./lead-service-area";
import {
  classifyZipCentroids,
  MAX_AUTO_ZIPS,
  type ZipCentroid,
  type ZoneShapeInput,
} from "./zone-zip-fill";
import { matchZone, type ZoneMatchFields } from "./zone-match";

export interface BackfillZone extends ZoneMatchFields {
  name: string;
}

/** A drawn zone that quotes nobody on the signup page: a shape, no ZIPs and
 *  no prefix. */
export function zoneNeedsZipBackfill(z: BackfillZone): boolean {
  if ((z.zip_codes ?? []).length > 0) return false;
  if (z.postal_prefix && z.postal_prefix.trim()) return false;
  return zoneShape(z) != null;
}

/** What the Census lookup returned for one zone's shape. */
export type ZoneCentroidLookup =
  | { status: "ok"; centroids: ZipCentroid[]; capped: boolean }
  | { status: "incomplete" }
  | { status: "too_large" }
  | { status: "failed"; message: string };

export type ZoneBackfillEntry = {
  zoneId: string;
  zoneName: string;
  /** What would be written to zip_codes, nearest the middle first. */
  zips: string[];
  /** Inside the shape, but already quoted by another zone's list or prefix. */
  claimedElsewhere: string[];
  /** Inside this shape and another empty one, and the other one wins. */
  wonByAnotherArea: string[];
  /** Why nothing (or not everything) could be filled. */
  status: "fill" | "nothing_inside" | "too_large" | "lookup_failed" | "lookup_capped";
};

export type ZoneBackfillPlan = {
  entries: ZoneBackfillEntry[];
  /** Zones that will get at least one ZIP. */
  fillCount: number;
};

/** True when zone `z`'s list or prefix already makes public_quote match
 *  `zip`. Ignores `enabled`: a turned-off zone that lists a ZIP still owns
 *  it, and gets it back when it is turned on. */
function quotesZipByList(z: ZoneMatchFields, zip: string): boolean {
  if (Array.isArray(z.zip_codes) && z.zip_codes.includes(zip)) return true;
  return !!z.postal_prefix && zip.startsWith(z.postal_prefix);
}

export function planZoneZipBackfill(
  zones: readonly BackfillZone[],
  lookups: ReadonlyMap<string, ZoneCentroidLookup>,
): ZoneBackfillPlan {
  const targets = zones.filter(zoneNeedsZipBackfill);
  const targetIds = new Set(targets.map((t) => t.id));
  const others = zones.filter((z) => !targetIds.has(z.id));
  // Who wins a ZIP center among the empty zones. All treated as on, for the
  // reason in the header; geometry only, since none of them lists a ZIP.
  const contenders = targets.map((t) => ({ ...t, enabled: true, zip_codes: [] }));

  const entries: ZoneBackfillEntry[] = [];
  for (const zone of targets) {
    const base = {
      zoneId: zone.id,
      zoneName: zone.name,
      zips: [] as string[],
      claimedElsewhere: [] as string[],
      wonByAnotherArea: [] as string[],
    };
    const found = lookups.get(zone.id);
    if (!found || found.status === "failed") {
      entries.push({ ...base, status: "lookup_failed" });
      continue;
    }
    if (found.status === "too_large") {
      entries.push({ ...base, status: "too_large" });
      continue;
    }
    if (found.status !== "ok") {
      entries.push({ ...base, status: "nothing_inside" });
      continue;
    }
    const shape = zoneShape(zone) as ZoneShapeInput;
    const byZip = new Map(found.centroids.map((c) => [c.zip, c]));
    const inside = classifyZipCentroids(shape, found.centroids, Number.MAX_SAFE_INTEGER).inside;
    for (const zip of inside) {
      if (others.some((o) => quotesZipByList(o, zip))) {
        base.claimedElsewhere.push(zip);
        continue;
      }
      const c = byZip.get(zip)!;
      const winner = matchZone(contenders, { point: { lat: c.lat, lng: c.lng } });
      if (winner && winner.id !== zone.id) {
        base.wonByAnotherArea.push(zip);
        continue;
      }
      if (base.zips.length < MAX_AUTO_ZIPS) base.zips.push(zip);
    }
    entries.push({
      ...base,
      // A capped lookup still fills what it saw: the ZIPs nearest the middle,
      // which is where the business's customers are. The rest can be added
      // in the drawer, and the status says the list is not the whole area.
      status: base.zips.length === 0 ? "nothing_inside" : found.capped ? "lookup_capped" : "fill",
    });
  }
  return { entries, fillCount: entries.filter((e) => e.zips.length > 0).length };
}

/** One line for the owner, after the fill. `written` is the zones the write
 *  actually changed. */
export function backfillSummary(plan: ZoneBackfillPlan, written: readonly string[]): string {
  if (plan.entries.length === 0) return "Every area already lists its ZIPs.";
  const done = new Set(written);
  const applied = plan.entries.filter((e) => done.has(e.zoneId));
  if (applied.length === 0) {
    return plan.entries.some((e) => e.status === "lookup_failed")
      ? "Could not look up the ZIPs for these areas. Try again, or open each area and use Fill ZIPs from the area."
      : "No ZIP inside these areas could be added. Open each area to add ZIPs by hand.";
  }
  const zips = applied.reduce((n, e) => n + e.zips.length, 0);
  const left = plan.entries.length - applied.length;
  return (
    `Added ${zips} ${zips === 1 ? "ZIP" : "ZIPs"} to ${applied.length} ${applied.length === 1 ? "area" : "areas"}.` +
    (left > 0
      ? ` ${left} ${left === 1 ? "area still lists" : "areas still list"} none. Open ${left === 1 ? "it" : "each"} to add ZIPs by hand.`
      : "")
  );
}
