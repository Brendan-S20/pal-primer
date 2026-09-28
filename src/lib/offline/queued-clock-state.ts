// What My Day's time clock shows while a Clock in or Clock out is sitting in
// the offline queue.
//
// The same shape of problem queued-visit-state.ts solves for visits, and the
// same answer: the page reads the server's copy (getMyClock, possibly restored
// from disk) and the tap went into IndexedDB, so the display is DERIVED from
// both rather than patched with a flag a reload would lose. A tech who clocks
// in at the yard with no signal and reopens the app down the road still sees
// "On the clock since 7:02" -- the tap time, which is also what the replay
// will send as `at`.
//
// Pure functions, so the rules are tested without a browser or a queue.

import type { NewAction, PendingAction } from "./queue";
import type { ClockEntry } from "@/lib/time-clock";

export type ClockKind = "clock_in" | "clock_out";

export function isClockKind(kind: string): kind is ClockKind {
  return kind === "clock_in" || kind === "clock_out";
}

/** A queued tap. `id` is the queue action's, so a tap can be held on screen
 *  after it leaves the queue (see holdClockUntilRefetched). */
export type ClockTap = { id: string; kind: ClockKind; at: number; leftQueueAt?: number };

/** The caller's queued clock taps, in replay order (oldest first). */
export function queuedClockTaps(pending: readonly PendingAction[]): ClockTap[] {
  return pending
    .filter((a) => isClockKind(a.kind))
    .map((a) => ({ id: a.id, kind: a.kind as ClockKind, at: a.ts }))
    .sort((a, b) => a.at - b.at);
}

/**
 * The server's entries with every tap applied on top, in the order the replay
 * will run them, following the server's own rules:
 *
 *  - Clock in while a shift is open does nothing (clock_in is idempotent);
 *    otherwise it opens a shift at the tap time.
 *  - Clock out with nothing open does nothing (clock_out returns NULL);
 *    otherwise it closes the open shift at the tap time.
 *
 * `queued` is the kind of the last tap that CHANGED something and is still in
 * the queue, which is what the "waiting to sync" line under the button says.
 */
export function withQueuedClock(
  entries: readonly ClockEntry[],
  taps: readonly ClockTap[],
): { entries: ClockEntry[]; open: ClockEntry | null; queued: ClockKind | null } {
  const out = entries.map((e) => ({ ...e }));
  let open = out.find((e) => e.clock_out == null) ?? null;
  let queued: ClockKind | null = null;
  for (const t of [...taps].sort((a, b) => a.at - b.at)) {
    if (t.kind === "clock_in") {
      if (open) continue;
      open = {
        id: `queued-${t.id}`,
        staff_id: out[0]?.staff_id ?? "",
        clock_in: new Date(t.at).toISOString(),
        clock_out: null,
        clock_in_source: "tech_offline_replay",
      };
      out.push(open);
    } else {
      if (!open) continue;
      // The server moves a clock-out that is not after the clock-in; so does
      // this, so the screen never shows a negative shift.
      const inMs = Date.parse(open.clock_in);
      open.clock_out = new Date(Math.max(t.at, inMs + 1000)).toISOString();
      open.clock_out_source = "tech_offline_replay";
      open = null;
    }
    queued = t.leftQueueAt == null ? t.kind : queued;
  }
  return { entries: out, open, queued };
}

/**
 * Keep a tap on screen after it has left the queue until the clock has been
 * fetched SINCE -- the same rule as holdUntilRefetched for visits. The replay
 * deletes the action the moment the server accepts it and the refetch comes
 * after, so reading the queue alone would flip the button back to Clock in
 * for however long that refetch takes.
 */
export function holdClockUntilRefetched(
  prev: readonly ClockTap[],
  queued: readonly ClockTap[],
  dataUpdatedAt: number,
  now: number,
): ClockTap[] {
  const live = new Set(queued.map((t) => t.id));
  const out: ClockTap[] = [...queued];
  for (const t of prev) {
    if (live.has(t.id)) continue;
    const leftQueueAt = t.leftQueueAt ?? now;
    if (dataUpdatedAt < leftQueueAt) out.push({ ...t, leftQueueAt });
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * A clock tap that repeats the one queued just before it for the same person
 * is the same tap: return the first, so a double tap cannot queue two. An
 * alternating in/out/in is three real taps and is left alone.
 */
export function clockCollision(
  queue: readonly PendingAction[],
  action: NewAction,
): PendingAction | null {
  if (!isClockKind(action.kind)) return null;
  const mine = queue
    .filter((a) => a.userId === action.userId && isClockKind(a.kind))
    .sort((a, b) => a.ts - b.ts);
  const last = mine[mine.length - 1];
  return last && last.kind === action.kind ? last : null;
}
