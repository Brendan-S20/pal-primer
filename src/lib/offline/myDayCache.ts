// Read-only offline fallback for My Day (Mobile Phase 3). Persists the last
// successful getMyDay response per (day, staff) so a tech in a dead zone still
// sees their route, hazards, and gate codes when the fetch fails. Strictly
// read-only: nothing here queues writes — visit actions keep going through the
// existing IndexedDB queue, and money actions stay online-only.
//
// localStorage (WebView-persistent on native) keeps this synchronous and
// dependency-free; snapshots are small JSON blobs and pruned to the newest few.

const PREFIX = "myday:snapshot:";
const MAX_ENTRIES = 14;

export interface MyDaySnapshot<T = unknown> {
  /** Epoch ms of the successful fetch this snapshot was taken from. */
  ts: number;
  data: T;
}

function keyFor(day: string, staffId: string | null | undefined) {
  return `${PREFIX}${day}:${staffId ?? "self"}`;
}

export function saveMyDaySnapshot(
  day: string,
  staffId: string | null | undefined,
  data: unknown,
): void {
  if (typeof window === "undefined") return;
  try {
    const snapshot: MyDaySnapshot = { ts: Date.now(), data };
    window.localStorage.setItem(keyFor(day, staffId), JSON.stringify(snapshot));
    prune();
  } catch {
    // Storage full or blocked — the cache is best-effort, never fatal.
  }
}

export function loadMyDaySnapshot<T = unknown>(
  day: string,
  staffId: string | null | undefined,
): MyDaySnapshot<T> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(keyFor(day, staffId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MyDaySnapshot<T>;
    if (!parsed || typeof parsed.ts !== "number" || !("data" in parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Keep only the newest MAX_ENTRIES snapshots so old days don't accumulate. */
function prune(): void {
  const rows: { key: string; ts: number }[] = [];
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i);
    if (!key || !key.startsWith(PREFIX)) continue;
    let ts = 0;
    try {
      ts = (JSON.parse(window.localStorage.getItem(key) ?? "") as MyDaySnapshot).ts ?? 0;
    } catch {
      ts = 0; // unreadable entry sorts oldest and gets evicted first
    }
    rows.push({ key, ts });
  }
  if (rows.length <= MAX_ENTRIES) return;
  rows.sort((a, b) => b.ts - a.ts);
  for (const row of rows.slice(MAX_ENTRIES)) {
    window.localStorage.removeItem(row.key);
  }
}
