// Sync driver — replays queued visit actions when the browser comes back
// online. Callers pass in bound server-fn callers (from `useServerFn`) so
// this module stays free of TanStack imports and remains easy to unit-test.

import { supabase } from "@/integrations/supabase/client";
import {
  deleteAction,
  listPending,
  popPhoto,
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
      const photo = await popPhoto(action.photoId);
      if (!photo) return; // blob is gone; drop the action
      const path = `${action.organizationId}/${action.visitId}/${Date.now()}.${photo.ext}`;
      const { error } = await supabase.storage
        .from("visit-photos")
        .upload(path, photo.blob, { contentType: photo.contentType, upsert: false });
      if (error) throw error;
      await callers.recordVisitPhoto({
        data: { visitId: action.visitId, storagePath: path, kind: action.photoKind },
      });
      return;
    }
  }
}

let running = false;

export interface SyncResult {
  attempted: number;
  succeeded: number;
  failed: number;
}

export async function syncQueue(callers: SyncCallers): Promise<SyncResult> {
  if (running) return { attempted: 0, succeeded: 0, failed: 0 };
  running = true;
  const result: SyncResult = { attempted: 0, succeeded: 0, failed: 0 };
  try {
    const pending = await listPending();
    for (const action of pending) {
      result.attempted++;
      try {
        await runOne(action, callers);
        await deleteAction(action.id);
        result.succeeded++;
      } catch (e) {
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
