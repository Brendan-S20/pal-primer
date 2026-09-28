// The queued Clock in / Clock out taps, as My Day's time clock should draw
// them. The rules live in queued-clock-state.ts; this only keeps them fed, the
// same way useQueuedLifecycle feeds the visit cards.

import { useEffect, useRef, useState } from "react";
import { listPending } from "./queue";
import { resolveOfflineUserId } from "./action-owner";
import { holdClockUntilRefetched, queuedClockTaps, type ClockTap } from "./queued-clock-state";

const same = (a: readonly ClockTap[], b: readonly ClockTap[]) =>
  a.length === b.length &&
  a.every((t, i) => b[i].id === t.id && b[i].leftQueueAt === t.leftQueueAt);

/**
 * Read from IndexedDB rather than remembered in component state: the queue
 * survives a reload and the app being killed in a pocket, and what the clock
 * says has to survive both with it. Scoped to the signed-in user, resolved the
 * bounded way every other reader of the queue resolves it.
 *
 * `dataUpdatedAt` is the clock query's, and is what releases a tap once it has
 * left the queue.
 */
export function useQueuedClock(dataUpdatedAt: number): readonly ClockTap[] {
  const [held, setHeld] = useState<ClockTap[]>([]);
  const queued = useRef<ClockTap[]>([]);
  const fetchedAt = useRef(dataUpdatedAt);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      resolveOfflineUserId()
        .then((userId) => listPending(userId))
        .then((actions) => {
          if (cancelled) return;
          const q = queuedClockTaps(actions);
          queued.current = q;
          setHeld((prev) => {
            const next = holdClockUntilRefetched(prev, q, fetchedAt.current, Date.now());
            return same(prev, next) ? prev : next;
          });
        })
        .catch(() => {
          // No owner we can resolve means no queue we may attribute to this
          // person; the server's copy is all that can honestly be shown.
          if (cancelled) return;
          queued.current = [];
          setHeld((prev) => (prev.length === 0 ? prev : []));
        });
    };
    refresh();
    window.addEventListener("offline-queue-change", refresh);
    return () => {
      cancelled = true;
      window.removeEventListener("offline-queue-change", refresh);
    };
  }, []);

  useEffect(() => {
    fetchedAt.current = dataUpdatedAt;
    setHeld((prev) => {
      const next = holdClockUntilRefetched(prev, queued.current, dataUpdatedAt, Date.now());
      return same(prev, next) ? prev : next;
    });
  }, [dataUpdatedAt]);

  return held;
}
