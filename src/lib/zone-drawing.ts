// What a click does while a polygon zone is being drawn (gaps-r2-09).
//
// Clicking the first corner again is how people close a shape in every
// drawing tool. It used to DELETE that corner -- every vertex click removed
// the vertex -- so four corners and a "closing" click saved a triangle of
// corners 2-4. Now a click on the first corner, once there are three or more,
// closes the shape and keeps every corner; the saved polygon is the drawn one.
//
// Pure, so the rules are tested without a map (the map itself goes only
// through useMapRenderer).

import type { LatLng } from "@/lib/maps/types";

export type PolygonDraft = { points: LatLng[]; closed: boolean };

/** A click on the map: a new corner, unless the shape is already closed. */
export function clickMap(d: PolygonDraft, p: LatLng): PolygonDraft {
  if (d.closed) return d;
  return { points: [...d.points, p], closed: false };
}

/** A click on corner `i`. The first corner closes an open shape of three or
 *  more and never removes itself while closed (a double-click must not undo
 *  the close it just made). Any other click removes that corner; a shape
 *  left with fewer than three is open again. */
export function clickVertex(d: PolygonDraft, i: number): PolygonDraft {
  if (i === 0 && d.points.length >= 3) {
    return d.closed ? d : { points: d.points, closed: true };
  }
  const points = d.points.filter((_, idx) => idx !== i);
  return { points, closed: d.closed && points.length >= 3 };
}

/** Undo reopens a closed shape first, and only then takes back a corner. */
export function undoDraft(d: PolygonDraft): PolygonDraft {
  if (d.closed) return { points: d.points, closed: false };
  return { points: d.points.slice(0, -1), closed: false };
}
