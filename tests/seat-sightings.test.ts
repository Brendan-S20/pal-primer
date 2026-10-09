// A seat is somebody who used their login this billing period (seat-rule.ts).
// The database decides who that is (tests/sql/a-seat-is-somebody-who-showed-up.proof.sql);
// this file proves the three paths that get the sighting recorded, and the
// backstop that makes the seat line right when Stripe reads it:
//
//   * getMyOrg -> noteStaffSeen: every working session, web and native;
//   * the offline queue's replay -> noteSeen: a tech counted when work lands;
//   * a first sighting in the period -> a seat reconcile, and only then;
//   * the nightly run -> every org within two days of renewal.

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
// The reconcile module imports the admin client at the top; nothing here
// reaches it except dueForSeatReconcile, which is pure.
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));

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
    const supabase = client({ stamped: true, organization_id: "org-1", needs_seat_sync: false });
    await noteStaffSeen(supabase, "user-1");
    expect(supabase.rpc).toHaveBeenCalledWith("note_staff_seen");
  });

  it("reconciles the seat line on a person's first sighting in the period", async () => {
    const { noteStaffSeen } = await import("@/lib/seat-sightings.server");
    await noteStaffSeen(
      client({ stamped: true, organization_id: "org-1", needs_seat_sync: true }),
      "user-1",
    );
    await settle();
    expect(h.sync).toHaveBeenCalledWith("org-1");
    // On the Worker's waitUntil, so the page never waits on Stripe.
    expect(h.waitUntil).toHaveBeenCalled();
  });

  it("does not ask Stripe when the count cannot have moved", async () => {
    const { noteStaffSeen } = await import("@/lib/seat-sightings.server");
    await noteStaffSeen(
      client({ stamped: true, organization_id: "org-1", needs_seat_sync: false }),
      "user-1",
    );
    await noteStaffSeen(client({ stamped: false, why: "already_today" }), "user-2");
    await settle();
    expect(h.sync).not.toHaveBeenCalled();
  });

  it("an impersonation session refused by the database reconciles nothing", async () => {
    const { noteStaffSeen } = await import("@/lib/seat-sightings.server");
    const r = await noteStaffSeen(client({ stamped: false, why: "impersonation" }), "user-1");
    await settle();
    expect(r?.stamped).toBe(false);
    expect(h.sync).not.toHaveBeenCalled();
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

  it("never throws: not on a database error, not on a Stripe failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { noteStaffSeen } = await import("@/lib/seat-sightings.server");
    await expect(noteStaffSeen(client(null, { message: "down" }), "user-1")).resolves.toBeNull();
    h.sync.mockRejectedValue(new Error("stripe down"));
    await expect(
      noteStaffSeen(
        client({ stamped: true, organization_id: "org-1", needs_seat_sync: true }),
        "user-2",
      ),
    ).resolves.toMatchObject({ stamped: true });
    await settle();
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

describe("the nightly backstop", () => {
  const NOW = new Date("2026-10-09T09:00:00Z");
  const org = (over: Record<string, unknown>) => ({
    id: "o",
    slug: "acme",
    is_comped: false,
    current_period_end: null as string | null,
    ...over,
  });

  it("reconciles every org renewing within two days, and no other", async () => {
    const { dueForSeatReconcile } = await import("@/lib/seat-reconcile.server");
    const due = dueForSeatReconcile(
      [
        org({ id: "tomorrow", current_period_end: "2026-10-10T08:00:00Z" }),
        org({ id: "in-47h", current_period_end: "2026-10-11T08:00:00Z" }),
        org({ id: "next-week", current_period_end: "2026-10-16T09:00:00Z" }),
        // Stored end already passed: the webhook has not caught up with a
        // renewal. Look, rather than trust it.
        org({ id: "stale", current_period_end: "2026-10-01T00:00:00Z" }),
        org({ id: "unknown", current_period_end: null }),
      ],
      NOW,
    ).map((o) => o.id);
    expect(due).toEqual(["tomorrow", "in-47h", "stale", "unknown"]);
  });

  it("never the demo org", async () => {
    const { dueForSeatReconcile } = await import("@/lib/seat-reconcile.server");
    expect(
      dueForSeatReconcile(
        [
          org({ id: "demo", slug: "demo", current_period_end: "2026-10-10T00:00:00Z" }),
          org({ id: "comped", is_comped: true, current_period_end: "2026-10-10T00:00:00Z" }),
        ],
        NOW,
      ),
    ).toEqual([]);
  });

  it("is wired into the nightly run", () => {
    const src = read("src/routes/api/public/hooks/nightly.ts");
    expect(src).toMatch(/reconcileSeatsBeforeRenewal\(\)/);
    expect(src).toMatch(/^\s+seats,$/m);
  });
});
