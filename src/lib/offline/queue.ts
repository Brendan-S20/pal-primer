// IndexedDB queue for offline visit actions and photo uploads. Stores each
// pending action with a stable id so `syncQueue` can retry deterministically.
//
// ── EVERY ACTION CARRIES ITS OWNER ─────────────────────────────────────────
//
// BUG-43 fixed the READ cache: it was keyed by nothing that identified the
// user, so a tech's route survived sign-out on a shared crew tablet. This
// store had exactly the same defect and was not fixed with it — actions and
// photo blobs of customer property lived in IndexedDB, unscoped, and
// signOutAndClearDevice only ever swept localStorage, despite its own comment
// promising to "destroy the persisted day".
//
// Worse than data at rest: replay is driven by whoever is signed in NOW. Tech A
// queues six completions in a dead zone, signs out, hands the tablet to tech B;
// B opens my-day, the auto-sync effect fires with B's session, and every one of
// A's actions is replayed as B. complete_visit authorizes on
// is_visit_tech(auth.uid(), …), so they all fail — and because a failure breaks
// the loop, B's own queue is wedged behind A's work from B's first minute on
// the device.
//
// So each action records the user who created it, listPending only ever returns
// the caller's own, and sign-out drops that user's rows.

import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { isLifecycleKind, lifecycleCollision } from "./queued-visit-state";
import { clockCollision, isClockKind } from "./queued-clock-state";

/** Fields every queued action carries, whatever its kind. */
type ActionBase = {
  id: string;
  ts: number;
  /** Who queued it. Replay runs as whoever is signed in, so an action without
   *  an owner is an action that can be replayed by the wrong person. */
  userId: string;
  /** How many times replay has reached the server and been refused.
   *
   *  The sync loop stops at the first failure so it does not hammer a broken
   *  network, which means ONE permanently-failing action blocks every action
   *  behind it for the rest of the day, with nothing on screen to say so. A
   *  count is what lets the loop tell "the network is down" from "the server
   *  will never accept this". */
  attempts?: number;
};

export type PendingAction =
  | ({ kind: "start"; visitId: string } & ActionBase)
  | ({
      kind: "complete";
      visitId: string;
      /** The tech's note, and why there is no photo when one is required.
       *  Optional: actions queued before these existed carry neither. */
      note?: string;
      noPhotoReason?: string;
    } & ActionBase)
  | ({ kind: "skip"; visitId: string; reason: string; code: string } & ActionBase)
  | ({
      kind: "station";
      visitId: string;
      wasteStationId: string;
      bagsCollected: number;
      linerReplaced: boolean;
      refillBagsAdded: number;
      notes?: string;
    } & ActionBase)
  | ({
      kind: "photo";
      visitId: string;
      photoKind: "before" | "completion" | "issue";
      /** ID pointing into the `photos` object store */
      photoId: string;
      /** Storage object key for this photo, minted BEFORE the first upload
       *  attempt and reused by every retry and by the offline replay.
       *
       *  Without it the online path and the replay pick different paths for the
       *  same bytes: an online upload that lands and then fails at the record
       *  step queues the action, and the replay uploads a SECOND copy. The
       *  first is referenced by nothing and collected by nothing.
       *
       *  Optional because rows queued before this field existed have none; they
       *  fall back to the action id, which is stable for their own retries. */
      uploadKey?: string;
      /** Cached organization_id so upload works without a network `visits` read */
      organizationId: string;
    } & ActionBase)
  // The time clock. Not about a visit, so no visitId -- declared `undefined`
  // rather than left off, so every reader that filters the queue by visit
  // (`a.visitId === visitId`) keeps compiling and simply never matches one.
  // Replay passes `ts` as the tap time, exactly as start/complete do: a tech
  // who clocks out in a dead zone at 4:10 and gets signal at 4:55 worked until
  // 4:10. See queued-clock-state.ts for what the screen shows meanwhile.
  | ({ kind: "clock_in" | "clock_out"; visitId?: undefined } & ActionBase);

interface OfflineDB extends DBSchema {
  actions: {
    key: string;
    value: PendingAction;
    indexes: { "by-ts": number; "by-user": string };
  };
  photos: {
    key: string;
    value: { id: string; blob: Blob; contentType: string; ext: string };
  };
}

let dbPromise: Promise<IDBPDatabase<OfflineDB>> | null = null;

function getDb() {
  if (!dbPromise) {
    // v2 adds the owner. Rows written by v1 have no userId, and there is no
    // way to work out whose they were after the fact — so the upgrade drops
    // them rather than leaving actions that either replay as the wrong person
    // or sit unsyncable for ever. A queue is a few hours of one tech's work at
    // most, and guessing its owner is the failure this version exists to stop.
    // v3 adds `attempts`. Unlike the v1→v2 upgrade there is nothing unsafe
    // about an existing row — a missing count simply means zero — so v2 rows
    // are KEPT. Dropping a tech's queued work to add a counter would be a
    // worse bug than the one being fixed.
    dbPromise = openDB<OfflineDB>("scoop-offline", 3, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          const actions = db.createObjectStore("actions", { keyPath: "id" });
          actions.createIndex("by-ts", "ts");
          actions.createIndex("by-user", "userId");
          db.createObjectStore("photos", { keyPath: "id" });
          return;
        }
        if (oldVersion < 2) {
          db.deleteObjectStore("actions");
          db.deleteObjectStore("photos");
          const actions = db.createObjectStore("actions", { keyPath: "id" });
          actions.createIndex("by-ts", "ts");
          actions.createIndex("by-user", "userId");
          db.createObjectStore("photos", { keyPath: "id" });
        }
        // v3 needs no migration: `attempts` is optional and absent means 0.
        //
        // The `station` kind that arrived after v3 needs no version at all,
        // which is worth spelling out because the instinct is to bump. A
        // version exists to run an `upgrade` callback, and there is nothing
        // for one to do here: no new store, no new index, no change to the
        // keyPath, and no existing row that becomes wrong. `station` is a new
        // member of a union stored in a store that has never been typed at the
        // IndexedDB level — every existing row is still exactly what it was
        // and still replays through the same switch. Bumping would be worse
        // than pointless: `openDB` blocks on other open tabs before it can
        // upgrade, so a tech with My Day open on a phone and a tablet would
        // hit a `blocked` event and a queue that will not open, in exchange
        // for a callback that does nothing.
      },
    });
  }
  return dbPromise;
}

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type NewAction = DistributiveOmit<PendingAction, "id" | "ts">;

export async function enqueueAction(action: NewAction): Promise<string> {
  const db = await getDb();
  const record = { ...action, id: uid(), ts: Date.now() } as PendingAction;
  if (isLifecycleKind(action.kind)) {
    // A second Complete for the same visit used to be queued as readily as the
    // first — a tester's second tap on a card that had not moved on made three
    // pending actions out of two. The check and the write share ONE readwrite
    // transaction, so two taps cannot both read "nothing queued" and both
    // write: IndexedDB runs overlapping readwrite transactions on a store one
    // after the other. See lifecycleCollision for what counts as a repeat.
    const tx = db.transaction("actions", "readwrite");
    const hit = lifecycleCollision(await tx.store.getAll(), action);
    if (hit && "duplicate" in hit) {
      await tx.done;
      return hit.duplicate.id;
    }
    if (hit) {
      await tx.done;
      throw new Error(hit.conflict);
    }
    await tx.store.put(record);
    await tx.done;
  } else if (isClockKind(action.kind)) {
    // Same fence, same reason: a gloved double tap on Clock in is faster than
    // the IndexedDB read that flips the button to Clock out. Two queued
    // clock-ins in a row are one tap, and the first one's time is the true one.
    const tx = db.transaction("actions", "readwrite");
    const dup = clockCollision(await tx.store.getAll(), action);
    if (dup) {
      await tx.done;
      return dup.id;
    }
    await tx.store.put(record);
    await tx.done;
  } else {
    await db.put("actions", record);
  }
  window.dispatchEvent(new Event("offline-queue-change"));
  return record.id;
}

export async function storePhoto(blob: Blob, contentType: string, ext: string): Promise<string> {
  const db = await getDb();
  const id = uid();
  await db.put("photos", { id, blob, contentType, ext });
  return id;
}

/**
 * The caller's OWN pending actions, oldest first.
 *
 * Scoped on purpose. Replay runs as whoever is signed in now, so returning
 * another user's actions means replaying them under the wrong identity — every
 * one rejected by is_visit_tech, and the first rejection wedges the queue for
 * the person actually holding the device.
 */
/** Record that replay reached the server and was refused. Returns the new
 *  count so the caller can decide whether the action is beyond saving. */
export async function recordAttempt(id: string): Promise<number> {
  const db = await getDb();
  const existing = await db.get("actions", id);
  if (!existing) return 0;
  const attempts = (existing.attempts ?? 0) + 1;
  await db.put("actions", { ...existing, attempts });
  return attempts;
}

export async function listPending(userId: string): Promise<PendingAction[]> {
  const db = await getDb();
  const all = await db.getAllFromIndex("actions", "by-ts");
  return all.filter((a) => a.userId === userId);
}

/** Drop everything belonging to one user — their photos of customer property
 *  included. Called on sign-out: the read cache has always been cleared there,
 *  and this store holds the same class of data. */
export async function clearQueueForUser(userId: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(["actions", "photos"], "readwrite");
  const actions = await tx.objectStore("actions").getAll();
  for (const a of actions) {
    if (a.userId !== userId) continue;
    if (a.kind === "photo") await tx.objectStore("photos").delete(a.photoId);
    await tx.objectStore("actions").delete(a.id);
  }
  await tx.done;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("offline-queue-change"));
  }
}

/**
 * Pending actions belonging to ONE user.
 *
 * Was `db.count("actions")` — every user's rows, on a store that is explicitly
 * per-user everywhere else (`listPending` filters by userId, `syncQueue` only
 * ever replays its own). On a shared crew tablet that made the header read
 * "6 pending" to a tech who owns none of them, permanently: tapping Sync calls
 * `syncQueue` for the signed-in user, which finds nothing, reports zero, and
 * leaves the badge exactly where it was. The count and the thing the button
 * acts on have to be the same set.
 */
export async function countPending(userId: string): Promise<number> {
  const db = await getDb();
  const all = await db.getAllFromIndex("actions", "by-ts");
  return all.filter((a) => a.userId === userId).length;
}

/** How many QUEUED COMPLETION PHOTOS a visit has.
 *
 *  Not "how many pending actions" — that was the bug. The Complete button is
 *  unlocked offline on the strength of a completion photo waiting to sync, and
 *  it was gated on the count of ALL pending actions, so queueing a Start
 *  unlocked Complete. The server then refuses (`A completion photo is required
 *  before completing this visit`), which is not a network error, so the sync
 *  loop breaks on it and every action queued behind it stops for good. */
export async function countQueuedCompletionPhotos(
  visitId: string,
  userId: string,
): Promise<number> {
  const db = await getDb();
  const all = await db.getAll("actions");
  return all.filter(
    (a) =>
      a.userId === userId &&
      a.visitId === visitId &&
      a.kind === "photo" &&
      a.photoKind === "completion",
  ).length;
}

/** Pending actions THIS user has queued against one visit.
 *
 *  Scoped for the same reason as everything else in this file, and with a
 *  sharper consequence than the rest. On a shared tablet an unscoped count
 *  means tech A's queued completion photo unlocks the Complete button for tech
 *  B, who has taken none. B completes, the server refuses ("A completion photo
 *  is required before completing this visit"), that is not a transport failure
 *  so it burns an attempt, and after MAX_ATTEMPTS B's own completion is
 *  dead-lettered. An unscoped read here does not just mislead — it destroys the
 *  work of the person actually holding the device. */
export async function countPendingForVisit(visitId: string, userId: string): Promise<number> {
  const db = await getDb();
  const pending = await db.getAll("actions");
  return pending.filter((a) => a.userId === userId && a.visitId === visitId).length;
}

export async function deleteAction(id: string) {
  const db = await getDb();
  await db.delete("actions", id);
  window.dispatchEvent(new Event("offline-queue-change"));
}

/** Read a photo WITHOUT destroying it.
 *
 *  It used to be `popPhoto`: delete, then upload. Any throw after the delete —
 *  a storage 5xx, an expired token, a reset connection — left the action queued
 *  with its blob already gone, and the next replay found no blob, treated that
 *  as nothing to do, deleted the action and counted it a SUCCESS. The tech saw
 *  "Synced 1 queued action" for a photo that no longer existed anywhere, and
 *  the visit lost its completion evidence silently. Delete only after the
 *  upload and the record both land. */
export async function getPhoto(photoId: string) {
  const db = await getDb();
  return await db.get("photos", photoId);
}

export async function deletePhoto(photoId: string) {
  const db = await getDb();
  await db.delete("photos", photoId);
}
