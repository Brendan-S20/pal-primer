// Two failures in the same twenty seconds of a tech's day, at the one place
// this product is hardest to use: the underground parking level of an
// apartment complex, where the waste stations are.
//
// FIRST, the tech could not log a station at all — anywhere, signal or not.
// `log_station_service` guarded on `can_write_org`, which is
// `role IN ('owner','office_manager','dispatcher')`. A `tech` is none of
// those, and `StationsSubpanel` is on the tech's own screen: RoleGuard sends
// every tech to /my-day, and the Stations button renders on any commercial or
// multi-unit property. Probed against the live database before any of this was
// written — the assigned tech got `forbidden`, that org's owner got a row id.
//
// The fix is NOT to add 'tech' to can_write_org. That function is the write
// guard for most of the schema and for the RLS policies on dozens of tables;
// widening it would hand every field tech org-wide write access to pricing and
// invoices. The guard now asks the question it actually needed answered —
// `is_visit_tech(auth.uid(), _visit_id)`, the same one start_visit and
// skip_visit ask — so a tech can log the stations on the visit they were
// dispatched to and nothing else.
//
// SECOND, station logs never reached the offline queue. Start, Complete, Skip
// and photos all go through `runOrQueue`; this went through a bare useMutation
// whose only failure path was `toast.error`. A basement garage is where the
// stations are AND where the phone has nothing, so the record most likely to
// be lost is the one that answers a commercial billing dispute.
//
// Queueing it drags in the thing sync.ts is emphatic about: `action.ts` is
// when the tech DID the work, not when signal returned. `log_station_service`
// hardcoded `serviced_at = now()`, so a log queued at 9:15am and replayed at
// 4pm would have claimed 4pm — a confident, specific, wrong answer to the exact
// question a proof-of-service record exists to settle.

import { fileURLToPath } from "node:url";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// Type-only, so it is erased at runtime and cannot throw during collection —
// the same reason every file read below is a thunk.
import type { SyncCallers } from "@/lib/offline/sync";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// LAZY. Resolved inside the `it` that needs them, never in a `describe` body:
// a throw during collection makes vitest report "no tests" rather than N
// failures, and "no tests" reads as a pass. The mutation test for this file
// stashes src/ AND supabase/ (untracked migrations included), so every one of
// these paths is briefly absent by design.
const read = (p: string) => () => readFileSync(join(ROOT, p), "utf8");
const migration = read(
  "supabase/migrations/20260809040000_the-tech-who-services-the-stations-could-not-log-them.sql",
);
const queueSrc = read("src/lib/offline/queue.ts");
const syncSrc = read("src/lib/offline/sync.ts");
const myDaySrc = read("src/routes/_authenticated/my-day.tsx");
const signOutHookSrc = read("src/hooks/useOfflineSignOut.tsx");
const stationsFnSrc = read("src/lib/stations.functions.ts");

/** Comments and JSX comment blocks stripped.
 *
 *  Every fix below is explained in a comment that names the thing it replaced,
 *  so a `not.toMatch` against raw source would fail on the explanation rather
 *  than the defect. `{/* … *\/}` is stripped too because my-day.tsx is TSX and
 *  its comments live inside the markup. */
const codeOnly = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("--"));
    })
    .join("\n");

// ── the replay, driven for real ───────────────────────────────────────────
//
// `runOne` is not exported, so it is exercised through `syncQueue` with a
// stubbed queue and fake callers. That is the point: this asserts what the
// server is ASKED for, which is the thing that was wrong, rather than that
// some string appears in the file.

type Queued = { id: string } & Record<string, unknown>;
/** What each caller is handed: `{ data: … }`, whatever the kind. */
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

function fakeCallers(stationImpl: (a: Sent) => Promise<void> = async () => {}) {
  const callers = {
    startVisit: vi.fn(async (_a: Sent) => {}),
    completeVisit: vi.fn(async (_a: Sent) => {}),
    skipVisit: vi.fn(async (_a: Sent) => {}),
    recordVisitPhoto: vi.fn(async (_a: Sent) => {}),
    logStationService: vi.fn(stationImpl),
  };
  return { callers, as: callers as unknown as SyncCallers };
}

/** 9:15 this morning — the shape of the bug, not an arbitrary number. */
const QUEUED_AT = new Date("2026-08-09T09:15:00.000Z").getTime();

const stationAction = (over: Record<string, unknown> = {}): Queued => ({
  id: "act-1",
  ts: QUEUED_AT,
  userId: "tech-a",
  kind: "station",
  visitId: "visit-1",
  wasteStationId: "station-7",
  bagsCollected: 4,
  linerReplaced: true,
  refillBagsAdded: 2,
  notes: "north kiosk overflowing",
  ...over,
});

describe("a station log queued underground replays as the log it was", () => {
  beforeEach(() => {
    pending = [];
    deleted.length = 0;
  });

  it("reaches the server at all", async () => {
    const { syncQueue } = await import("@/lib/offline/sync");
    pending = [stationAction()];
    const { callers, as } = fakeCallers();

    const res = await syncQueue(as, "tech-a");

    expect(
      callers.logStationService,
      "the station kind fell through runOne's switch — counted as synced, sent nowhere",
    ).toHaveBeenCalledTimes(1);
    expect(res.succeeded).toBe(1);
    expect(res.failed).toBe(0);
  });

  it("carries the counts the tech actually entered", async () => {
    const { syncQueue } = await import("@/lib/offline/sync");
    pending = [stationAction()];
    const { callers, as } = fakeCallers();

    await syncQueue(as, "tech-a");

    expect(callers.logStationService.mock.calls[0][0]).toMatchObject({
      data: {
        visitId: "visit-1",
        wasteStationId: "station-7",
        bagsCollected: 4,
        linerReplaced: true,
        refillBagsAdded: 2,
        notes: "north kiosk overflowing",
      },
    });
  });

  it("claims 9:15, not whenever signal came back", async () => {
    // The whole reason `_serviced_at` was added to the RPC in the same
    // migration. Without it the row says 4pm, and 4pm is what an HOA disputing
    // a month of visits would be shown.
    const { syncQueue } = await import("@/lib/offline/sync");
    pending = [stationAction()];
    const { callers, as } = fakeCallers();

    await syncQueue(as, "tech-a");

    const sent = callers.logStationService.mock.calls[0][0].data;
    expect(sent.servicedAt, "no time sent — the server would stamp the sync time").toBeDefined();
    expect(new Date(String(sent.servicedAt)).getTime()).toBe(QUEUED_AT);
  });

  it("clears itself from the queue once it lands", async () => {
    const { syncQueue } = await import("@/lib/offline/sync");
    pending = [stationAction()];

    await syncQueue(fakeCallers().as, "tech-a");

    expect(deleted).toEqual(["act-1"]);
  });

  it("stays queued when the server refuses it", async () => {
    // A refusal is not a delivery. If a failed station log were dropped, the
    // tech would be told nothing and the proof of service would be gone.
    const { syncQueue } = await import("@/lib/offline/sync");
    pending = [stationAction()];
    const { as } = fakeCallers(async () => {
      throw new Error("forbidden");
    });

    const res = await syncQueue(as, "tech-a");

    expect(res.succeeded).toBe(0);
    expect(res.failed).toBe(1);
    expect(deleted).toEqual([]);
  });

  it("does not disturb the actions that already worked", async () => {
    const { syncQueue } = await import("@/lib/offline/sync");
    pending = [
      { id: "a", ts: QUEUED_AT, userId: "tech-a", kind: "start", visitId: "visit-1" },
      stationAction({ id: "b" }),
      {
        id: "c",
        ts: QUEUED_AT + 60_000,
        userId: "tech-a",
        kind: "complete",
        visitId: "visit-1",
      },
    ];
    const { callers, as } = fakeCallers();

    const res = await syncQueue(as, "tech-a");

    expect(res.succeeded).toBe(3);
    expect(callers.startVisit).toHaveBeenCalledTimes(1);
    expect(callers.completeVisit).toHaveBeenCalledTimes(1);
    expect(callers.logStationService).toHaveBeenCalledTimes(1);
  });
});

// ── the pieces that make that replay possible ─────────────────────────────

describe("the queue can hold a station log", () => {
  it("has a kind carrying everything the RPC needs", () => {
    const src = codeOnly(queueSrc());
    expect(src).toMatch(/kind:\s*"station"/);
    for (const field of ["wasteStationId", "bagsCollected", "linerReplaced", "refillBagsAdded"]) {
      expect(src, `${field} is not carried, so the replay cannot rebuild the call`).toMatch(
        new RegExp(`${field}:`),
      );
    }
  });

  it("did not bump the IndexedDB version to add it", () => {
    // A version exists to run an `upgrade` callback and there is nothing here
    // for one to do: no new store, no new index, no keyPath change, no row that
    // becomes wrong. `openDB` blocks on other open tabs before it can upgrade,
    // so bumping would wedge the queue for a tech with My Day open on a phone
    // and a tablet in exchange for a callback that does nothing.
    expect(codeOnly(queueSrc())).toMatch(/openDB<OfflineDB>\("scoop-offline",\s*3/);
  });

  it("still drops nothing on upgrade", () => {
    // v1→v2 deliberately deleted stores because an unowned action replays as
    // the wrong person. Nothing since has had that excuse, and a new union
    // member is not a reason to destroy a tech's queued day.
    const upgrade =
      /upgrade\(db, oldVersion\)[\s\S]*?\n {6}\},/.exec(codeOnly(queueSrc()))?.[0] ?? "";
    expect(upgrade, "upgrade callback not found").not.toBe("");
    expect((upgrade.match(/deleteObjectStore/g) ?? []).length).toBe(2);
  });
});

describe("every syncQueue call site can replay every kind", () => {
  // A caller missing from one of these sets is a queued action that call site
  // cannot send. On the sign-out path that is worse than a stall: the tech is
  // asked to discard work the flush was never able to attempt.
  it("my-day passes one", () => {
    expect(codeOnly(myDaySrc())).toMatch(/logStationService:\s*\w+/);
  });

  it("the sign-out hook passes one", () => {
    expect(codeOnly(signOutHookSrc())).toMatch(/logStationService:\s*\w+/);
  });

  it("and the type makes forgetting a third one a compile error", () => {
    // Not optional. An optional caller is one `runOne` would have to guard,
    // and the guard's only honest behaviour is to fail the action anyway.
    expect(codeOnly(syncSrc())).toMatch(/logStationService:\s*\(args:/);
  });
});

describe("the panel queues instead of apologising", () => {
  const panel = () => {
    const body = codeOnly(myDaySrc());
    return /function StationsSubpanel\([\s\S]*?\n\}/.exec(body)?.[0] ?? "";
  };

  it("routes the save through runOrQueue", () => {
    const p = panel();
    expect(p, "StationsSubpanel not found").not.toBe("");
    expect(p).toMatch(/runOrQueue\(/);
    expect(p).toMatch(/enqueueAction\(/);
  });

  it("attributes the queued log to whoever pressed the button", () => {
    // Replay runs as whoever is signed in at the time. An unowned action on a
    // shared crew tablet is one the wrong tech replays and the server refuses.
    expect(panel()).toMatch(/resolveOfflineUserId\(\)/);
  });

  it("does not refetch after queueing", () => {
    // The server has no such log yet. Refetching would show the tech an empty
    // station immediately after telling them it was saved.
    expect(panel()).toMatch(/if \(!r\.queued\)/);
  });

  it("tells the tech which of the two things happened", () => {
    expect(panel()).toMatch(/r\.queued \?/);
  });
});

describe("the server function forwards the time it was given", () => {
  it("accepts an optional servicedAt and passes it to the RPC", () => {
    const src = codeOnly(stationsFnSrc());
    expect(src).toMatch(/servicedAt:\s*z\.string\(\)\.datetime\(\)\.optional\(\)/);
    expect(src).toMatch(/_serviced_at:\s*data\.servicedAt/);
  });
});

// ── the permission change itself ──────────────────────────────────────────

describe("the migration lets the assigned tech in without letting techs out", () => {
  it("adds the assigned-tech branch", () => {
    expect(codeOnly(migration())).toMatch(/is_visit_tech\(auth\.uid\(\), _visit_id\)/);
  });

  it("keeps the office branch", () => {
    // Owners, office managers and dispatchers log stations too — from the
    // office, correcting what came back from the field.
    expect(codeOnly(migration())).toMatch(/can_write_org\(auth\.uid\(\), _org\)/);
  });

  it("does not widen can_write_org", () => {
    // The regression this whole approach exists to avoid. can_write_org guards
    // pricing, invoices and subscriptions across the schema.
    const sql = codeOnly(migration());
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.can_write_org/i);
    expect(sql).not.toMatch(/ALTER .*can_write_org/i);
  });

  it("stops hardcoding serviced_at to the moment of arrival", () => {
    // Asserted against the function BODY, not the whole file: the $post$ block
    // quotes the old expression in its own failure check, and matching that
    // would pass on a migration that changed nothing.
    const body = /AS \$function\$[\s\S]*?END \$function\$;/.exec(codeOnly(migration()))?.[0] ?? "";
    expect(body, "the function body was not found").not.toBe("");
    expect(body).not.toMatch(/serviced_at = now\(\)/);
    expect(body).toMatch(/serviced_at = EXCLUDED\.serviced_at/);
    expect(codeOnly(migration())).toMatch(/_serviced_at timestamptz DEFAULT NULL/);
  });

  it("bounds the device clock rather than trusting it", () => {
    // Same window skip_visit uses for _skipped_at. A phone whose clock is two
    // years fast must not be able to date a proof-of-service record.
    const sql = codeOnly(migration());
    expect(sql).toMatch(/_serviced_at <= now\(\)/);
    expect(sql).toMatch(/_serviced_at >= now\(\) - interval '7 days'/);
  });

  it("stays idempotent, because runOrQueue does not cancel what it queues", () => {
    // A timed-out request is not a cancelled one, so a station log can land
    // twice. That is only safe while the upsert rewrites the same row.
    const sql = codeOnly(migration());
    expect(sql).toMatch(/ON CONFLICT \(visit_id, waste_station_id\) DO UPDATE/);
  });

  it("leaves exactly one function behind", () => {
    // Postgres overloads on the argument list and PostgREST resolves RPCs by
    // named arguments, so leaving the 7-argument version beside the new one
    // makes every online station log ambiguous.
    const sql = codeOnly(migration());
    expect(sql).toMatch(
      /DROP FUNCTION IF EXISTS public\.log_station_service\(uuid, uuid, integer, boolean, integer, text, text\)/,
    );
  });

  it("asserts the state it is walking into, and the state it left", () => {
    const sql = migration();
    expect(sql).toMatch(/DO \$pre\$/);
    expect(sql).toMatch(/DO \$post\$/);
  });
});
