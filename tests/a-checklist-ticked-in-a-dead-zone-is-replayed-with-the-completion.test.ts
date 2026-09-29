// A checklist ticked in a dead zone is replayed with the completion.
//
// complete_visit now refuses a completion while a required checklist item is
// unchecked. That is right for the live path and a trap for the offline one:
// a tech ticks "Gate latched" and "All areas walked" at the back of a yard
// with no signal, Complete is queued, and when the van finds signal the
// replay reaches the server. If the ticks did not travel with it, the server
// refuses — and a refusal is not a network error, so the sync loop burns
// attempts on it until it is dead-lettered, and the card the tech saw go
// green goes back to "in progress" hours later.
//
// So the ticks go everywhere the note goes: the queued action's payload
// (queue.ts), the replay (sync.ts), the live-or-queue decision
// (useOfflineVisitActions), the server function, and the optimistic view the
// card draws while the action waits (queued-visit-state). The replay is
// DRIVEN here with a stubbed queue, so what is asserted is what the server is
// asked for, not that a word appears in a file.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SyncCallers } from "@/lib/offline/sync";
import type { PendingAction } from "@/lib/offline/queue";
import { queuedLifecycleByVisit, withQueuedLifecycle } from "@/lib/offline/queued-visit-state";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

type Queued = { id: string } & Record<string, unknown>;
type Sent = { data: Record<string, unknown> };

let pending: Queued[] = [];

vi.mock("@/lib/offline/queue", () => ({
  listPending: vi.fn(async () => pending),
  deleteAction: vi.fn(async (id: string) => {
    pending = pending.filter((a) => a.id !== id);
  }),
  recordAttempt: vi.fn(async () => 1),
  getPhoto: vi.fn(async () => undefined),
  deletePhoto: vi.fn(async () => {}),
}));

function fakeCallers() {
  const callers = {
    startVisit: vi.fn(async (_a: Sent) => {}),
    completeVisit: vi.fn(async (_a: Sent) => {}),
    skipVisit: vi.fn(async (_a: Sent) => {}),
    recordVisitPhoto: vi.fn(async (_a: Sent) => {}),
    logStationService: vi.fn(async (_a: Sent) => {}),
    clockIn: vi.fn(async (_a: Sent) => {}),
    clockOut: vi.fn(async (_a: Sent) => {}),
  };
  return { callers, as: callers as unknown as SyncCallers };
}

/** 9:15 in the back yard. */
const TAPPED = new Date("2026-09-29T14:15:00.000Z").getTime();

const queuedComplete = (over: Record<string, unknown> = {}): Queued => ({
  id: "act-complete",
  ts: TAPPED,
  userId: "tech-a",
  kind: "complete",
  visitId: "visit-5",
  note: "Bags by the shed",
  checkedItems: ["walk", "gate"],
  ...over,
});

describe("the replay sends the ticks the tech made", () => {
  beforeEach(() => {
    pending = [];
  });

  it("carries checkedItems to the server, with the note and the tap time", async () => {
    const { syncQueue } = await import("@/lib/offline/sync");
    pending = [queuedComplete()];
    const { callers, as } = fakeCallers();

    const res = await syncQueue(as, "tech-a");

    expect(res.succeeded).toBe(1);
    expect(callers.completeVisit).toHaveBeenCalledTimes(1);
    expect(callers.completeVisit.mock.calls[0][0]).toEqual({
      data: {
        visitId: "visit-5",
        completedAt: new Date(TAPPED).toISOString(),
        note: "Bags by the shed",
        noPhotoReason: undefined,
        checkedItems: ["walk", "gate"],
      },
    });
  });

  it("replays an action queued before the checklist existed exactly as before", async () => {
    // No field at all, not an empty list: complete_visit reads NULL as
    // "nothing checked", which for an org with no checklist asks for nothing.
    const { syncQueue } = await import("@/lib/offline/sync");
    pending = [queuedComplete({ checkedItems: undefined })];
    const { callers, as } = fakeCallers();

    await syncQueue(as, "tech-a");

    expect(callers.completeVisit.mock.calls[0][0].data.checkedItems).toBeUndefined();
  });
});

describe("the queued action is built from the same payload as the live call", () => {
  it("types the ticks on the queued complete", () => {
    // Compile-time: a queued complete with checkedItems is a PendingAction.
    const a: PendingAction = {
      id: "x",
      ts: TAPPED,
      userId: "tech-a",
      kind: "complete",
      visitId: "visit-5",
      checkedItems: ["gate"],
    };
    expect(a.kind).toBe("complete");
    expect(read("src/lib/offline/queue.ts")).toMatch(/checkedItems\?: string\[\];/);
  });

  it("spreads one CompleteExtra into both the network call and the queue write", () => {
    const hook = read("src/lib/offline/useOfflineVisitActions.ts");
    expect(hook).toMatch(
      /export type CompleteExtra = \{[\s\S]*?checkedItems\?: string\[\];[\s\S]*?\}/,
    );
    const complete = hook.slice(hook.indexOf("const complete = useCallback"));
    expect(complete).toMatch(/send: \(\) => completeFn\(\{ data: \{ visitId, \.\.\.extra \} \}\)/);
    expect(complete).toMatch(/kind: "complete",\s+visitId,\s+\.\.\.extra,/);
  });

  it("hands the server function's ids to complete_visit", () => {
    const fn = read("src/lib/my-day.functions.ts");
    expect(fn).toMatch(/checkedItems: z\s*\.array\(/);
    expect(fn).toMatch(/_checked_items: data\.checkedItems \?\? undefined/);
  });
});

describe("the card shows the ticks while they wait to sync", () => {
  it("puts the queued answers on the visit the page draws", () => {
    const queued = queuedLifecycleByVisit([queuedComplete() as unknown as PendingAction]);
    expect(queued.get("visit-5")).toMatchObject({
      kind: "complete",
      checkedItems: ["walk", "gate"],
    });

    const [shown] = withQueuedLifecycle(
      [{ id: "visit-5", status: "in_progress", started_at: "2026-09-29T14:00:00.000Z" }],
      queued,
    );
    expect(shown.status).toBe("completed");
    expect(shown.queuedCheckedItems).toEqual(["walk", "gate"]);
  });

  it("leaves a server-settled visit to the server's own record", () => {
    const queued = queuedLifecycleByVisit([queuedComplete() as unknown as PendingAction]);
    const [shown] = withQueuedLifecycle([{ id: "visit-5", status: "completed" }], queued);
    expect(shown.queuedCheckedItems).toBeUndefined();
  });

  it("draws them on the completed card until the server's copy arrives", () => {
    const page = read("src/routes/_authenticated/my-day.tsx");
    expect(page).toMatch(
      /parseAnswers\(visit\.visit_checklist\) \?\?\s+\(visit\.queuedCheckedItems \? answersFor\(checklist, visit\.queuedCheckedItems\) : null\)/,
    );
  });
});
