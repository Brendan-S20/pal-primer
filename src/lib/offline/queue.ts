// IndexedDB queue for offline visit actions and photo uploads. Stores each
// pending action with a stable id so `syncQueue` can retry deterministically.

import { openDB, type DBSchema, type IDBPDatabase } from "idb";

export type PendingAction =
  | { id: string; kind: "start"; visitId: string; ts: number }
  | { id: string; kind: "complete"; visitId: string; ts: number }
  | { id: string; kind: "skip"; visitId: string; reason: string; code: string; ts: number }
  | {
      id: string;
      kind: "photo";
      visitId: string;
      photoKind: "before" | "completion" | "issue";
      /** ID pointing into the `photos` object store */
      photoId: string;
      /** Cached organization_id so upload works without a network `visits` read */
      organizationId: string;
      ts: number;
    };

interface OfflineDB extends DBSchema {
  actions: {
    key: string;
    value: PendingAction;
    indexes: { "by-ts": number };
  };
  photos: {
    key: string;
    value: { id: string; blob: Blob; contentType: string; ext: string };
  };
}

let dbPromise: Promise<IDBPDatabase<OfflineDB>> | null = null;

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB<OfflineDB>("scoop-offline", 1, {
      upgrade(db) {
        const actions = db.createObjectStore("actions", { keyPath: "id" });
        actions.createIndex("by-ts", "ts");
        db.createObjectStore("photos", { keyPath: "id" });
      },
    });
  }
  return dbPromise;
}

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function enqueueAction(action: Omit<PendingAction, "id" | "ts">): Promise<string> {
  const db = await getDb();
  const record = { ...action, id: uid(), ts: Date.now() } as PendingAction;
  await db.put("actions", record);
  window.dispatchEvent(new Event("offline-queue-change"));
  return record.id;
}

export async function storePhoto(
  blob: Blob,
  contentType: string,
  ext: string,
): Promise<string> {
  const db = await getDb();
  const id = uid();
  await db.put("photos", { id, blob, contentType, ext });
  return id;
}

export async function listPending(): Promise<PendingAction[]> {
  const db = await getDb();
  return await db.getAllFromIndex("actions", "by-ts");
}

export async function countPending(): Promise<number> {
  const db = await getDb();
  return await db.count("actions");
}

export async function countPendingForVisit(visitId: string): Promise<number> {
  const pending = await listPending();
  return pending.filter((a) => a.visitId === visitId).length;
}

export async function deleteAction(id: string) {
  const db = await getDb();
  await db.delete("actions", id);
  window.dispatchEvent(new Event("offline-queue-change"));
}

export async function popPhoto(photoId: string) {
  const db = await getDb();
  const row = await db.get("photos", photoId);
  if (row) await db.delete("photos", photoId);
  return row;
}
