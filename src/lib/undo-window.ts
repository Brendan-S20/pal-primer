// A change that is held for a few seconds before it is sent, so Undo can
// take it back before anybody else hears about it.
//
// Why held rather than sent and reversed: reassigning a visit tells two
// technicians (field-notify) and refreshes two lock screens the moment the
// server function returns. An Undo that reverses the write afterwards would
// leave both of them with a notification about a change that never stood.
// Holding the call means a dispatcher who picked the wrong name in a native
// select on a phone can take it back and nobody is told anything.
//
// The timer is not tied to a component. Closing the drawer inside the window
// still sends the change; only Undo cancels it.
//
// ── A HELD CHANGE MUST SURVIVE THE PAGE (#652, F-27) ───────────────────────
//
// Until #652 the only copy of a held change was a closure in memory, and the
// only rescue was a `pagehide` listener. That lost the reassign on every path
// a phone actually takes: a reload inside the window, an Android force-stop
// at 1.29 s, an iOS terminate at about 0.5 s. `pagehide` does not fire when a
// WKWebView is killed, and a fetch started from it is cancelled when the page
// goes. So two things now hold a change:
//
//   1. It is FLUSHED (sent at once) the moment the page stops being looked
//      at: `visibilitychange` to hidden, `pagehide`, and Capacitor's `pause`.
//      An app switch is how a phone is killed, so that is the last moment
//      JavaScript is sure to run.
//   2. A change that names a `durable` record is also written to
//      localStorage when it is held, and removed only when it was undone or
//      the server answered. If the page dies first, `replayHeldChanges` (run
//      by the signed-in shell on the next start) waits out whatever was left
//      of the window and sends it. A record still waiting means nobody
//      pressed Undo, so the change the dispatcher saw applied stands.
//
// Replay is guarded by the handler (reassign passes `ifStillFrom`, so a
// visit somebody else has moved since, or one the first send already moved,
// is left alone and nobody is told twice), scoped to the user who held it
// (a shared tablet), and dropped after REPLAY_MAX_AGE_MS.

export const UNDO_WINDOW_MS = 5_000;

/** The visit drawer's held reassign. Replayed through reassignVisit. */
export const REASSIGN_HELD_KIND = "reassign";

/** Where held changes wait. Ids only, no customer data. */
export const HELD_STORAGE_KEY = "hs.undo-window.held";
/** A held change older than this is not replayed. */
export const REPLAY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** A replay the server refused this many times is dropped. */
const MAX_REPLAY_ATTEMPTS = 3;

export type HeldChange = {
  /** Cancel the change. False when it has already been sent. */
  undo: () => boolean;
  /** Send it now rather than at the end of the window. */
  flush: () => void;
  /** Settles once the change was sent (true) or undone (false). */
  done: Promise<boolean>;
};

/** What is written to storage so a change can be sent by the next page. */
export type DurableRecord = {
  /** Picks the replay handler, e.g. "reassign". */
  kind: string;
  /** Whoever held it. Replay only sends a record for the same user. */
  userId: string;
  /** Plain JSON the handler is given. */
  payload: unknown;
};

type StoredHeld = DurableRecord & {
  id: string;
  /** When the window closes, ms since epoch. */
  sendAt: number;
  attempts?: number;
};

// ── storage ────────────────────────────────────────────────────────────────

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readAll(): StoredHeld[] {
  const s = storage();
  if (!s) return [];
  try {
    const raw = JSON.parse(s.getItem(HELD_STORAGE_KEY) ?? "[]");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeAll(list: StoredHeld[]) {
  const s = storage();
  if (!s) return;
  try {
    if (list.length) s.setItem(HELD_STORAGE_KEY, JSON.stringify(list));
    else s.removeItem(HELD_STORAGE_KEY);
  } catch {
    /* storage full or blocked: the in-memory hold still works */
  }
}

function putRecord(rec: StoredHeld) {
  writeAll([...readAll().filter((r) => r.id !== rec.id), rec]);
}

function dropRecord(id: string) {
  const all = readAll();
  if (all.some((r) => r.id === id)) writeAll(all.filter((r) => r.id !== id));
}

function hasRecord(id: string) {
  return readAll().some((r) => r.id === id);
}

function newId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

// ── flush when the page is going away ──────────────────────────────────────

const waiting = new Set<() => void>();
let listening = false;

function flushAll() {
  for (const f of [...waiting]) f();
}

function isNativeShell(): boolean {
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return !!cap?.isNativePlatform?.();
}

function flushAllOnHide() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("pagehide", flushAll);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushAll();
  });
  // The app being sent to the background. WKWebView usually fires
  // visibilitychange too, but not always before iOS suspends the process.
  if (isNativeShell()) {
    void import("@capacitor/app")
      .then(({ App }) => App.addListener("pause", flushAll))
      .catch(() => {});
  }
}

/**
 * Run `send` after `ms`, unless `undo()` is called first.
 *
 * `send` runs at most once. An error it throws is passed to `onError` and
 * the returned `done` resolves to false, so a caller can put the screen back.
 *
 * With `durable`, the change is also written to localStorage until it is
 * undone or answered, so a reload or a killed app does not lose it.
 */
export function holdForUndo(
  send: () => Promise<unknown>,
  {
    ms = UNDO_WINDOW_MS,
    onError,
    durable,
  }: {
    ms?: number;
    onError?: (e: unknown) => void;
    /** `userId` may still be on its way (the session lookup). The record is
     *  then written when it answers, if the change is still waiting. */
    durable?: Omit<DurableRecord, "userId"> & { userId: string | PromiseLike<string | null> };
  } = {},
): HeldChange {
  let state: "waiting" | "sent" | "undone" = "waiting";
  let settle!: (v: boolean) => void;
  const done = new Promise<boolean>((r) => (settle = r));
  const id = newId();
  const sendAt = Date.now() + ms;
  if (durable) {
    const { userId, ...rest } = durable;
    const write = (uid: string | null) => {
      if (uid && state === "waiting") putRecord({ ...rest, userId: uid, id, sendAt });
    };
    if (typeof userId === "string") write(userId);
    else Promise.resolve(userId).then(write, () => {});
  }

  const fire = () => {
    if (state !== "waiting") return;
    state = "sent";
    clearTimeout(timer);
    waiting.delete(fire);
    send().then(
      () => {
        dropRecord(id);
        settle(true);
      },
      (e) => {
        // The server answered no. A replay would get the same answer.
        dropRecord(id);
        onError?.(e);
        settle(false);
      },
    );
  };

  const timer = setTimeout(fire, ms);
  waiting.add(fire);
  flushAllOnHide();

  return {
    undo: () => {
      if (state !== "waiting") return false;
      state = "undone";
      clearTimeout(timer);
      waiting.delete(fire);
      dropRecord(id);
      settle(false);
      return true;
    },
    flush: fire,
    done,
  };
}

/**
 * Send the held changes a previous page left behind. Called once the user is
 * known. A record whose window has not closed yet (a reload at 1 s) waits out
 * the rest of it first, and is sent only if it is still there, so an Undo in
 * another tab still wins. Resolves with how many were sent.
 */
export async function replayHeldChanges(
  userId: string,
  handlers: Record<string, (payload: unknown) => Promise<unknown>>,
  { now = () => Date.now() }: { now?: () => number } = {},
): Promise<number> {
  const all = readAll();
  const stale = all.filter((r) => now() - r.sendAt > REPLAY_MAX_AGE_MS || !handlers[r.kind]);
  if (stale.length) writeAll(all.filter((r) => !stale.includes(r)));
  const mine = all.filter((r) => r.userId === userId && !stale.includes(r));

  let sent = 0;
  for (const rec of mine) {
    const wait = rec.sendAt - now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (!hasRecord(rec.id)) continue;
    try {
      await handlers[rec.kind](rec.payload);
      dropRecord(rec.id);
      sent++;
    } catch {
      const attempts = (rec.attempts ?? 0) + 1;
      if (attempts >= MAX_REPLAY_ATTEMPTS) dropRecord(rec.id);
      else putRecord({ ...rec, attempts });
    }
  }
  return sent;
}
