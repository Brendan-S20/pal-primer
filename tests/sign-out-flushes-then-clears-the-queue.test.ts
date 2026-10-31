import { describe, expect, it, vi, beforeEach } from "vitest";

// `clearQueueForUser` was written, its doc comment said "Called on sign-out",
// and nothing called it. `signOutAndClearDevice` swept localStorage only —
// despite its own comment promising to "destroy the persisted day" — so on a
// shared crew tablet, signing out left the whole IndexedDB action queue behind:
// unsynced starts/completes/skips, and the photo BLOBS attached to them,
// pictures of customers' yards, gates and houses, sitting under the next
// person's session.
//
// Clearing alone would have been a data-loss bug wearing a privacy fix's
// clothes — a tech who finishes a route in a dead zone and signs out at the
// office would lose the afternoon. So: flush, count what is LEFT, ask, clear.
// These tests hold that order and that consent.

const listeners = {
  syncQueue: vi.fn(),
  clearQueueForUser: vi.fn(),
  signOutAndClearDevice: vi.fn(),
};
const order: string[] = [];
let pendingCounts: number[] = [];
let owner: string | null = "tech-a";

vi.mock("@/lib/offline/queue", () => ({
  countPending: vi.fn(async () => pendingCounts.shift() ?? 0),
  clearQueueForUser: vi.fn(async (userId: string) => {
    order.push("clear");
    listeners.clearQueueForUser(userId);
  }),
}));

vi.mock("@/lib/offline/sync", () => ({
  syncQueue: vi.fn(async (_callers: unknown, userId: string) => {
    order.push("flush");
    listeners.syncQueue(userId);
    return { attempted: 0, succeeded: 1, failed: 0, dropped: 0, deadLettered: 0 };
  }),
}));

vi.mock("@/lib/offline/read-cache", () => ({
  signOutAndClearDevice: vi.fn(async () => {
    order.push("signOut");
    listeners.signOutAndClearDevice();
  }),
}));

vi.mock("@/lib/offline/action-owner", () => ({
  resolveOfflineUserId: vi.fn(async () => {
    if (owner === null) throw new Error("sign-in couldn't be confirmed");
    return owner;
  }),
}));

// Walk report drafts (#610): every one on the device goes at sign-out.
const clearAllWalkDrafts = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/offline/walk-drafts", () => ({ clearAllWalkDrafts }));

const { flushThenClearAndSignOut } = await import("@/lib/offline/sign-out");
const { syncQueue } = await import("@/lib/offline/sync");
const { clearQueueForUser } = await import("@/lib/offline/queue");

const CALLERS = {
  startVisit: vi.fn(),
  completeVisit: vi.fn(),
  skipVisit: vi.fn(),
  recordVisitPhoto: vi.fn(),
} as any;

function setOnline(online: boolean) {
  vi.stubGlobal("navigator", { onLine: online });
}

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  pendingCounts = [];
  owner = "tech-a";
  setOnline(true);
});

describe("sign-out with queued field work", () => {
  it("clears this user's queue — the call that never happened", async () => {
    pendingCounts = [0, 0];
    const out = await flushThenClearAndSignOut({ callers: CALLERS });
    expect(listeners.clearQueueForUser).toHaveBeenCalledWith("tech-a");
    expect(out.signedOut).toBe(true);
  });

  it("flushes BEFORE it clears, so unsynced work gets one last chance", async () => {
    pendingCounts = [3, 0];
    const out = await flushThenClearAndSignOut({ callers: CALLERS });
    expect(order).toEqual(["flush", "clear", "signOut"]);
    expect(out.synced).toBe(1);
    expect(out.discarded).toBe(0);
  });

  it("clears the queue before ending the session, so a hung signOut still leaves the device clean", async () => {
    pendingCounts = [0, 0];
    await flushThenClearAndSignOut({ callers: CALLERS });
    expect(order.indexOf("clear")).toBeLessThan(order.indexOf("signOut"));
  });

  it("does not nag when the flush drained everything", async () => {
    pendingCounts = [2, 0];
    const confirmDiscard = vi.fn(() => true);
    await flushThenClearAndSignOut({ callers: CALLERS, confirmDiscard });
    expect(confirmDiscard).not.toHaveBeenCalled();
  });

  it("asks about what is LEFT after the flush, not what was there before it", async () => {
    pendingCounts = [5, 2];
    const confirmDiscard = vi.fn(() => true);
    const out = await flushThenClearAndSignOut({ callers: CALLERS, confirmDiscard });
    expect(confirmDiscard).toHaveBeenCalledWith(2);
    expect(out.discarded).toBe(2);
  });

  it("keeps the work and stays signed in when the tech says no", async () => {
    pendingCounts = [4, 4];
    const out = await flushThenClearAndSignOut({
      callers: CALLERS,
      confirmDiscard: () => false,
    });
    expect(out.signedOut).toBe(false);
    expect(out.discarded).toBe(0);
    expect(clearQueueForUser).not.toHaveBeenCalled();
    // Saying "stay signed in" and being signed out anyway is the worst of both.
    expect(listeners.signOutAndClearDevice).not.toHaveBeenCalled();
  });

  it("refuses rather than destroys when there is nobody to ask", async () => {
    // The default for "I can't get consent" has to be "don't destroy it" — the
    // tech is the only person who can redo the work.
    pendingCounts = [1, 1];
    const out = await flushThenClearAndSignOut({ callers: CALLERS });
    expect(out.signedOut).toBe(false);
    expect(clearQueueForUser).not.toHaveBeenCalled();
  });
});

describe("sign-out and walk report drafts (#610)", () => {
  it("clears every draft on the device before ending the session", async () => {
    pendingCounts = [0, 0];
    const out = await flushThenClearAndSignOut({ callers: CALLERS });
    expect(out.signedOut).toBe(true);
    expect(clearAllWalkDrafts).toHaveBeenCalledTimes(1);
  });

  it("clears drafts on a device that cannot say who is signed in", async () => {
    owner = null;
    await flushThenClearAndSignOut({ callers: CALLERS });
    expect(clearAllWalkDrafts).toHaveBeenCalledTimes(1);
  });

  it("keeps drafts when the tech chose to stay signed in", async () => {
    pendingCounts = [4, 4];
    await flushThenClearAndSignOut({ callers: CALLERS, confirmDiscard: () => false });
    expect(clearAllWalkDrafts).not.toHaveBeenCalled();
  });

  it("still signs out when the draft store cannot be cleared", async () => {
    pendingCounts = [0, 0];
    clearAllWalkDrafts.mockRejectedValueOnce(new Error("no IndexedDB"));
    const out = await flushThenClearAndSignOut({ callers: CALLERS });
    expect(out.signedOut).toBe(true);
    expect(listeners.signOutAndClearDevice).toHaveBeenCalled();
  });
});

describe("sign-out with no network", () => {
  it("does not attempt a flush it cannot complete", async () => {
    setOnline(false);
    pendingCounts = [3, 3];
    const out = await flushThenClearAndSignOut({
      callers: CALLERS,
      confirmDiscard: () => true,
    });
    expect(syncQueue).not.toHaveBeenCalled();
    expect(out.flushSkipped).toBe(true);
    expect(out.discarded).toBe(3);
    expect(out.signedOut).toBe(true);
  });

  it("still asks first — offline is not consent", async () => {
    setOnline(false);
    pendingCounts = [3, 3];
    const out = await flushThenClearAndSignOut({
      callers: CALLERS,
      confirmDiscard: () => false,
    });
    expect(out.signedOut).toBe(false);
    expect(clearQueueForUser).not.toHaveBeenCalled();
  });
});

describe("sign-out on a device that cannot say who is leaving", () => {
  it("signs out anyway instead of stranding them", async () => {
    // resolveOfflineUserId throws when there is no session and nothing
    // remembered. That is right when it guards a WRITE — unattributable work
    // should be refused — and wrong here: a device with no identity has no
    // queue to protect, and refusing to sign out would trap someone on a
    // tablet they cannot hand over.
    owner = null;
    const out = await flushThenClearAndSignOut({ callers: CALLERS });
    expect(out.signedOut).toBe(true);
    expect(listeners.signOutAndClearDevice).toHaveBeenCalled();
    expect(clearQueueForUser).not.toHaveBeenCalled();
  });
});
