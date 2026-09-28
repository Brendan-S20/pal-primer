// The queued Start / Complete / Skip of every visit, as My Day should draw them.
// The rules live in queued-visit-state.ts; this only keeps them fed.

import { useEffect, useRef, useState } from "react";
import { listPending } from "./queue";
import { resolveOfflineUserId } from "./action-owner";
import {
  holdUntilRefetched,
  queuedLifecycleByVisit,
  type HeldLifecycle,
  type QueuedLifecycle,
} from "./queued-visit-state";

const same = (a: ReadonlyMap<string, HeldLifecycle>, b: ReadonlyMap<string, HeldLifecycle>) =>
  a.size === b.size &&
  [...a].every(
    ([k, v]) =>
      b.get(k)?.leftQueueAt === v.leftQueueAt && b.get(k)?.kind === v.kind && b.get(k)?.at === v.at,
  );

/**
 * Read from IndexedDB, not remembered in component state, for the same reason
 * useQueuedStationIds is: the queue survives a reload, the app being killed in a
 * pocket and the card collapsing, and what the screen says about a visit has to
 * survive all three with it. A tech who completes stop 5 in a dead zone and
 * reopens the app in the same dead zone should still see stop 6 as next.
 *
 * Scoped to the signed-in tech, resolved the bounded way every other reader of
 * the queue resolves it: on a shared tablet the previous tech's queued
 * completions are not this tech's day.
 *
 * `dataUpdatedAt` is the day query's, and is what releases an entry once it has
 * left the queue — see holdUntilRefetched.
 */
export function useQueuedLifecycle(dataUpdatedAt: number): ReadonlyMap<string, HeldLifecycle> {
  const [held, setHeld] = useState<Map<string, HeldLifecycle>>(() => new Map());
  const queued = useRef<Map<string, QueuedLifecycle>>(new Map());
  const fetchedAt = useRef(dataUpdatedAt);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      resolveOfflineUserId()
        .then((userId) => listPending(userId))
        .then((actions) => {
          if (cancelled) return;
          const q = queuedLifecycleByVisit(actions);
          queued.current = q;
          setHeld((prev) => {
            const next = holdUntilRefetched(prev, q, fetchedAt.current, Date.now());
            return same(prev, next) ? prev : next;
          });
        })
        .catch(() => {
          // No owner we can resolve means no queue we may attribute. Showing
          // nothing understates; inventing a completion would hide a live stop.
          if (cancelled) return;
          queued.current = new Map();
          setHeld((prev) => (prev.size === 0 ? prev : new Map()));
        });
    };
    refresh();
    // Enqueue marks a visit; the delete a successful replay does is what
    // starts releasing it.
    window.addEventListener("offline-queue-change", refresh);
    return () => {
      cancelled = true;
      window.removeEventListener("offline-queue-change", refresh);
    };
  }, []);

  useEffect(() => {
    fetchedAt.current = dataUpdatedAt;
    setHeld((prev) => {
      const next = holdUntilRefetched(prev, queued.current, dataUpdatedAt, Date.now());
      return same(prev, next) ? prev : next;
    });
  }, [dataUpdatedAt]);

  return held;
}
