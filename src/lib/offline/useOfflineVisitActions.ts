// Wrapper hook: exposes online-aware start/complete/skip/photo actions for a
// specific visit. Actions run on the network when possible; otherwise they
// are queued to IndexedDB and replayed by `syncQueue` on reconnect.
//
// QA-P4: "when possible" used to mean `navigator.onLine`, and the request had
// no deadline. A phone that reports a network it cannot actually reach — one
// bar in a back yard, a dropped data session, a captive portal — left the
// request hanging for ever: no toast, a permanently disabled button, and
// nothing written to the queue. The decision now lives in
// lib/offline/run-or-queue.ts with a deadline on it, and the owner lookup that
// the queue write depends on has its own deadline in lib/offline/action-owner
// .ts. Both are in one place because this file had four copies of the same
// eight lines and a fix to one of them would have left the other three.

import { useCallback } from "react";
import { useServerFn } from "@tanstack/react-start";
import { startVisit, completeVisit, skipVisit, recordVisitPhoto } from "@/lib/my-day.functions";
import { enqueueAction, storePhoto } from "@/lib/offline/queue";
import { compressImage } from "@/lib/offline/compressImage";
import { supabase } from "@/integrations/supabase/client";
import { runOrQueue } from "@/lib/offline/run-or-queue";
import { resolveOfflineUserId } from "@/lib/offline/action-owner";

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
  // FALSE is trustworthy — there is definitely no network, so skip the
  // request. TRUE is a guess, which is why runOrQueue puts a deadline on the
  // attempt rather than trusting this to be the whole answer.
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
  // Every queued action records who made it. Replay runs as whoever is signed
  // in at the time, so an unowned action is one the wrong tech can replay —
  // see the header of lib/offline/queue.ts. Read at enqueue time rather than
  // hook time: the session is what it is when the tech presses the button.
  // `resolveOfflineUserId` is called directly rather than through a local
  // alias: an alias is a new binding on every render, so every useCallback
  // below would list it as a dependency and be rebuilt each time for no
  // reason. It is bounded, and falls back to the last user this device
  // authenticated as — `getSession()` refreshes an expired token over the
  // network, which is the second place the offline path quietly depended on
  // being online. That fallback key is written on every authenticated load by
  // the read cache and cleared by sign-out, so a shared tablet cannot inherit
  // an owner.

  const startFn = useServerFn(startVisit);
  const completeFn = useServerFn(completeVisit);
  const skipFn = useServerFn(skipVisit);
  const photoFn = useServerFn(recordVisitPhoto);

  const start = useCallback(
    () =>
      runOrQueue({
        online: isNavigatorOnline(),
        label: "Start visit",
        send: () => startFn({ data: { visitId } }),
        queue: async () => {
          await enqueueAction({ kind: "start", visitId, userId: await resolveOfflineUserId() });
        },
      }),
    [startFn, visitId],
  );

  const complete = useCallback(
    () =>
      runOrQueue({
        online: isNavigatorOnline(),
        label: "Complete visit",
        send: () => completeFn({ data: { visitId } }),
        queue: async () => {
          await enqueueAction({ kind: "complete", visitId, userId: await resolveOfflineUserId() });
        },
      }),
    [completeFn, visitId],
  );

  const skip = useCallback(
    (reason: string, code: string) =>
      runOrQueue({
        online: isNavigatorOnline(),
        label: "Skip visit",
        send: () => skipFn({ data: { visitId, reason, code: code as any } }),
        queue: async () => {
          await enqueueAction({
            kind: "skip",
            visitId,
            reason,
            code,
            userId: await resolveOfflineUserId(),
          });
        },
      }),
    [skipFn, visitId],
  );

  const uploadPhoto = useCallback(
    async (rawFile: File, kind: "before" | "completion" | "issue") => {
      // Downscale + re-encode before either upload path so both online and
      // queued photos benefit (queued blobs sit in IndexedDB — the smaller
      // the better).
      const { file, contentType, ext } = await compressImage(rawFile);

      return runOrQueue({
        online: isNavigatorOnline(),
        label: "Upload photo",
        // A longer deadline than the other actions, and deliberately so: this
        // is a multi-megabyte upload over a field connection, where eight
        // seconds is a normal duration rather than a symptom. The point of the
        // deadline is to stop an INDEFINITE wait, not to race a slow upload.
        deadlineMs: 45_000,
        send: async () => {
          const { data: vRow, error: vErr } = await supabase
            .from("visits")
            .select("organization_id")
            .eq("id", visitId)
            .single();
          if (vErr) throw vErr;
          const path = `${vRow.organization_id}/${visitId}/${Date.now()}.${ext}`;
          const { error: upErr } = await supabase.storage
            .from("visit-photos")
            .upload(path, file, { contentType, upsert: false });
          if (upErr) throw upErr;
          await photoFn({ data: { visitId, storagePath: path, kind } });
        },
        queue: async () => {
          if (!cachedOrgId) {
            throw new Error("Can't queue this photo offline. Reload My Day while online first.");
          }
          // Owner resolved BEFORE the blob is written. storePhoto then
          // enqueueAction was the order, and if the enqueue failed the blob was
          // already in IndexedDB with nothing referencing it — unreachable,
          // never collected, eating quota for ever. Anything that can throw now
          // happens first.
          const userId = await resolveOfflineUserId();
          const photoId = await storePhoto(file, contentType, ext);
          try {
            await enqueueAction({
              kind: "photo",
              visitId,
              photoKind: kind,
              photoId,
              organizationId: cachedOrgId,
              userId,
            });
          } catch (e) {
            // Do not leave an orphan behind.
            const { deletePhoto } = await import("@/lib/offline/queue");
            await deletePhoto(photoId).catch(() => {});
            throw e;
          }
        },
      });
    },
    [photoFn, visitId, cachedOrgId],
  );

  return { start, complete, skip, uploadPhoto };
}
