// What My Day shows for a visit whose Start, Complete or Skip is sitting in the
// offline queue.
//
// ── THE QUEUE WORKED AND THE SCREEN DID NOT MOVE ON ──────────────────────────
//
// Found by a field tester on 2026-09-27. Complete, offline: the queue took it,
// the toast said "Queued. Completes when back online", and the replay later
// landed with the real tap time. Nothing was lost. But the screen never learned
// what the tech had done. The card still said "in progress", Complete was still
// live, the progress count had not moved, the bottom bar still read "IN
// PROGRESS · #5 Resume", and the next stop was never promoted. A second tap on
// Complete queued a second completion. Start and Skip had the same gap — a
// queued Start left Start pressable, so the same stop could be started twice.
//
// The cause is that the page drew from one source (the server's copy of the
// day, possibly restored from disk) and the tech's work went into another (the
// IndexedDB queue), and nothing joined them. Only a successful online action
// invalidated the query; a queued one changed nothing the page read.
//
// So the display is DERIVED from both, here, rather than patched with a flag
// that a reload would lose: the queue is on the device, it survives the app
// being killed in a pocket, and a tech who reopens My Day in the same dead zone
// sees the same thing they saw before. Pure functions, so the rules can be
// tested without a browser, an IndexedDB or a server.

import type { PendingAction, NewAction } from "./queue";

/** The three actions that move a visit through its lifecycle. Photos and
 *  station logs are evidence ABOUT a visit and change nothing here. */
export type LifecycleKind = "start" | "complete" | "skip";

export function isLifecycleKind(kind: string): kind is LifecycleKind {
  return kind === "start" || kind === "complete" || kind === "skip";
}

/** Complete and skip end a visit. Once one of them is queued, nothing else
 *  that is queued for the visit afterwards can do anything: the server refuses
 *  a second ending, and a Start after an ending. */
const isTerminal = (kind: LifecycleKind) => kind === "complete" || kind === "skip";

/** Where a visit will be once its queued lifecycle actions replay. */
export type QueuedLifecycle =
  | { kind: "start"; at: number }
  | { kind: "complete"; at: number; startedAt?: number }
  | { kind: "skip"; at: number; startedAt?: number; code: string; reason: string };

/**
 * The queued lifecycle state of every visit that has one, by visit id.
 *
 * Read in the order the replay will run (oldest first, which is `syncQueue`'s
 * order), and the FIRST ending wins, because that is the one the server will
 * accept. Anything after it is ignored: it is either a duplicate or a thing the
 * server will refuse, and showing it would describe a day that will not
 * happen.
 */
export function queuedLifecycleByVisit(
  pending: readonly PendingAction[],
): Map<string, QueuedLifecycle> {
  const out = new Map<string, QueuedLifecycle>();
  const ordered = [...pending].sort((a, b) => a.ts - b.ts);
  for (const a of ordered) {
    // Every lifecycle kind carries a visit; the guard on visitId is for the
    // compiler, whose union also holds the time clock's visit-less taps.
    if (!isLifecycleKind(a.kind) || !a.visitId) continue;
    const prev = out.get(a.visitId);
    if (prev && isTerminal(prev.kind)) continue;
    if (a.kind === "start") {
      if (!prev) out.set(a.visitId, { kind: "start", at: a.ts });
      continue;
    }
    const startedAt = prev?.kind === "start" ? prev.at : undefined;
    if (a.kind === "complete") {
      out.set(a.visitId, { kind: "complete", at: a.ts, startedAt });
    } else if (a.kind === "skip") {
      const s = a as Extract<PendingAction, { kind: "skip" }>;
      out.set(a.visitId, { kind: "skip", at: a.ts, startedAt, code: s.code, reason: s.reason });
    }
  }
  return out;
}

/** Statuses the server has settled. A queued action never overrides one: if the
 *  server already says completed, the replay landed (or somebody else closed
 *  the visit), and either way the server is the one telling the truth. */
const SETTLED = new Set(["completed", "skipped", "canceled"]);

type VisitLike = {
  id: string;
  status: string;
  started_at?: string | null;
  completed_at?: string | null;
  skipped_at?: string | null;
  skip_reason?: string | null;
  skip_reason_code?: string | null;
};

/** A visit as My Day draws it. `queuedSync` names the queued action the status
 *  came from, and is absent when the status is the server's own. */
export type DisplayedVisit<V> = V & { queuedSync?: LifecycleKind };

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * The day as the tech has actually worked it: the server's visits, with every
 * queued Start, Complete and Skip applied on top.
 *
 * The server wins wherever it has already moved at least as far — a settled
 * status is never overridden, and a queued Start does nothing to a visit the
 * server already has in progress. The times are the TAP times, the same values
 * the replay sends (`action.ts`), so "started 9:15" on screen is what the row
 * will say once it lands.
 */
export function withQueuedLifecycle<V extends VisitLike>(
  visits: readonly V[],
  queued: ReadonlyMap<string, QueuedLifecycle>,
): DisplayedVisit<V>[] {
  if (queued.size === 0) return visits as DisplayedVisit<V>[];
  return visits.map((v): DisplayedVisit<V> => {
    const q = queued.get(v.id);
    if (!q || SETTLED.has(v.status)) return v;
    const queuedStart = q.kind === "start" ? q.at : q.startedAt;
    const startedAt = v.started_at ?? (queuedStart != null ? iso(queuedStart) : null);
    switch (q.kind) {
      case "start":
        // Only a scheduled visit is moved by a Start. In progress already
        // means the server has it; missed is the overnight sweep, and Start is
        // not the button that closes one of those.
        if (v.status !== "scheduled") return v;
        return {
          ...v,
          status: "in_progress",
          started_at: startedAt,
          queuedSync: "start",
        } as DisplayedVisit<V>;
      case "complete":
        return {
          ...v,
          status: "completed",
          started_at: startedAt,
          completed_at: iso(q.at),
          queuedSync: "complete",
        } as DisplayedVisit<V>;
      case "skip":
        return {
          ...v,
          status: "skipped",
          skipped_at: iso(q.at),
          skip_reason_code: q.code,
          skip_reason: q.reason,
          queuedSync: "skip",
        } as DisplayedVisit<V>;
    }
  });
}

/** An entry that is being held on screen after it left the queue. */
export type HeldLifecycle = QueuedLifecycle & {
  /** When this device first saw it gone from the queue. Absent while queued. */
  leftQueueAt?: number;
};

/**
 * Keep showing what the tech did until the server has been ASKED since.
 *
 * The replay deletes each action the moment the server accepts it, and the
 * day is refetched only after the whole loop has finished. Reading the queue
 * alone, a completed card would flip back to "in progress" — with Complete
 * live again — for however long that refetch takes, and a tech who tapped it
 * would get the server's refusal of a visit that is already done.
 *
 * So an entry that leaves the queue is held until the day has been fetched
 * AFTER it left (`dataUpdatedAt >= leftQueueAt`), and then dropped, whatever
 * the server says. That covers the other way an action leaves the queue, too:
 * a dead-lettered completion is gone from the queue and NOT done, the refetch
 * shows the visit still open, and the card goes back to saying so — which,
 * with the toast naming the stop, is how the tech learns to go back.
 */
export function holdUntilRefetched(
  prev: ReadonlyMap<string, HeldLifecycle>,
  queued: ReadonlyMap<string, QueuedLifecycle>,
  dataUpdatedAt: number,
  now: number,
): Map<string, HeldLifecycle> {
  const out = new Map<string, HeldLifecycle>(queued);
  for (const [id, h] of prev) {
    if (queued.has(id)) continue;
    const leftQueueAt = h.leftQueueAt ?? now;
    if (dataUpdatedAt < leftQueueAt) out.set(id, { ...h, leftQueueAt });
  }
  return out;
}

/**
 * Whether a lifecycle action about to be queued is already covered by one in
 * the queue.
 *
 * The screen now stops a second tap, but it learns about the first one from an
 * IndexedDB read that lands a few milliseconds after the toast, and a gloved
 * double-tap is faster than that. So the queue refuses to hold two of the same
 * thing on its own account:
 *
 *  - the same action again for the same visit is a DUPLICATE, and the one
 *    already queued is the answer — the tap happened, it is recorded, and the
 *    first tap's time is the true one;
 *  - anything after a queued Complete or Skip is a CONFLICT: the server will
 *    refuse it on replay, and a refusal burns attempts until it is
 *    dead-lettered. Better to say so now, at the fence, than to queue it.
 */
export function lifecycleCollision(
  queue: readonly PendingAction[],
  action: NewAction,
): { duplicate: PendingAction } | { conflict: string } | null {
  if (!isLifecycleKind(action.kind)) return null;
  const mine = queue.filter(
    (a) => a.userId === action.userId && a.visitId === action.visitId && isLifecycleKind(a.kind),
  );
  const same = mine.find((a) => a.kind === action.kind);
  if (same) return { duplicate: same };
  const ending = mine.find((a) => isTerminal(a.kind as LifecycleKind));
  if (ending) {
    return {
      conflict:
        ending.kind === "complete"
          ? "This visit is already completed on this device and waiting to sync."
          : "This visit is already skipped on this device and waiting to sync.",
    };
  }
  return null;
}
