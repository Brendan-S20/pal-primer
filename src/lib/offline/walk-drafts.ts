// The walk report a walker is still filling in (#610): pee, poo and the note
// for the client, kept on the device until End walk records it.
//
// ── WHAT WAS WRONG ────────────────────────────────────────────────────────
//
// useWalkReport held all three in React state and nowhere else. Open Client
// info, reload, or have the phone kill the app in the background, and the card
// came back empty. End walk then sent nothing, because "nothing recorded" is
// nothing to send, and the client's email went out without the walker's note.
//
// ── WHY A DATABASE OF ITS OWN, AND NOT A STORE IN scoop-offline ───────────
//
// A new store in scoop-offline needs a version bump, and `openDB` blocks on
// every other open tab before it can upgrade. queue.ts spells out what that
// costs: a tech with My Day open on a phone and a tablet gets a `blocked`
// event and a queue that will not open. A draft is not worth putting the
// queue at that risk, so drafts live in their own database at version 1 and
// scoop-offline is not touched at all.
//
// ── KEYED BY USER AND VISIT ───────────────────────────────────────────────
//
// The queue scopes every action by the user who queued it; drafts do the
// same, so a draft is only ever read back by the walker who typed it, and
// sign-out drops every draft on the device (sign-out.ts).

import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { resolveOfflineUserId } from "./action-owner";

export type WalkDraft = { pee: boolean | null; poo: boolean | null; note: string };

type DraftRow = WalkDraft & { key: string; userId: string; visitId: string; ts: number };

interface DraftDB extends DBSchema {
  drafts: { key: string; value: DraftRow };
}

let dbPromise: Promise<IDBPDatabase<DraftDB>> | null = null;

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB<DraftDB>("scoop-walk-drafts", 1, {
      upgrade(db) {
        db.createObjectStore("drafts", { keyPath: "key" });
      },
    });
    // A database that failed to open is retried on the next call rather than
    // remembered as broken for the life of the page.
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
}

const draftKey = (userId: string, visitId: string) => `${userId}|${visitId}`;

export function walkDraftIsEmpty(d: WalkDraft): boolean {
  return d.pee == null && d.poo == null && d.note.trim() === "";
}

export async function loadWalkDraft(userId: string, visitId: string): Promise<WalkDraft | null> {
  const row = await (await getDb()).get("drafts", draftKey(userId, visitId));
  return row ? { pee: row.pee, poo: row.poo, note: row.note } : null;
}

/** An empty draft is a deleted one: there is nothing to bring back. */
export async function saveWalkDraft(userId: string, visitId: string, d: WalkDraft): Promise<void> {
  const db = await getDb();
  const key = draftKey(userId, visitId);
  if (walkDraftIsEmpty(d)) {
    await db.delete("drafts", key);
    return;
  }
  await db.put("drafts", {
    key,
    userId,
    visitId,
    pee: d.pee,
    poo: d.poo,
    note: d.note,
    ts: Date.now(),
  });
}

export async function clearWalkDraft(userId: string, visitId: string): Promise<void> {
  await (await getDb()).delete("drafts", draftKey(userId, visitId));
}

/** Every draft on the device, whoever wrote it. Called on sign-out. */
export async function clearAllWalkDrafts(): Promise<void> {
  await (await getDb()).clear("drafts");
}

/**
 * One visit's draft, as the walk card uses it. Writes go through one chain so
 * a clear issued after a save can never land before it, and a failed write
 * never stops the next one. A device that cannot say who is signed in, or has
 * no IndexedDB, keeps the report in memory only, as before.
 */
export function createWalkDraftKeeper(
  visitId: string,
  resolveUser: () => Promise<string> = resolveOfflineUserId,
) {
  const user = resolveUser().catch(() => null);
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (write: (userId: string) => Promise<void>) => {
    chain = chain.then(async () => {
      const userId = await user;
      if (!userId) return;
      try {
        await write(userId);
      } catch {
        // A draft that could not be written is the old behaviour, not a new
        // failure: the report is still on screen and End walk still sends it.
      }
    });
    return chain;
  };
  return {
    async load(): Promise<WalkDraft | null> {
      const userId = await user;
      if (!userId) return null;
      try {
        return await loadWalkDraft(userId, visitId);
      } catch {
        return null;
      }
    },
    save: (d: WalkDraft) => enqueue((userId) => saveWalkDraft(userId, visitId, d)),
    clear: () => enqueue((userId) => clearWalkDraft(userId, visitId)),
  };
}

export type WalkDraftKeeper = ReturnType<typeof createWalkDraftKeeper>;

/**
 * End walk with nothing in the report. Asks first; ending anyway is always
 * allowed, because a walk that cannot be ended is worse than one with no report.
 * Returns whether to go ahead.
 */
export async function confirmEndWithEmptyReport(
  report: WalkDraft,
  ask: () => Promise<boolean>,
): Promise<boolean> {
  if (!walkDraftIsEmpty(report)) return true;
  return ask();
}
