// One replay of the offline queue: who is asking, then syncQueue, then the
// result handed to whoever reports it.
//
// ── IT ONLY RAN WHILE MY DAY WAS OPEN ───────────────────────────────────────
//
// This lived inside My Day as `runSync`, and the effect that replays on
// reconnect (startAutoSync) was mounted by My Day alone. A tech who queued a
// Complete in a dead zone and then opened the Waste log, Alerts or the More
// sheet before signal came back had a queue that sat there until they went
// back to Today. The time clock and expenses are queued from screens that are
// not My Day at all.
//
// The replay is now started once, by components/QueueSync.tsx in the
// `_authenticated` layout, which lives for as long as anyone is signed in. My
// Day's Sync button calls the same function, so a tap and a reconnect share
// one replay and one `alreadyRunning` gate.
//
// Kept free of React so it can be driven in a test without a DOM: the owner is
// resolved on every run (never captured once), and listPending inside
// syncQueue only ever returns that owner's rows, so one person's queued work
// is never replayed under another's session.

import { syncQueue, type SyncCallers, type SyncResult } from "./sync";
import type { SyncTrigger } from "./auto-sync";

export interface QueueReplayDeps {
  callers: SyncCallers;
  /** Who is signed in now. resolveOfflineUserId in the app: bounded, so an
   *  expired token offline cannot hang the replay. Throws when nobody can be
   *  named, and then there is nothing of anyone's to replay. */
  resolveUserId: () => Promise<string>;
  /** What the run did. Not called when no owner could be resolved. */
  report: (result: SyncResult, trigger: SyncTrigger) => void;
  /** syncQueue in the app; a seam for tests. */
  replay?: (callers: SyncCallers, userId: string) => Promise<SyncResult>;
}

export function makeQueueReplay(deps: QueueReplayDeps): (trigger: SyncTrigger) => Promise<void> {
  const replay = deps.replay ?? syncQueue;
  return async (trigger) => {
    let uid: string;
    try {
      uid = await deps.resolveUserId();
    } catch {
      return;
    }
    const result = await replay(deps.callers, uid);
    deps.report(result, trigger);
  };
}
