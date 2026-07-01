// Wrapper hook: exposes online-aware start/complete/skip/photo actions for a
// specific visit. Actions run on the network when possible; otherwise they
// are queued to IndexedDB and replayed by `syncQueue` on reconnect.

import { useCallback } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  startVisit,
  completeVisit,
  skipVisit,
  recordVisitPhoto,
} from "@/lib/my-day.functions";
import { enqueueAction, storePhoto } from "@/lib/offline/queue";
import { compressImage } from "@/lib/offline/compressImage";
import { supabase } from "@/integrations/supabase/client";

export interface OfflineVisitActions {
  start: () => Promise<{ queued: boolean }>;
  complete: () => Promise<{ queued: boolean }>;
  skip: (reason: string, code: string) => Promise<{ queued: boolean }>;
  uploadPhoto: (
    file: File,
    kind: "before" | "completion" | "issue",
  ) => Promise<{ queued: boolean }>;
}

function isNavigatorOnline() {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

/**
 * Photo upload requires knowing which org bucket folder to use. When online
 * we still fetch it just-in-time to keep behavior identical to the previous
 * page; when offline, we fall back to the caller-provided cached value that
 * was pulled from the initial `/my-day` load.
 */
export function useOfflineVisitActions(
  visitId: string,
  cachedOrgId: string | undefined,
): OfflineVisitActions {
  const startFn = useServerFn(startVisit);
  const completeFn = useServerFn(completeVisit);
  const skipFn = useServerFn(skipVisit);
  const photoFn = useServerFn(recordVisitPhoto);

  const start = useCallback(async () => {
    if (isNavigatorOnline()) {
      try {
        await startFn({ data: { visitId } });
        return { queued: false };
      } catch (_) { /* fall through to queue */ }
    }
    await enqueueAction({ kind: "start", visitId });
    return { queued: true };
  }, [startFn, visitId]);

  const complete = useCallback(async () => {
    if (isNavigatorOnline()) {
      try {
        await completeFn({ data: { visitId } });
        return { queued: false };
      } catch (_) { /* fall through */ }
    }
    await enqueueAction({ kind: "complete", visitId });
    return { queued: true };
  }, [completeFn, visitId]);

  const skip = useCallback(
    async (reason: string, code: string) => {
      if (isNavigatorOnline()) {
        try {
          await skipFn({ data: { visitId, reason, code: code as any } });
          return { queued: false };
        } catch (_) { /* fall through */ }
      }
      await enqueueAction({ kind: "skip", visitId, reason, code });
      return { queued: true };
    },
    [skipFn, visitId],
  );

  const uploadPhoto = useCallback(
    async (rawFile: File, kind: "before" | "completion" | "issue") => {
      // Downscale + re-encode before either upload path so both online and
      // queued photos benefit (queued blobs sit in IndexedDB — the smaller
      // the better).
      const { file, contentType, ext } = await compressImage(rawFile);


      if (isNavigatorOnline()) {
        try {
          const { data: vRow, error: vErr } = await supabase
            .from("visits").select("organization_id").eq("id", visitId).single();
          if (vErr) throw vErr;
          const path = `${vRow.organization_id}/${visitId}/${Date.now()}.${ext}`;
          const { error: upErr } = await supabase.storage
            .from("visit-photos")
            .upload(path, file, { contentType, upsert: false });
          if (upErr) throw upErr;
          await photoFn({ data: { visitId, storagePath: path, kind } });
          return { queued: false };
        } catch (_) { /* fall through */ }
      }

      if (!cachedOrgId) {
        throw new Error(
          "Can't queue this photo offline — reload My Day while online first.",
        );
      }
      const photoId = await storePhoto(file, contentType, ext);
      await enqueueAction({
        kind: "photo",
        visitId,
        photoKind: kind,
        photoId,
        organizationId: cachedOrgId,
      });
      return { queued: true };
    },
    [photoFn, visitId, cachedOrgId],
  );

  return { start, complete, skip, uploadPhoto };
}
