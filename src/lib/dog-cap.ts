// A walk over its dog cap is warned, then allowed (#731).
//
// Brendan, 2026-11-10 2:24 PM ET: "Warn but allow going over the dog cap".
// The database refuses any write that would put a group walk over its
// walker's staff.max_dogs_per_walk unless the person confirmed it
// (20261111160000, walk_dog_cap_guard). Every path that assigns work
// (the Group walks panel, drag on the board, the visit drawer, bulk assign
// and Cover) turns that refusal into this warning, shows it, and on "Assign
// anyway" sends the same write again with the confirmation header, which the
// database records in walk_dog_cap_overrides (who, when, how far over).
//
// Cancel sends nothing, and the refused write was rolled back whole, so
// cancelling changes nothing.

/** The header that carries "Assign anyway" to the database. */
export const DOG_CAP_HEADER = "x-dog-cap-acknowledged";
export const DOG_CAP_HEADER_VALUE = "yes";

export type DogCapWarning = {
  dogs: number;
  cap: number;
  /** The walker's display name, when the database knows it. */
  walker: string | null;
  walkGroupId: string | null;
  staffId: string | null;
};

/** The refusal walk_dog_cap_guard raises, read back from a PostgREST error,
 *  or null when the error is anything else (the time-off guard shares its
 *  SQLSTATE, 23514, and is told apart by the hint). */
export function dogCapWarningFromError(
  error:
    { hint?: string | null; details?: string | null; message?: string | null } | null | undefined,
): DogCapWarning | null {
  if (!error || error.hint !== "dog_cap") return null;
  let d: Record<string, unknown> = {};
  try {
    d = JSON.parse(error.details ?? "{}") as Record<string, unknown>;
  } catch {
    d = {};
  }
  let dogs = Number(d.dogs);
  let cap = Number(d.cap);
  if (!Number.isFinite(dogs) || !Number.isFinite(cap)) {
    const m = /will have (\d+) dogs; the cap is (\d+)/.exec(error.message ?? "");
    if (!m) return null;
    dogs = Number(m[1]);
    cap = Number(m[2]);
  }
  return {
    dogs,
    cap,
    walker: typeof d.walker === "string" ? d.walker : null,
    walkGroupId: typeof d.walk_group_id === "string" ? d.walk_group_id : null,
    staffId: typeof d.staff_id === "string" ? d.staff_id : null,
  };
}

/** "This walk will have 7 dogs; the cap is 6." The owner's own example. */
export function dogCapSentence(w: Pick<DogCapWarning, "dogs" | "cap">): string {
  return `This walk will have ${w.dogs} dogs; the cap is ${w.cap}.`;
}

/** What a write answers when it was refused for the cap and nothing saved. */
export type DogCapRefused = {
  overCap: DogCapWarning;
  /** Cover: how many visits fit nobody's cap (the warning shows the first). */
  overCapVisits?: number;
};

export function isDogCapRefused(r: unknown): r is DogCapRefused {
  return Boolean(r && typeof r === "object" && "overCap" in r && (r as DogCapRefused).overCap);
}

/** A PostgREST builder with the header set when the person confirmed. */
export function withDogCapAck<T extends { setHeader(name: string, value: string): T }>(
  builder: T,
  acknowledged: boolean | undefined,
): T {
  return acknowledged ? builder.setHeader(DOG_CAP_HEADER, DOG_CAP_HEADER_VALUE) : builder;
}

/** A walk over the cap right now, from walks_over_dog_cap. */
export type OverCapWalk = {
  walkGroupId: string;
  staffId: string;
  visitIds: string[];
  dogs: number;
  cap: number;
};

/** visit id -> its walk's numbers, for the flags on the board and My Day. */
export function overCapByVisit(walks: OverCapWalk[]): Map<string, OverCapWalk> {
  const out = new Map<string, OverCapWalk>();
  for (const w of walks) for (const id of w.visitIds) out.set(id, w);
  return out;
}

/**
 * Warn, then allow, as one flow every assign control shares:
 * sends `attempt(false)`; if the database refused it for the cap (nothing
 * saved), asks; on "Assign anyway" sends `attempt(true)`. Null when the
 * person cancelled, and then nothing was sent a second time.
 */
export async function runWithDogCapWarning<T>(
  attempt: (acknowledged: boolean) => Promise<T>,
  ask: (warning: DogCapWarning, count?: number) => Promise<boolean>,
): Promise<T | null> {
  const first = await attempt(false);
  if (!isDogCapRefused(first)) return first;
  if (!(await ask(first.overCap, first.overCapVisits))) return null;
  return attempt(true);
}
