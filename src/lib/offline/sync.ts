// Sync driver — replays queued visit actions when the browser comes back
// online. Callers pass in bound server-fn callers (from `useServerFn`) so
// this module stays free of TanStack imports and remains easy to unit-test.

import { supabase } from "@/integrations/supabase/client";
import {
  deleteAction,
  deletePhoto,
  recordAttempt,
  getPhoto,
  listPending,
  type PendingAction,
} from "./queue";

export interface SyncCallers {
  startVisit: (args: { data: { visitId: string } }) => Promise<unknown>;
  completeVisit: (args: { data: { visitId: string } }) => Promise<unknown>;
  skipVisit: (args: {
    data: { visitId: string; reason: string; code: any };
  }) => Promise<unknown>;
  recordVisitPhoto: (args: {
    data: { visitId: string; storagePath: string; kind: "before" | "completion" | "issue" };
  }) => Promise<unknown>;
}

async function runOne(action: PendingAction, callers: SyncCallers): Promise<void> {
  switch (action.kind) {
    case "start":
      await callers.startVisit({ data: { visitId: action.visitId } });
      return;
    case "complete":
      await callers.completeVisit({ data: { visitId: action.visitId } });
      return;
    case "skip":
      await callers.skipVisit({
        data: { visitId: action.visitId, reason: action.reason, code: action.code },
      });
      return;
    case "photo": {
      const photo = await getPhoto(action.photoId);
      // A missing blob is DATA LOSS, not a no-op. It used to `return`, which the
      // caller read as success — so the one path where a photo had been
      // destroyed was also the path that reported "synced". Say so instead.
      if (!photo) throw new MissingPhotoError(action.photoId);
      const path = `${action.organizationId}/${action.visitId}/${Date.now()}.${photo.ext}`;
      const { error } = await supabase.storage
        .from("visit-photos")
        .upload(path, photo.blob, { contentType: photo.contentType, upsert: false });
      if (error) throw error;
      await callers.recordVisitPhoto({
        data: { visitId: action.visitId, storagePath: path, kind: action.photoKind },
      });
      // Only now. Everything above can throw, and until this line the blob is
      // the only copy that exists.
      await deletePhoto(action.photoId);
      return;
    }
  }
}

let running = false;

/** The blob a queued photo points at is gone. Unrecoverable, so retrying it for
 *  ever would wedge everything behind it — it is dropped and COUNTED, never
 *  folded into the success total. */
export class MissingPhotoError extends Error {
  constructor(photoId: string) {
    super(`Queued photo ${photoId} is missing from device storage`);
    this.name = "MissingPhotoError";
  }
}

export interface SyncResult {
  attempted: number;
  succeeded: number;
  failed: number;
  /** Actions discarded because they can never succeed. Surfaced separately so
   *  a loss is never reported as a sync. */
  dropped: number;
  /** Actions the server refused MAX_ATTEMPTS times in a row while the device
   *  was online. Given up on, so the queue behind them can move. */
  deadLettered: number;
}

/** How many server refusals before an action is given up on.
 *
 *  Only failures that happened WHILE ONLINE count. A tech in a dead zone can
 *  retry all day without burning the budget — losing their work because the
 *  yard has no signal is the opposite of what this is for. The heuristic is
 *  `navigator.onLine`, which is honest about reachability rather than about
 *  whether the server is healthy, so a server outage lasting five sync cycles
 *  could still discard work. That is the residual risk, stated rather than
 *  hidden; five cycles of a reachable-but-refusing server is also a fair
 *  description of "this will never succeed".
 *
 *  The alternative — the previous behaviour — is one bad action blocking a
 *  tech's entire day with nothing on screen to explain it. */
export const MAX_ATTEMPTS = 5;

export async function syncQueue(callers: SyncCallers, userId: string): Promise<SyncResult> {
  if (running) return { attempted: 0, succeeded: 0, failed: 0, dropped: 0, deadLettered: 0 };
  running = true;
  const result: SyncResult = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    dropped: 0,
    deadLettered: 0,
  };
  try {
    // Only this user's actions. Replaying another tech's work under the
    // signed-in tech's identity fails every authorization check and wedges the
    // queue for the person actually holding the device.
    const pending = await listPending(userId);
    for (const action of pending) {
      result.attempted++;
      try {
        await runOne(action, callers);
        await deleteAction(action.id);
        result.succeeded++;
      } catch (e) {
        if (e instanceof MissingPhotoError) {
          // Nothing to retry — the bytes are gone. Drop it so the rest of the
          // queue can move, and report it as a loss rather than a success.
          await deleteAction(action.id);
          result.dropped++;
          console.error("offline sync dropped an action", action, e);
          continue;
        }
        // A failure with no network is not the action's fault. Only count it
        // against the action when the device believes it can reach the server.
        const online = typeof navigator === "undefined" || navigator.onLine;
        if (online) {
          const attempts = await recordAttempt(action.id);
          if (attempts >= MAX_ATTEMPTS) {
            // Give up on THIS action so everything queued behind it can move.
            // Reported separately and loudly: the tech is the only person who
            // can redo the work, and silently discarding it would be worse
            // than the blockage this replaces.
            await deleteAction(action.id);
            if (action.kind === "photo") await deletePhoto(action.photoId);
            result.deadLettered++;
            console.error("offline sync gave up on an action", action, e);
            continue;
          }
        }
        result.failed++;
        console.warn("offline sync failed", action, e);
        // Stop on failure so we don't hammer a broken network / server. The
        // remaining items will retry on the next online event.
        break;
      }
    }
  } finally {
    running = false;
  }
  return result;
}
