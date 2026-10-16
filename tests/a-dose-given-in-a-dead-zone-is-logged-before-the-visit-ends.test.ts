// A dose given in a dead zone is logged before the visit ends (#411).
//
// A sitter's care log entries go through the offline queue (kinds care_entry
// and care_entry_undo) and the queue replays oldest first, so an entry tapped
// before End visit reaches record_care_entry before complete_visit, and the
// visit report is written from it. Same rule as the walk report (#410).
//
// Driven through syncQueue with a stubbed queue and fake callers, as
// tests/a-station-log-in-a-basement-garage.test.ts does: this asserts what
// the server is ASKED for, and in what order.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { SyncCallers } from "@/lib/offline/sync";

type Queued = { id: string } & Record<string, unknown>;
type Sent = { data: Record<string, unknown> };

let pending: Queued[] = [];
const deleted: string[] = [];

vi.mock("@/lib/offline/queue", () => ({
  listPending: vi.fn(async () => pending),
  deleteAction: vi.fn(async (id: string) => {
    deleted.push(id);
    pending = pending.filter((a) => a.id !== id);
  }),
  recordAttempt: vi.fn(async () => 1),
  getPhoto: vi.fn(async () => undefined),
  deletePhoto: vi.fn(async () => {}),
}));

/** 8:10 this morning, when the insulin was given. */
const GIVEN_AT = new Date("2026-10-19T13:10:00.000Z").getTime();

const care = (over: Record<string, unknown> = {}): Queued => ({
  id: "act-care",
  ts: GIVEN_AT,
  userId: "sitter-a",
  kind: "care_entry",
  visitId: "visit-1",
  entryId: "11111111-1111-4111-8111-111111111111",
  petId: "22222222-2222-4222-8222-222222222222",
  careKind: "meds",
  medName: "Insulin",
  status: "done",
  missedReason: null,
  note: null,
  ...over,
});

const complete = (over: Record<string, unknown> = {}): Queued => ({
  id: "act-complete",
  ts: GIVEN_AT + 20 * 60_000,
  userId: "sitter-a",
  kind: "complete",
  visitId: "visit-1",
  ...over,
});

function fakeCallers(careImpl: (a: Sent) => Promise<void> = async () => {}) {
  const order: string[] = [];
  const track =
    (name: string, impl: (a: Sent) => Promise<void> = async () => {}) =>
    async (a: Sent) => {
      order.push(name);
      await impl(a);
    };
  const callers = {
    startVisit: vi.fn(track("start")),
    completeVisit: vi.fn(track("complete")),
    skipVisit: vi.fn(track("skip")),
    recordVisitPhoto: vi.fn(track("photo")),
    recordWalkReport: vi.fn(track("walk_report")),
    recordCareEntry: vi.fn(track("care_entry", careImpl)),
    deleteCareEntry: vi.fn(track("care_entry_undo")),
  };
  return { callers, order, as: callers as unknown as SyncCallers };
}

describe("a care entry queued in a dead zone", () => {
  beforeEach(() => {
    pending = [];
    deleted.length = 0;
  });

  it("replays before the completion queued behind it, with the time it was given", async () => {
    const { syncQueue } = await import("@/lib/offline/sync");
    pending = [care(), complete()];
    const { callers, order, as } = fakeCallers();

    const res = await syncQueue(as, "sitter-a");

    expect(order).toEqual(["care_entry", "complete"]);
    expect(res.succeeded).toBe(2);
    expect(callers.recordCareEntry).toHaveBeenCalledWith({
      data: {
        id: "11111111-1111-4111-8111-111111111111",
        visitId: "visit-1",
        petId: "22222222-2222-4222-8222-222222222222",
        kind: "meds",
        medName: "Insulin",
        status: "done",
        missedReason: null,
        note: null,
        // When it was given, not when signal came back.
        at: "2026-10-19T13:10:00.000Z",
      },
    });
  });

  it("carries a missed dose's reason", async () => {
    const { syncQueue } = await import("@/lib/offline/sync");
    pending = [care({ status: "missed", missedReason: "She hid under the bed" })];
    const { callers, as } = fakeCallers();
    await syncQueue(as, "sitter-a");
    const sent = callers.recordCareEntry.mock.calls[0][0] as Sent;
    expect(sent.data.status).toBe("missed");
    expect(sent.data.missedReason).toBe("She hid under the bed");
  });

  it("replays an undo in its place, naming the entry", async () => {
    const { syncQueue } = await import("@/lib/offline/sync");
    pending = [
      care(),
      {
        id: "act-undo",
        ts: GIVEN_AT + 60_000,
        userId: "sitter-a",
        kind: "care_entry_undo",
        visitId: "visit-1",
        entryId: "11111111-1111-4111-8111-111111111111",
      },
      complete(),
    ];
    const { callers, order, as } = fakeCallers();
    await syncQueue(as, "sitter-a");
    expect(order).toEqual(["care_entry", "care_entry_undo", "complete"]);
    expect(callers.deleteCareEntry).toHaveBeenCalledWith({
      data: { id: "11111111-1111-4111-8111-111111111111" },
    });
  });

  it("holds the completion back when the entry cannot reach the server", async () => {
    const { syncQueue } = await import("@/lib/offline/sync");
    pending = [care(), complete()];
    const { callers, as } = fakeCallers(async () => {
      throw new Error("The care log is open while the visit is under way");
    });
    const res = await syncQueue(as, "sitter-a");
    expect(callers.completeVisit).not.toHaveBeenCalled();
    expect(res.failed).toBe(1);
    expect(deleted).toEqual([]);
  });
});

describe("the card queues the completion behind a queued entry", () => {
  const page = readFileSync("src/routes/_authenticated/my-day.tsx", "utf8");
  const parts = readFileSync("src/components/my-day/SitParts.tsx", "utf8");
  const queue = readFileSync("src/lib/offline/queue.ts", "utf8");
  const sync = readFileSync("src/lib/offline/sync.ts", "utf8");
  const callers = readFileSync("src/hooks/useSyncCallers.ts", "utf8");

  it("asks whether a care entry is still on the device before completing", () => {
    const completeAt = page.indexOf("const complete = useMutation");
    const body = page.slice(completeAt);
    const asked = body.indexOf("await sitCare.hasQueued()");
    expect(asked).toBeGreaterThan(-1);
    expect(asked).toBeLessThan(body.indexOf("actions.complete({"));
    expect(body).toMatch(/queueOnly: reportQueued \|\| careQueued/);
    expect(parts).toMatch(
      /\(a\.kind === "care_entry" \|\| a\.kind === "care_entry_undo"\) && a\.visitId === visitId/,
    );
  });

  it("has the kinds, their replay and their callers", () => {
    expect(queue).toMatch(/kind: "care_entry";/);
    expect(queue).toMatch(/kind: "care_entry_undo"; visitId: string; entryId: string/);
    expect(sync).toMatch(/case "care_entry":[\s\S]{0,500}callers\.recordCareEntry\(/);
    expect(sync).toMatch(/case "care_entry_undo":[\s\S]{0,200}callers\.deleteCareEntry\(/);
    expect(callers).toMatch(/recordCareEntry: careEntryFn/);
    expect(callers).toMatch(/deleteCareEntry: careUndoFn/);
  });

  it("mints the entry id before the first attempt, and undoes a queued entry by dropping it", () => {
    const log = parts.slice(parts.indexOf("const log = useCallback"));
    expect(log.indexOf("const id = newClientKey()")).toBeLessThan(log.indexOf("runOrQueue({"));
    const undo = parts.slice(parts.indexOf("const undo = useCallback"));
    expect(undo.indexOf("await deleteAction(waiting.id)")).toBeLessThan(
      undo.indexOf("undoFn({ data: { id: entry.id } })"),
    );
  });

  it("reads the queue only for a sitting stop", () => {
    expect(page).toMatch(/const sitCare = useSitCare\(visit, sit\)/);
    expect(parts).toMatch(/useEffect\(\(\) => \{\s*if \(!enabled\) return;/);
    expect(parts).toMatch(/const hasQueued = useCallback\(async \(\) => \{\s*if \(!enabled\) return false;/);
  });
});
