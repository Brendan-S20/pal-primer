import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingAction } from "@/lib/offline/queue";
import {
  holdUntilRefetched,
  lifecycleCollision,
  queuedLifecycleByVisit,
  withQueuedLifecycle,
} from "@/lib/offline/queued-visit-state";
import { dayAtAGlance } from "@/lib/my-day-progress";
import en from "@/lib/i18n/locales/en";

// Found by a field tester on 2026-09-27. Completing a visit OFFLINE queued
// correctly — the toast said "Queued. Completes when back online", the replay
// later landed with the real tap time, nothing was lost — and the screen did
// not move on. The card still said "in progress", Complete stayed live, the
// count did not change, the bottom bar still read "IN PROGRESS · #5 Resume",
// and the next stop was never promoted. A second tap on Complete queued a
// second completion: three pending where there should have been two.
//
// Start and Skip had the same gap. Nothing the page read changed when an
// action was QUEUED; only a successful online action invalidated the day.
//
// These drive the real functions the page now draws from, on the tester's
// day, rather than asserting that some string appears in my-day.tsx.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const code = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");

/** 9:15 this morning, in a dead zone. */
const TAPPED = new Date("2026-09-27T13:15:00.000Z").getTime();

type V = {
  id: string;
  sequence: number;
  status: string;
  started_at?: string | null;
  completed_at?: string | null;
  skipped_at?: string | null;
  skip_reason?: string | null;
  skip_reason_code?: string | null;
};

/** The tester's day: four done, #5 open, two to go. */
const theDay = (): V[] => [
  { id: "v1", sequence: 1, status: "completed" },
  { id: "v2", sequence: 2, status: "completed" },
  { id: "v3", sequence: 3, status: "completed" },
  { id: "v4", sequence: 4, status: "completed" },
  { id: "v5", sequence: 5, status: "in_progress", started_at: "2026-09-27T13:02:00.000Z" },
  { id: "v6", sequence: 6, status: "scheduled" },
  { id: "v7", sequence: 7, status: "scheduled" },
];

let n = 0;
const act = (a: Record<string, unknown>): PendingAction =>
  ({ id: `a${++n}`, ts: TAPPED, userId: "tech-a", ...a }) as PendingAction;
const complete = (visitId: string, ts = TAPPED) => act({ kind: "complete", visitId, ts });
const start = (visitId: string, ts = TAPPED) => act({ kind: "start", visitId, ts });
const skip = (visitId: string, ts = TAPPED) =>
  act({ kind: "skip", visitId, ts, code: "gate_locked", reason: "padlocked, no answer" });
const photo = (visitId: string, ts = TAPPED) =>
  act({
    kind: "photo",
    visitId,
    ts,
    photoKind: "completion",
    photoId: "p1",
    organizationId: "org-1",
  });

describe("an offline Complete moves the day on", () => {
  const queue = [photo("v5", TAPPED - 60_000), complete("v5")];
  const shown = withQueuedLifecycle(theDay(), queuedLifecycleByVisit(queue));
  const glance = dayAtAGlance(shown);

  it("shows the visit done, and says it is still syncing", () => {
    const v5 = shown.find((v) => v.id === "v5")!;
    expect(v5.status).toBe("completed");
    expect(v5.queuedSync).toBe("complete");
    // The TAP time — the same value the replay sends as completedAt.
    expect(v5.completed_at).toBe(new Date(TAPPED).toISOString());
    // The server's own start time is kept, not replaced.
    expect(v5.started_at).toBe("2026-09-27T13:02:00.000Z");
  });

  it("counts it", () => {
    expect(glance.completedCount).toBe(5);
    expect(glance.total).toBe(7);
    expect(glance.pct).toBe(71);
  });

  it("stops calling it the open job, and promotes the next stop", () => {
    // "IN PROGRESS · #5 Resume" was the bottom bar's reading of this day.
    expect(glance.activeVisit).toBeUndefined();
    expect(glance.nextUp?.id).toBe("v6");
  });

  it("leaves every visit it has nothing queued for exactly as the server sent it", () => {
    const before = theDay();
    for (const v of shown.filter((x) => x.id !== "v5")) {
      expect(v).toEqual(before.find((b) => b.id === v.id));
    }
  });

  it("draws the same after a reload in the same dead zone", () => {
    // The day is restored from disk and the queue from IndexedDB; neither is
    // component state, so the derived screen is identical.
    const again = withQueuedLifecycle(theDay(), queuedLifecycleByVisit([...queue]));
    expect(again).toEqual(shown);
  });

  it("with nothing queued, hands back the server's list untouched", () => {
    const day = theDay();
    expect(withQueuedLifecycle(day, new Map())).toBe(day);
  });
});

describe("Start and Skip had the same gap", () => {
  it("a queued Start opens the visit, at the time it was tapped", () => {
    const shown = withQueuedLifecycle(
      theDay().map((v) => (v.id === "v5" ? { ...v, status: "completed" } : v)),
      queuedLifecycleByVisit([start("v6")]),
    );
    const v6 = shown.find((v) => v.id === "v6")!;
    expect(v6.status).toBe("in_progress");
    expect(v6.queuedSync).toBe("start");
    expect(v6.started_at).toBe(new Date(TAPPED).toISOString());
    // So the Start button is gone and the bar says Resume, not Jump.
    expect(dayAtAGlance(shown).activeVisit?.id).toBe("v6");
  });

  it("a queued Skip closes the visit with its reason, and does not count as done", () => {
    const shown = withQueuedLifecycle(theDay(), queuedLifecycleByVisit([skip("v6")]));
    const v6 = shown.find((v) => v.id === "v6")!;
    expect(v6.status).toBe("skipped");
    expect(v6.queuedSync).toBe("skip");
    expect(v6.skip_reason_code).toBe("gate_locked");
    expect(v6.skip_reason).toBe("padlocked, no answer");
    expect(v6.skipped_at).toBe(new Date(TAPPED).toISOString());
    const glance = dayAtAGlance(shown);
    expect(glance.completedCount).toBe(4); // H1: skipped is not done
    expect(glance.skippedCount).toBe(1);
    // #5 is still open, so it still outranks #7.
    expect(glance.nextUp?.id).toBe("v5");
  });

  it("Start then Complete, both offline, is a completed visit that remembers when it began", () => {
    const shown = withQueuedLifecycle(
      theDay(),
      queuedLifecycleByVisit([start("v6", TAPPED), complete("v6", TAPPED + 20 * 60_000)]),
    );
    const v6 = shown.find((v) => v.id === "v6")!;
    expect(v6.status).toBe("completed");
    expect(v6.started_at).toBe(new Date(TAPPED).toISOString());
    expect(v6.completed_at).toBe(new Date(TAPPED + 20 * 60_000).toISOString());
  });
});

describe("the queue is read the way the replay will run it", () => {
  it("in time order, whatever order the rows arrive in", () => {
    const q = queuedLifecycleByVisit([complete("v6", TAPPED + 1000), start("v6", TAPPED)]);
    expect(q.get("v6")).toMatchObject({ kind: "complete", startedAt: TAPPED });
  });

  it("the first ending wins, because it is the one the server accepts", () => {
    const q = queuedLifecycleByVisit([complete("v5", TAPPED), skip("v5", TAPPED + 1000)]);
    expect(q.get("v5")).toMatchObject({ kind: "complete", at: TAPPED });
    const dup = queuedLifecycleByVisit([complete("v5", TAPPED), complete("v5", TAPPED + 5000)]);
    expect(dup.get("v5")).toMatchObject({ kind: "complete", at: TAPPED });
  });

  it("ignores photos and station logs, which say nothing about where a visit is", () => {
    expect(queuedLifecycleByVisit([photo("v5")]).size).toBe(0);
    expect(
      queuedLifecycleByVisit([act({ kind: "station", visitId: "v5", wasteStationId: "s1" })]).size,
    ).toBe(0);
  });

  it("never overrides a status the server has settled", () => {
    // The replay landed, or somebody else closed the visit. Either way the
    // server is telling the truth and the device is behind.
    const settled = theDay().map((v) => (v.id === "v5" ? { ...v, status: "skipped" as const } : v));
    const shown = withQueuedLifecycle(settled, queuedLifecycleByVisit([complete("v5")]));
    expect(shown.find((v) => v.id === "v5")).toEqual(settled.find((v) => v.id === "v5"));
  });

  it("a queued Start does nothing to a visit the server already has open", () => {
    const shown = withQueuedLifecycle(theDay(), queuedLifecycleByVisit([start("v5")]));
    expect(shown.find((v) => v.id === "v5")?.queuedSync).toBeUndefined();
  });
});

describe("between the replay and the refetch, the card does not flip back", () => {
  // syncQueue deletes each action the moment the server accepts it, and the
  // day is refetched only after the loop ends. Reading the queue alone, a
  // done card went back to "in progress" — Complete live again — for as long
  // as that refetch took.
  const queued = queuedLifecycleByVisit([complete("v5")]);
  const FETCHED = TAPPED - 3_600_000; // the copy on disk, from this morning
  const SYNCED = TAPPED + 7_200_000;

  it("holds an entry that has left the queue until the day is fetched again", () => {
    const whileQueued = holdUntilRefetched(new Map(), queued, FETCHED, TAPPED);
    const afterReplay = holdUntilRefetched(whileQueued, new Map(), FETCHED, SYNCED);
    expect(afterReplay.get("v5")).toMatchObject({ kind: "complete", leftQueueAt: SYNCED });
    // Still drawn as done.
    expect(withQueuedLifecycle(theDay(), afterReplay).find((v) => v.id === "v5")?.status).toBe(
      "completed",
    );
    // And the moment it was first seen gone is kept, not re-stamped.
    const later = holdUntilRefetched(afterReplay, new Map(), FETCHED, SYNCED + 500);
    expect(later.get("v5")?.leftQueueAt).toBe(SYNCED);
  });

  it("lets go once the server has been asked since, whatever it answered", () => {
    const whileQueued = holdUntilRefetched(new Map(), queued, FETCHED, TAPPED);
    const afterReplay = holdUntilRefetched(whileQueued, new Map(), FETCHED, SYNCED);
    const refetched = holdUntilRefetched(afterReplay, new Map(), SYNCED + 900, SYNCED + 900);
    expect(refetched.size).toBe(0);
    // A DEAD-LETTERED completion leaves the queue the same way and is not
    // done. The refetch shows it still open, and so does the card — which,
    // with the toast naming the stop, is how the tech learns to go back.
    const serverStillOpen = theDay();
    expect(withQueuedLifecycle(serverStillOpen, refetched).find((v) => v.id === "v5")?.status).toBe(
      "in_progress",
    );
  });

  it("keeps anything still queued, however recently the day was fetched", () => {
    const held = holdUntilRefetched(new Map(), queued, SYNCED + 900, SYNCED + 900);
    expect(held.get("v5")).toMatchObject({ kind: "complete" });
    expect(held.get("v5")?.leftQueueAt).toBeUndefined();
  });
});

describe("a second tap cannot queue a second completion", () => {
  it("the same action again for the same visit is the one already queued", () => {
    const first = complete("v5");
    const hit = lifecycleCollision([first], { kind: "complete", visitId: "v5", userId: "tech-a" });
    expect(hit).toEqual({ duplicate: first });
  });

  it("anything after a queued ending is refused, in words", () => {
    const q = [complete("v5")];
    for (const kind of ["skip", "start"] as const) {
      const hit = lifecycleCollision(
        q,
        kind === "skip"
          ? { kind, visitId: "v5", userId: "tech-a", code: "other", reason: "x" }
          : { kind, visitId: "v5", userId: "tech-a" },
      );
      expect(hit && "conflict" in hit && hit.conflict).toMatch(/already completed/);
    }
  });

  it("Complete after a queued Start is the normal offline visit, not a collision", () => {
    expect(
      lifecycleCollision([start("v5")], { kind: "complete", visitId: "v5", userId: "tech-a" }),
    ).toBeNull();
  });

  it("is scoped like everything else in the queue: another tech's row is not mine", () => {
    expect(
      lifecycleCollision([complete("v5")], { kind: "complete", visitId: "v5", userId: "tech-b" }),
    ).toBeNull();
    expect(
      lifecycleCollision([complete("v5")], { kind: "complete", visitId: "v6", userId: "tech-a" }),
    ).toBeNull();
  });

  it("says nothing about photos or station logs, which may repeat", () => {
    expect(
      lifecycleCollision([photo("v5")], {
        kind: "photo",
        visitId: "v5",
        userId: "tech-a",
        photoKind: "completion",
        photoId: "p2",
        organizationId: "org-1",
      }),
    ).toBeNull();
  });
});

// ── the queue itself, on an in-memory IndexedDB ─────────────────────────────
//
// The screen now hides Complete once a completion is queued, but it learns
// that from an IndexedDB read that lands after the toast. A double-tap is
// faster, so enqueueAction refuses the repeat on its own account.

let rows: PendingAction[] = [];
vi.mock("idb", () => {
  const store = {
    getAll: async () => [...rows],
    put: async (r: PendingAction) => {
      rows = [...rows.filter((x) => x.id !== r.id), r];
    },
  };
  const db = {
    put: async (_s: string, r: PendingAction) => store.put(r),
    transaction: (_s: string, _mode: string) => ({ store, done: Promise.resolve() }),
  };
  return { openDB: async () => db };
});

describe("enqueueAction", () => {
  beforeEach(() => {
    rows = [];
    (globalThis as { window?: unknown }).window = new EventTarget();
  });

  it("queues one completion for two taps, and answers both with its id", async () => {
    const { enqueueAction } = await import("@/lib/offline/queue");
    const a = await enqueueAction({ kind: "complete", visitId: "v5", userId: "tech-a" });
    const b = await enqueueAction({ kind: "complete", visitId: "v5", userId: "tech-a" });
    expect(rows.filter((r) => r.kind === "complete")).toHaveLength(1);
    expect(b).toBe(a);
  });

  it("refuses a skip behind a queued completion rather than queueing a refusal", async () => {
    const { enqueueAction } = await import("@/lib/offline/queue");
    await enqueueAction({ kind: "complete", visitId: "v5", userId: "tech-a" });
    await expect(
      enqueueAction({ kind: "skip", visitId: "v5", userId: "tech-a", code: "other", reason: "x" }),
    ).rejects.toThrow(/already completed/);
    expect(rows).toHaveLength(1);
  });

  it("still queues every photo — two completion photos are two photos", async () => {
    const { enqueueAction } = await import("@/lib/offline/queue");
    const p = {
      kind: "photo" as const,
      visitId: "v5",
      userId: "tech-a",
      photoKind: "completion" as const,
      organizationId: "org-1",
    };
    await enqueueAction({ ...p, photoId: "p1" });
    await enqueueAction({ ...p, photoId: "p2" });
    expect(rows).toHaveLength(2);
  });

  it("checks and writes in ONE readwrite transaction, so two taps cannot both pass", () => {
    const fn = /export async function enqueueAction[\s\S]*?\n\}/.exec(
      code(read("src/lib/offline/queue.ts")),
    )![0];
    expect(fn).toMatch(/db\.transaction\("actions", "readwrite"\)/);
    const check = fn.indexOf("lifecycleCollision(await tx.store.getAll()");
    const write = fn.indexOf("await tx.store.put(record)");
    expect(check).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(check);
  });
});

describe("My Day draws from the day as worked", () => {
  const page = code(read("src/routes/_authenticated/my-day.tsx"));

  it("applies the queue to the visits everything else reads", () => {
    expect(page).toMatch(/useQueuedLifecycle\(dataUpdatedAt\)/);
    expect(page).toMatch(/withQueuedLifecycle\(serverVisits \?\? \[\], queuedLifecycle\)/);
    // The count, the open job and the next stop come from that list — not
    // from `data.visits`, which is the server's copy and knows nothing queued.
    expect(page).toMatch(/= dayAtAGlance\(visits\)/);
    expect(page).not.toMatch(/data\?\.visits\s*\?\?\s*\[\]/);
  });

  it("says a queued status is syncing, rather than passing it off as the server's", () => {
    expect(page).toMatch(/statusBadge\(visit\.status, visit\.queuedSync, t\)/);
    // The badge's words are lib/i18n's, keyed by the queued kind.
    expect(page).toMatch(/t\(`queuedStatus\.\$\{queuedSync\}`\)/);
    expect(en.queuedStatus.complete).toBe("done · syncing");
  });
});
