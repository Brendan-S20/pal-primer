// A seat is somebody who used their login this billing period (seat-rule.ts).
// The database decides who that is (tests/sql/a-seat-is-somebody-who-showed-up.proof.sql);
// this file proves the two paths that get the sighting recorded, and that
// recording one never talks to Stripe -- a seat period is charged after it
// closes (tests/seat-charges.test.ts):
//
//   * getMyOrg -> noteStaffSeen: every working session, web and native;
//   * the offline queue's replay -> noteSeen: a tech counted when work lands.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SyncCallers } from "@/lib/offline/sync";

const h = vi.hoisted(() => ({
  sync: vi.fn(),
  waitUntil: vi.fn(),
}));

vi.mock("@/lib/seat-sync.server", () => ({ syncOrgSeatQuantity: h.sync }));
vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => ({
    headers: { get: () => null },
    waitUntil: h.waitUntil,
  }),
}));

let pending: Array<Record<string, unknown>> = [];
vi.mock("@/lib/offline/queue", () => ({
  listPending: vi.fn(async () => pending),
  deleteAction: vi.fn(async (id: string) => {
    pending = pending.filter((a) => a.id !== id);
  }),
  recordAttempt: vi.fn(async () => 1),
  getPhoto: vi.fn(async () => undefined),
  deletePhoto: vi.fn(async () => {}),
}));

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

function client(answer: unknown, error: unknown = null) {
  return { rpc: vi.fn(async () => ({ data: answer, error })) };
}

/** Let the fire-and-forget reconcile run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  h.sync.mockReset();
  h.sync.mockResolvedValue({ synced: true, quantity: 1, changed: true });
  h.waitUntil.mockReset();
  const { __clearSightingThrottle } = await import("@/lib/seat-sightings.server");
  __clearSightingThrottle();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("noteStaffSeen", () => {
  it("asks the database with the caller's OWN client, so it can only ever stamp the caller", async () => {
    const { noteStaffSeen } = await import("@/lib/seat-sightings.server");
    const supabase = client({ stamped: false, why: "already_today" });
    await noteStaffSeen(supabase, "user-1");
    expect(supabase.rpc).toHaveBeenCalledWith("note_staff_seen");
  });

  it("asks at most once a quarter hour per session, unless forced", async () => {
    const { noteStaffSeen } = await import("@/lib/seat-sightings.server");
    const supabase = client({ stamped: false, why: "already_today" });
    await noteStaffSeen(supabase, "user-1");
    await noteStaffSeen(supabase, "user-1");
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    await noteStaffSeen(supabase, "user-1", { force: true });
    expect(supabase.rpc).toHaveBeenCalledTimes(2);
  });

  it("never throws on a database error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { noteStaffSeen } = await import("@/lib/seat-sightings.server");
    await expect(noteStaffSeen(client(null, { message: "down" }), "user-1")).resolves.toBeNull();
  });

  it("never talks to Stripe, whatever the database answers", async () => {
    const { noteStaffSeen } = await import("@/lib/seat-sightings.server");
    await noteStaffSeen(client({ stamped: true, organization_id: "org-1" }), "user-1");
    await settle();
    expect(h.sync).not.toHaveBeenCalled();
    expect(read("src/lib/seat-sightings.server.ts")).not.toMatch(
      /seat-sync|makeStripe|from "stripe"/,
    );
  });
});

describe("the throttle", () => {
  it("lets a session ask again after fifteen minutes", async () => {
    const { throttled } = await import("@/lib/seat-sightings.server");
    expect(throttled("u:s", 0)).toBe(false);
    expect(throttled("u:s", 14 * 60_000)).toBe(true);
    expect(throttled("u:s", 15 * 60_000)).toBe(false);
    // Another session of the same person is its own key: an impersonation
    // tab being refused must not suppress the person's own sighting.
    expect(throttled("u:other", 1)).toBe(false);
  });
});

describe("where it is called from", () => {
  it("getMyOrg records the sighting, in the background", () => {
    const src = read("src/lib/org.functions.ts");
    const body = src.slice(src.indexOf("export const getMyOrg"), src.indexOf("const slugSchema"));
    expect(body).toMatch(/noteStaffSeenInBackground\(supabase, userId\)/);
    // Not awaited: a sighting must never slow or fail the read every page needs.
    expect(body).not.toMatch(/await noteStaffSeen/);
  });

  it("My Day hands the offline replay a way to record it", () => {
    const src = read("src/routes/_authenticated/my-day.tsx");
    expect(src).toMatch(/noteSeen: \(\) => noteSeenFn\(\)/);
  });
});

describe("the offline replay", () => {
  function callers(noteSeen?: () => Promise<unknown>) {
    const c = {
      startVisit: vi.fn(async () => {}),
      completeVisit: vi.fn(async () => {}),
      skipVisit: vi.fn(async () => {}),
      recordVisitPhoto: vi.fn(async () => {}),
      logStationService: vi.fn(async () => {}),
      recordFieldCollection: vi.fn(async () => {}),
      clockIn: vi.fn(async () => {}),
      clockOut: vi.fn(async () => {}),
      createExpense: vi.fn(async () => {}),
      ...(noteSeen ? { noteSeen } : {}),
    };
    return c as unknown as SyncCallers;
  }
  const queuedStart = () => ({
    id: "a1",
    ts: Date.parse("2026-10-08T14:15:00Z"),
    userId: "tech-a",
    kind: "start",
    visitId: "visit-1",
  });

  it("records a sighting once work from a dead zone has landed", async () => {
    const { syncQueue } = await import("@/lib/offline/sync");
    pending = [queuedStart()];
    const noteSeen = vi.fn(async () => ({ ok: true }));
    const r = await syncQueue(callers(noteSeen), "tech-a");
    expect(r.succeeded).toBe(1);
    expect(noteSeen).toHaveBeenCalledTimes(1);
  });

  it("records nothing when nothing landed", async () => {
    const { syncQueue } = await import("@/lib/offline/sync");
    pending = [];
    const noteSeen = vi.fn(async () => ({ ok: true }));
    await syncQueue(callers(noteSeen), "tech-a");
    expect(noteSeen).not.toHaveBeenCalled();
  });

  it("a failed sighting never turns landed work into a failed sync", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { syncQueue } = await import("@/lib/offline/sync");
    pending = [queuedStart()];
    const r = await syncQueue(
      callers(async () => Promise.reject(new Error("no"))),
      "tech-a",
    );
    expect(r).toMatchObject({ succeeded: 1, failed: 0 });
  });

  it("a caller without it still syncs", async () => {
    const { syncQueue } = await import("@/lib/offline/sync");
    pending = [queuedStart()];
    const r = await syncQueue(callers(), "tech-a");
    expect(r.succeeded).toBe(1);
  });
});
