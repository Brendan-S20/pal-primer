// The database half of zone-zip-fill.ts: look up the Census ZIP centers near
// a drawn shape, and classify them with the pure code there.
//
// Three callers, one lookup:
//   * zipsInZoneShape, the Zones drawer's "Fill ZIPs from the area";
//   * createZone and updateZone, which fill every drawn area on save (#858;
//     before that only Setup step 2 asked, with `fillZipsFromShape`, after the
//     onboarding audit of 2026-11-09, D1);
//   * internalQuote, which places a ZIP at its Census center when the address
//     has no pin, so a drawn zone that lists no ZIPs still quotes an address
//     inside it.
//
// Nothing here knows what the business runs. A dog walker's area and a
// scooper's are the same circle.

import {
  classifyZipCentroids,
  fillForSave,
  MAX_CANDIDATES,
  searchBox,
  type ZipCentroid,
  type ZipClassification,
  type ZoneShapeInput,
} from "@/lib/zone-zip-fill";

export type ShapeCentroids =
  | { status: "ok"; centroids: ZipCentroid[]; capped: boolean }
  /** Not a complete shape: a circle with no center, a two-point polygon. */
  | { status: "incomplete" }
  /** Wider than ten degrees either way; the drawer says split it. */
  | { status: "too_large" };

/** The Census ZIP centers in a shape's search box. Throws when the lookup
 *  fails; a caller that must not fail decides what that means. */
export async function zipCentroidsForShape(
  db: any,
  orgId: string,
  shape: ZoneShapeInput,
): Promise<ShapeCentroids> {
  const box = searchBox(shape);
  if (!box) return { status: "incomplete" };
  if (box.north - box.south > 10 || box.east - box.west > 10) return { status: "too_large" };
  const { data: rows, error } = await db.rpc("zip_centroids_in_box", {
    _org_id: orgId,
    _south: box.south,
    _west: box.west,
    _north: box.north,
    _east: box.east,
    _limit: MAX_CANDIDATES,
  });
  if (error) throw new Error(error.message);
  const centroids = (
    (rows ?? []) as Array<{ zip: string; lat: number; lng: number; radius_m: number }>
  ).map((r) => ({
    zip: String(r.zip),
    lat: Number(r.lat),
    lng: Number(r.lng),
    radiusM: Number(r.radius_m),
  }));
  return { status: "ok", centroids, capped: centroids.length >= MAX_CANDIDATES };
}

export type ShapeZipFill = ZipClassification & { candidatesCapped: boolean; tooLarge: boolean };

/** Which ZIPs a shape holds: what "Fill ZIPs from the area" adds. */
export async function zipsInsideShape(
  db: any,
  orgId: string,
  shape: ZoneShapeInput,
): Promise<ShapeZipFill> {
  const found = await zipCentroidsForShape(db, orgId, shape);
  if (found.status !== "ok") {
    return {
      inside: [],
      insideTotal: 0,
      edge: [],
      candidatesCapped: false,
      tooLarge: found.status === "too_large",
    };
  }
  return {
    ...classifyZipCentroids(shape, found.centroids),
    candidatesCapped: found.capped,
    tooLarge: false,
  };
}

export type ZoneSaveFill =
  | { status: "ok"; zips: string[]; centerOnly: boolean; capped: boolean }
  | { status: "incomplete" }
  | { status: "too_large" };

/** What a save lists for a drawn area (#858): the ZIPs inside its shape, or
 *  the one its middle sits in when none is. Throws when the lookup fails;
 *  the save then goes through without a fill and marks it pending. */
export async function zipsForZoneSave(
  db: any,
  orgId: string,
  shape: ZoneShapeInput,
): Promise<ZoneSaveFill> {
  const found = await zipCentroidsForShape(db, orgId, shape);
  if (found.status !== "ok") return found;
  return { status: "ok", ...fillForSave(shape, found.centroids), capped: found.capped };
}
