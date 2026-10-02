// Cash taken in a dead zone reaches the office, once, at the time it was taken.
//
// A tech records $40 at a gate with one bar. runOrQueue gives the request
// eight seconds and then queues it -- without cancelling it, because it
// cannot. So the request may have landed AND the queue holds it. Replay has to
// send the same idempotency key the first attempt sent, or the office is told
// about $80. And it has to say 9:15, not whenever signal came back, because
// that is the payment's date on the cash-basis report.
//
// Driven through syncQueue with a stubbed queue and fake callers, the way the
// station-log test does it: this asserts what the server is ASKED for.

import { describe, expect, it, vi, beforeEach } from "vitest";
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

function fakeCallers(impl: (a: Sent) => Promise<void> = async () => {}) {
  const callers = {
    startVisit: vi.fn(async (_a: Sent) => {}),
    completeVisit: vi.fn(async (_a: Sent) => {}),
    skipVisit: vi.fn(async (_a: Sent) => {}),
    recordVisitPhoto: vi.fn(async (_a: Sent) => {}),
    logStationService: vi.fn(async (_a: Sent) => {}),
    clockIn: vi.fn(async (_a: Sent) => {}),
    clockOut: vi.fn(async (_a: Sent) => {}),
    recordFieldCollection: vi.fn(impl),
  };
  return { callers, as: callers as unknown as SyncCallers };
}

const TAKEN_AT = new Date("2026-10-02T14:15:00.000Z").getTime();
const KEY = "7c1e2a90-1111-4222-8333-944455556666";

const collection = (over: Record<string, unknown> = {}): Queued => ({
  id: "act-1",
  ts: TAKEN_AT,
  userId: "tech-a",
  kind: "collection",
  visitId: "visit-1",
  amountCents: 4000,
  method: "check",
  reference: "1042",
  clientKey: KEY,
  ...over,
});

describe("a collection queued at the gate replays as the collection it was", () => {
  beforeEach(() => {
    pending = [];
    deleted.length = 0;
  });

  it("reaches the server, with the amount, method and check number taken", async () => {
    const { syncQueue } = await import("@/lib/offline/sync");
    pending = [collection()];
    const { callers, as } = fakeCallers();
    const res = await syncQueue(as, "tech-a");
    expect(
      callers.recordFieldCollection,
      "the collection kind fell through runOne's switch: counted as synced, sent nowhere",
    ).toHaveBeenCalledTimes(1);
    expect(callers.recordFieldCollection.mock.calls[0][0]).toMatchObject({
      data: { visitId: "visit-1", amountCents: 4000, method: "check", reference: "1042" },
    });
    expect(res.succeeded).toBe(1);
    expect(deleted).toEqual(["act-1"]);
  });

  it("carries the key minted before the first attempt, every time", async () => {
    const { syncQueue } = await import("@/lib/offline/sync");
    pending = [collection()];
    const first = fakeCallers(async () => {
      throw new Error("Failed to fetch");
    });
    await syncQueue(first.as, "tech-a");
    const second = fakeCallers();
    await syncQueue(second.as, "tech-a");
    expect(first.callers.recordFieldCollection.mock.calls[0][0].data.clientKey).toBe(KEY);
    expect(second.callers.recordFieldCollection.mock.calls[0][0].data.clientKey).toBe(KEY);
  });

  it("says when the money was handed over, not when signal came back", async () => {
    const { syncQueue } = await import("@/lib/offline/sync");
    pending = [collection()];
    const { callers, as } = fakeCallers();
    await syncQueue(as, "tech-a");
    const sent = callers.recordFieldCollection.mock.calls[0][0].data;
    expect(new Date(String(sent.collectedAt)).getTime()).toBe(TAKEN_AT);
  });

  it("stays queued when the server refuses it", async () => {
    const { syncQueue } = await import("@/lib/offline/sync");
    pending = [collection()];
    const { as } = fakeCallers(async () => {
      throw new Error("That is more than this customer owes ($25.00)");
    });
    const res = await syncQueue(as, "tech-a");
    expect(res.succeeded).toBe(0);
    expect(deleted).toEqual([]);
  });
});
