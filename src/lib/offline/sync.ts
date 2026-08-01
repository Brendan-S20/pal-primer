// Sync driver — replays queued visit actions when the browser comes back
// online. Callers pass in bound server-fn callers (from `useServerFn`) so
// this module stays free of TanStack imports and remains easy to unit-test.

import { supabase } from "@/integrations/supabase/client";
import {
  deleteAction,
  deletePhoto,
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
}

export async function syncQueue(callers: SyncCallers, userId: string): Promise<SyncResult> {
  if (running) return { attempted: 0, succeeded: 0, failed: 0, dropped: 0 };
  running = true;
  const result: SyncResult = { attempted: 0, succeeded: 0, failed: 0, dropped: 0 };
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
