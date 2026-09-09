// The order a person walks a canvassing list in.
//
// The queue used to be `rows.filter(...)` where `rows` came back
// `ORDER BY created_at DESC` — insertion order, newest first. On the demo
// workspace that interleaves three streets in two cities and, within a street,
// hands out house numbers in whatever order the seeder happened to insert
// them. Walk mode then sends somebody door to door in that sequence.
//
// Two orderings, in this priority:
//
//   1. Doors with a coordinate are chained nearest-to-nearest from the first
//      one. Not a solved tour — this is a person on a footpath, and the
//      difference between a greedy chain and an optimal one over a dozen
//      houses on two streets is not worth the code. What matters is that the
//      chain never crosses town and comes back.
//   2. Doors without one are grouped by their street text and ordered by house
//      number inside it, which is what "walk this street" means when nothing
//      has been geocoded. They go after the mapped ones, because a tech who
//      can see pins should be sent to the pins first.
//
// Pure, and separated from the route so it can be tested without a browser:
// `npm test` runs vitest in the node environment and there is no jsdom here.

export type WalkDoor = {
  id: string;
  address_line: string;
  latitude?: number | null;
  longitude?: number | null;
};

/** Straight-line kilometres. A canvasser walks; road distance is not the
 *  question and a footpath is not in any road graph we have. */
function km(a: WalkDoor, b: WalkDoor): number {
  const R = 6371.0088;
  const la1 = (a.latitude as number) * (Math.PI / 180);
  const la2 = (b.latitude as number) * (Math.PI / 180);
  const dla = la2 - la1;
  const dlo = ((b.longitude as number) - (a.longitude as number)) * (Math.PI / 180);
  const h = Math.sin(dla / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dlo / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

const mapped = (d: WalkDoor) => typeof d.latitude === "number" && typeof d.longitude === "number";

/** House number and street, for the unmapped tail. "1418 Bouldin Ave, Austin"
 *  sorts under "bouldin ave, austin" at 1418; anything without a leading
 *  number keeps its whole line as the group and sorts at the end of it. */
function streetKey(line: string): { street: string; number: number } {
  const m = /^(\d+)\s+(.*)$/.exec(line.trim());
  if (!m) return { street: line.trim().toLowerCase(), number: Number.MAX_SAFE_INTEGER };
  return { street: m[2].trim().toLowerCase(), number: Number(m[1]) };
}

export function orderForWalk<T extends WalkDoor>(doors: readonly T[]): T[] {
  const withPoint = doors.filter(mapped);
  const without = doors.filter((d) => !mapped(d));

  const chained: T[] = [];
  const pool = [...withPoint];
  let cur = pool.shift();
  while (cur) {
    chained.push(cur);
    let bestAt = -1;
    let best = Infinity;
    for (let i = 0; i < pool.length; i++) {
      const d = km(cur, pool[i]);
      if (d < best) {
        best = d;
        bestAt = i;
      }
    }
    cur = bestAt === -1 ? undefined : pool.splice(bestAt, 1)[0];
  }

  const tail = [...without].sort((a, b) => {
    const ka = streetKey(a.address_line);
    const kb = streetKey(b.address_line);
    if (ka.street !== kb.street) return ka.street < kb.street ? -1 : 1;
    if (ka.number !== kb.number) return ka.number - kb.number;
    return a.address_line.localeCompare(b.address_line);
  });

  return [...chained, ...tail];
}
