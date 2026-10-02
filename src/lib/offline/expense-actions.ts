// Logging an expense from the field: now if the network answers, otherwise
// into the offline queue with its receipt.
//
// The same path a completion photo takes, deliberately. A tech at the dump has
// one bar or none, and the receipt they are holding is the only evidence of a
// fee the business will deduct. So:
//
//   * the receipt is compressed once (compressImage), before either path, so
//     the queued blob is the small one;
//   * the expense id is minted HERE, once, and is both the row's primary key
//     and the receipt's object name -- the online attempt and the replay write
//     the same row and the same object, so a request that landed and then timed
//     out cannot become two expenses or two receipts;
//   * the decision is runOrQueue's (a deadline, and only a transport failure
//     falls through to the queue; a refusal from the server is shown, never
//     queued);
//   * the owner is resolved before the blob is stored, and the blob is removed
//     again if the enqueue fails, so nothing is left behind unreferenced.
//
// No React here, so it can be tested without a browser; the sheet binds the
// server function and passes it in.

import { supabase } from "@/integrations/supabase/client";
import { compressImage } from "@/lib/offline/compressImage";
import { isDefinitelyOffline } from "@/lib/offline/connectivity";
import { resolveOfflineUserId } from "@/lib/offline/action-owner";
import { runOrQueue } from "@/lib/offline/run-or-queue";
import {
  deletePhoto,
  enqueueAction,
  storePhoto,
  type QueuedExpenseFields,
} from "@/lib/offline/queue";
import { receiptPath } from "@/lib/expenses";

export type SendExpense = (args: {
  data: {
    id: string;
    mine: true;
    fields: QueuedExpenseFields & { receiptPath?: string | null };
  };
}) => Promise<unknown>;

export function newExpenseId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  // A v4-shaped id from Math.random, for the rare webview without randomUUID.
  // The column is a uuid, so the shape matters more than the entropy source.
  const h = () => Math.floor(Math.random() * 16).toString(16);
  const s = (n: number) => Array.from({ length: n }, h).join("");
  return `${s(8)}-${s(4)}-4${s(3)}-${"89ab"[Math.floor(Math.random() * 4)]}${s(3)}-${s(12)}`;
}

export async function logExpenseOrQueue(opts: {
  organizationId: string | null | undefined;
  staffId: string | null | undefined;
  fields: QueuedExpenseFields;
  receipt: File | null;
  send: SendExpense;
  /** Defaults to the real check; a test passes false to take the queue path. */
  online?: boolean;
  expenseId?: string;
}): Promise<{ queued: boolean; expenseId: string }> {
  const { organizationId, staffId, fields } = opts;
  if (!organizationId || !staffId) {
    throw new Error("Can't log an expense yet. Open My Day once while online, then try again.");
  }
  const expenseId = opts.expenseId ?? newExpenseId();
  const photo = opts.receipt ? await compressImage(opts.receipt) : null;

  const res = await runOrQueue({
    online: opts.online ?? !isDefinitelyOffline(),
    label: "Log expense",
    // A receipt is a photo over a field connection; see uploadPhoto.
    deadlineMs: photo ? 45_000 : undefined,
    send: async () => {
      let path: string | undefined;
      if (photo) {
        path = receiptPath(organizationId, staffId, expenseId, photo.ext);
        const { error } = await supabase.storage
          .from("expense-receipts")
          // upsert: the replay may write these same bytes to this same name.
          .upload(path, photo.file, { contentType: photo.contentType, upsert: true });
        if (error) throw error;
      }
      await opts.send({
        data: {
          id: expenseId,
          mine: true,
          fields: { ...fields, ...(path ? { receiptPath: path } : {}) },
        },
      });
    },
    queue: async () => {
      const userId = await resolveOfflineUserId();
      const photoId = photo
        ? await storePhoto(photo.file, photo.contentType, photo.ext)
        : undefined;
      try {
        await enqueueAction({
          kind: "expense",
          expenseId,
          organizationId,
          staffId,
          fields,
          ...(photoId ? { photoId } : {}),
          userId,
        });
      } catch (e) {
        if (photoId) await deletePhoto(photoId).catch(() => {});
        throw e;
      }
    },
  });
  return { ...res, expenseId };
}
