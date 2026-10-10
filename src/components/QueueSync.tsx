// The offline queue replays from every signed-in screen, not only My Day.
//
// Mounted ONCE, by the `_authenticated` layout, so the replay on launch and on
// every reconnect runs whichever page is open. See lib/offline/queue-replay.ts
// for why it moved, and lib/offline/auto-sync.ts for why one mount means one
// replay even under StrictMode.
//
// My Day reads `runSync` from here for its Sync button (the only "tap"), and
// writes the day's client names into `visitNames` so a message about work that
// has to be redone can name the stop.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from "react";
import type { MutableRefObject, ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useSyncCallers } from "@/hooks/useSyncCallers";
import { startAutoSync, type SyncTrigger } from "@/lib/offline/auto-sync";
import { isDefinitelyOffline } from "@/lib/offline/connectivity";
import { resolveOfflineUserId } from "@/lib/offline/action-owner";
import { makeQueueReplay } from "@/lib/offline/queue-replay";
import type { SyncResult } from "@/lib/offline/sync";

export interface QueueSyncValue {
  runSync: (trigger: SyncTrigger) => Promise<void>;
  visitNames: MutableRefObject<Map<string, string>>;
}

// Outside the provider (a server render of a page in a test) there is nothing
// to replay with, so the default does nothing rather than throwing.
const QueueSyncContext = createContext<QueueSyncValue>({
  runSync: async () => {},
  visitNames: { current: new Map() },
});

export function useQueueSync(): QueueSyncValue {
  return useContext(QueueSyncContext);
}

export function QueueSyncProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const callers = useSyncCallers();
  const { t } = useTranslation();
  // The toasts read the CURRENT language through a ref rather than closing
  // over `t`: `t` in runSync's dependencies would rebuild the driver on a
  // language change, and startAutoSync below treats a new driver as a new
  // mount and replays the queue again.
  const tRef = useRef(t);
  tRef.current = t;

  // Client names for the two messages that ask a tech to go back and redo
  // work, written by My Day as it renders. A ref, so a refetch there does not
  // rebuild the driver here.
  const visitNames = useRef<Map<string, string>>(new Map());
  /** "Bark Park and 2 others", or nothing when we cannot name any of them.
   *  A queued action can outlive the day it belongs to -- it survives the app
   *  being killed in a pocket -- so an id with no name is expected and
   *  simply contributes none. */
  const namesFor = useCallback((ids: string[]): string | undefined => {
    const named = ids.map((id) => visitNames.current.get(id)).filter(Boolean) as string[];
    if (named.length === 0) return undefined;
    if (named.length === 1) return named[0];
    if (named.length === 2)
      return tRef.current("sync.twoNames", { first: named[0], second: named[1] });
    return tRef.current("sync.andOthers", { first: named[0], count: named.length - 1 });
  }, []);

  const report = useCallback(
    (res: SyncResult, trigger: SyncTrigger) => {
      if (res.alreadyRunning) {
        // A replay is already in flight. Saying nothing is indistinguishable from
        // a dead button -- so the BUTTON is told. An automatic run (launch, back
        // online) is not a request anybody made, and the replay in flight is
        // already doing its job. See lib/offline/auto-sync.
        if (trigger === "tap") toast.info(tRef.current("sync.alreadySyncing"));
        return;
      }
      if (res.succeeded > 0) {
        toast.success(tRef.current("sync.synced", { count: res.succeeded }));
        qc.invalidateQueries({ queryKey: ["my-day"] });
      }
      if (res.dropped > 0) {
        // Never folded into the success count: this is a photo whose bytes are
        // gone, and the tech is the only person who can retake it.
        toast.error(tRef.current("sync.photosLost", { count: res.dropped }), {
          description: namesFor(res.droppedVisitIds),
        });
        qc.invalidateQueries({ queryKey: ["my-day"] });
      }
      if (res.deadLettered > 0) {
        // Loud, specific, and never folded into any other count. Giving up
        // unblocks the day, but the work itself is gone and only the tech can
        // redo it -- so it names the stop.
        toast.error(tRef.current("sync.deadLettered", { count: res.deadLettered }), {
          duration: 12_000,
          description: namesFor(res.deadLetteredVisitIds),
        });
        qc.invalidateQueries({ queryKey: ["my-day"] });
      }
      if (res.failed > 0) {
        toast.error(tRef.current("sync.stalled"));
      }
    },
    [qc, namesFor],
  );

  // resolveOfflineUserId, NOT supabase.auth.getSession(): getSession refreshes
  // an expired token over the network first, which offline hangs for ever.
  const runSync = useMemo(
    () => makeQueueReplay({ callers, resolveUserId: () => resolveOfflineUserId(), report }),
    [callers, report],
  );

  // On launch, and whenever the device comes back online — from any page.
  // Once per REAL mount: the launch replay is scheduled and the cleanup
  // cancels it, so StrictMode's rehearsal mount starts nothing, and this is
  // the only place in the app that starts it.
  useEffect(() => startAutoSync(runSync, window, isDefinitelyOffline), [runSync]);

  const value = useMemo(() => ({ runSync, visitNames }), [runSync]);
  return <QueueSyncContext.Provider value={value}>{children}</QueueSyncContext.Provider>;
}
