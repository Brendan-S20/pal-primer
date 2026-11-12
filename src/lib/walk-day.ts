/** How a walk reads on the walker's day (#410). Pure, so My Day's cards and
 *  the tests share one copy. Read from the day's visit list: nothing here
 *  asks the server for more. */

type ServiceRef = { service_line?: string | null; default_duration_min?: number | null } | null;

export type DayVisit = {
  id: string;
  sequence?: number | null;
  status?: string | null;
  walk_group_id?: string | null;
  /** The day the stop is on; read for the dog cap flag (#731). */
  scheduled_on?: string | null;
  services?: ServiceRef | ServiceRef[];
  clients?: { display_name?: string | null } | null;
  properties?: {
    street?: string | null;
    dogs?: { name?: string | null }[] | null;
  } | null;
};

const one = <T,>(v: T | T[] | null | undefined): T | null =>
  Array.isArray(v) ? (v[0] ?? null) : (v ?? null);

/** A stop whose service is a dog walk. Every other stop, pet waste included,
 *  keeps the card it has always had. */
export function isWalkVisit(v: Pick<DayVisit, "services"> | null | undefined): boolean {
  return one(v?.services ?? null)?.service_line === "dog_walking";
}

/** The walk's booked length, from the service, or null when it has none. */
export function walkLengthMin(v: Pick<DayVisit, "services"> | null | undefined): number | null {
  const n = one(v?.services ?? null)?.default_duration_min;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

/** Whole minutes out on the walk so far. Null for an unreadable start. */
export function minutesOut(startedAt: string | null | undefined, now: number): number | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return null;
  return Math.max(0, Math.floor((now - start) / 60_000));
}

export type GroupMate = {
  id: string;
  /** Position in the pickup order, from 1. */
  order: number;
  /** The dogs' names, or the client's name when no dog is on file. */
  label: string;
  street: string | null;
  isThis: boolean;
};

/** Everyone in this visit's group walk today, in pickup order (the route's
 *  sequence; a stop not yet sequenced goes last, in list order). Empty when
 *  the visit is not in a group. Cancelled and skipped stops are left out:
 *  nobody is picked up there. */
export function groupWalkMates(visit: DayVisit, dayVisits: readonly DayVisit[]): GroupMate[] {
  const group = visit.walk_group_id;
  if (!group) return [];
  const members = dayVisits
    .map((v, i) => ({ v, i }))
    .filter(
      ({ v }) =>
        v.walk_group_id === group && v.status !== "canceled" && v.status !== "skipped",
    )
    .sort((a, b) => {
      const sa = a.v.sequence ?? Number.POSITIVE_INFINITY;
      const sb = b.v.sequence ?? Number.POSITIVE_INFINITY;
      return sa === sb ? a.i - b.i : sa - sb;
    });
  return members.map(({ v }, idx) => {
    const dogs = (v.properties?.dogs ?? [])
      .map((d) => (d?.name ?? "").trim())
      .filter(Boolean);
    return {
      id: v.id,
      order: idx + 1,
      label: dogs.length ? dogs.join(", ") : (v.clients?.display_name ?? "").trim(),
      street: v.properties?.street ?? null,
      isThis: v.id === visit.id,
    };
  });
}
