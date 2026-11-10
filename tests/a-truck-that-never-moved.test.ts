// A truck that never moved.
//
// The office heard a stop would be late on two triggers: a GPS ping while the
// tech shared their location, and the tech finishing the stop before it. A
// tech stuck at one long stop with sharing off sent neither, so the next
// customer's window passed in silence. The third trigger is a clock: the
// `late-check` cron job, every five minutes, through
// /api/public/hooks/late-check to checkStuckTrucks. This drives it against an
// in-memory database and a recording push sender, through the real
// notifyUsers / notifyRoles, and asserts the rules that keep it from being
// noise: one push per slip whichever trigger saw it first, nothing outside the
// working day, nothing to a muted office, nothing about a tech who is off.
//
// And the second half of the same change: four ways a tech's today or
// tomorrow changed without anybody telling the tech (the nightly generation,
// a customer in the portal, the office completing a stop, the tech's own
// close-out), each now wrapped the way the dispatcher's paths are.
//
// Then the migration, read and, where a database is reachable, proved
// (tests/sql/a-truck-that-never-moved.proof.sql).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// A proof waits its turn for the shared lock (the-proofs-take-turns.test.ts).
vi.setConfig({ testTimeout: 300_000 });

// ── An in-memory database, as much of PostgREST as these paths use ─────────

type Row = Record<string, any>;
const h = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  pushed: [] as Array<{ userId: string; payload: any }>,
  seq: 0,
  reads: 0,
}));

vi.mock("@/lib/push.server", () => ({
  sendPushToUser: async (userId: string, payload: any) => {
    h.pushed.push({ userId, payload });
    return { sent: 1, failed: 0 };
  },
}));

vi.mock("@/integrations/supabase/client.server", () => {
  class Query {
    private filters: Array<(r: Row) => boolean> = [];
    private op: "select" | "insert" | "upsert" | "update" = "select";
    private payload: any;
    private opts: any;
    private returning = false;
    private head = false;
    private one: "maybe" | "single" | null = null;
    private sort: { col: string; asc: boolean } | null = null;
    private max: number | null = null;
    constructor(private table: string) {}
    private rows() {
      return (h.db[this.table] ??= []);
    }
    select(_cols?: string, o?: { count?: string; head?: boolean }) {
      if (this.op === "insert" || this.op === "upsert") this.returning = true;
      else this.head = !!o?.head;
      return this;
    }
    eq(c: string, v: unknown) {
      this.filters.push((r) => r[c] === v);
      return this;
    }
    neq(c: string, v: unknown) {
      this.filters.push((r) => r[c] !== v);
      return this;
    }
    not(c: string, op: string, v: unknown) {
      if (op !== "is") throw new Error(`mock: not.${op}`);
      this.filters.push((r) => (r[c] ?? null) !== v);
      return this;
    }
    in(c: string, vs: unknown[]) {
      this.filters.push((r) => vs.includes(r[c]));
      return this;
    }
    gte(c: string, v: any) {
      this.filters.push((r) => r[c] != null && r[c] >= v);
      return this;
    }
    lte(c: string, v: any) {
      this.filters.push((r) => r[c] != null && r[c] <= v);
      return this;
    }
    is(c: string, v: unknown) {
      this.filters.push((r) => (r[c] ?? null) === v);
      return this;
    }
    order(col: string, o?: { ascending?: boolean }) {
      this.sort = { col, asc: o?.ascending !== false };
      return this;
    }
    limit(n: number) {
      this.max = n;
      return this;
    }
    maybeSingle() {
      this.one = "maybe";
      return this;
    }
    single() {
      this.one = "single";
      return this;
    }
    insert(rows: Row | Row[]) {
      this.op = "insert";
      this.payload = Array.isArray(rows) ? rows : [rows];
      return this;
    }
    upsert(rows: Row | Row[], o: any) {
      this.op = "upsert";
      this.payload = Array.isArray(rows) ? rows : [rows];
      this.opts = o;
      return this;
    }
    update(patch: Row) {
      this.op = "update";
      this.payload = patch;
      return this;
    }
    private stamp(r: Row): Row {
      return { id: `row-${++h.seq}`, created_at: new Date().toISOString(), read_at: null, ...r };
    }
    private exec() {
      h.reads++;
      const all = this.rows();
      if (this.op === "insert") {
        const added = this.payload.map((r: Row) => this.stamp(r));
        all.push(...added);
        return { data: this.returning ? added : null, error: null };
      }
      if (this.op === "upsert") {
        const keys: string[] = String(this.opts?.onConflict ?? "").split(",");
        const added: Row[] = [];
        for (const r of this.payload) {
          const clash = all.find((x) => keys.every((k) => x[k] != null && x[k] === r[k]));
          if (clash) {
            if (!this.opts?.ignoreDuplicates) Object.assign(clash, r);
            continue;
          }
          const row = this.stamp(r);
          all.push(row);
          added.push(row);
        }
        return { data: this.returning ? added : null, error: null };
      }
      let found = all.filter((r) => this.filters.every((f) => f(r)));
      if (this.op === "update") {
        found.forEach((r) => Object.assign(r, this.payload));
        return { data: null, error: null };
      }
      if (this.sort) {
        const { col, asc } = this.sort;
        found = [...found].sort(
          (a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1),
        );
      }
      if (this.max != null) found = found.slice(0, this.max);
      if (this.head) return { count: found.length, data: null, error: null };
      if (this.one) return { data: found[0] ?? null, error: null };
      return { data: found, error: null };
    }
    then(res: any, rej: any) {
      return Promise.resolve(this.exec()).then(res, rej);
    }
  }
  return { supabaseAdmin: { from: (t: string) => new Query(t) } };
});

import {
  afterStopResolved,
  checkRunningLateFromPosition,
  checkStuckTrucks,
  startRouteWatch,
  LATE_CHECK_TELL_CAP,
} from "@/lib/field-notify.server";
import { resetNotifyMemoForTests } from "@/lib/notify-center.server";
import {
  earlierLateKeys,
  LATE_GIVE_UP_MIN,
  LATE_LOOKAHEAD_MIN,
  lateIsStale,
  nextStopPerTechDay,
  whereTheTruckIs,
  withinWorkingHours,
} from "@/lib/field-notify";
import { orgLocalMinutes } from "@/lib/org-day";

// ── The fixture: one Chicago org, the office, two techs ─────────────────────

const ORG = "org-1";
const TZ = "America/Chicago";
// 11:00 in Chicago on a Wednesday: inside an 08:00 to 17:00 working day.
const NOW = new Date("2026-10-07T16:00:00Z");
const TODAY = "2026-10-07";
const TOMORROW = "2026-10-08";

const U = {
  owner: "u-owner",
  manager: "u-manager",
  dispatcher: "u-dispatcher",
  taylor: "u-taylor",
  sam: "u-sam",
};
const S = { taylor: "s-taylor", sam: "s-sam" };
const OFFICE = [U.owner, U.manager, U.dispatcher];

const inMin = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

function visit(id: string, staff: string | null, day: string, seq: number, extra: Row = {}): Row {
  return {
    id,
    organization_id: ORG,
    assigned_staff_id: staff,
    scheduled_on: day,
    status: "scheduled",
    sequence: seq,
    eta_start: null,
    eta_end: null,
    travel_min: null,
    started_at: null,
    completed_at: null,
    skip_reason: null,
    skip_reason_code: null,
    property_id: `p-${id}`,
    clients: { display_name: `Client ${id}` },
    properties: {
      street: `${seq}00 Woodward Ave`,
      city: "Detroit",
      latitude: 42.33,
      longitude: -83.04,
    },
    ...extra,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  h.pushed = [];
  h.seq = 0;
  h.reads = 0;
  h.db = {
    organizations: [
      {
        id: ORG,
        timezone: TZ,
        workday_start: "08:00:00",
        workday_end: "17:00:00",
        avg_speed_kmh: 40,
        measured_speed_kmh: null,
        road_factor: 1.35,
        measured_road_factor: null,
        latitude: 42.33,
        longitude: -83.04,
      },
    ],
    user_roles: [
      { user_id: U.owner, organization_id: ORG, role: "owner" },
      { user_id: U.manager, organization_id: ORG, role: "office_manager" },
      { user_id: U.dispatcher, organization_id: ORG, role: "dispatcher" },
      { user_id: U.taylor, organization_id: ORG, role: "tech" },
      { user_id: U.sam, organization_id: ORG, role: "tech" },
    ],
    staff: [
      {
        id: S.taylor,
        organization_id: ORG,
        user_id: U.taylor,
        display_name: "Taylor",
        active: true,
        start_latitude: null,
        start_longitude: null,
      },
      {
        id: S.sam,
        organization_id: ORG,
        user_id: U.sam,
        display_name: "Sam",
        active: true,
        start_latitude: null,
        start_longitude: null,
      },
    ],
    staff_time_off: [],
    app_notification_prefs: [],
    app_notifications: [],
    visits: [],
  };
  resetNotifyMemoForTests();
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

const pushesTo = (uid: string) => h.pushed.filter((p) => p.userId === uid);
const rowsFor = (uid: string) => h.db.app_notifications.filter((r) => r.recipient_user_id === uid);
const setVisit = (id: string, patch: Row) =>
  Object.assign(
    h.db.visits.find((v) => v.id === id)!,
    patch,
  );

/** Taylor, forty minutes into a long stop, and the next customer's window
 *  closed five minutes ago with a fifteen-minute drive still to go. */
function stuckAtALongStop() {
  h.db.visits = [
    visit("v1", S.taylor, TODAY, 1, { status: "in_progress", started_at: inMin(-40) }),
    visit("v2", S.taylor, TODAY, 2, { eta_end: inMin(-5), travel_min: 15 }),
  ];
}

// ── The periodic check ─────────────────────────────────────────────────────

describe("a truck stuck at a long stop, with no GPS and no finished stop", () => {
  it("is told to the office once, as a late arrival at the next stop", async () => {
    stuckAtALongStop();
    const summary = await checkStuckTrucks();

    expect(summary).toMatchObject({
      candidates: 1,
      orgsInHours: 1,
      checked: 1,
      late: 1,
      pushed: 3,
    });
    for (const uid of OFFICE) {
      expect(pushesTo(uid), uid).toHaveLength(1);
      expect(pushesTo(uid)[0].payload).toMatchObject({
        title: "Taylor is running about 20 min late",
        url: `/my-day?date=${TODAY}&staff=${S.taylor}&visit=v2`,
        threadId: `route:${S.taylor}:${TODAY}`,
        collapseId: "late:v2",
        data: { type: "visit_late" },
      });
      expect(rowsFor(uid)[0].event_key).toBe("late:v2:0");
    }
    // The tech is not told about their own day running late.
    expect(pushesTo(U.taylor)).toEqual([]);
  });

  it("a second run five minutes later, on another server, tells nobody again", async () => {
    stuckAtALongStop();
    await checkStuckTrucks();
    resetNotifyMemoForTests();
    vi.setSystemTime(new Date(NOW.getTime() + 5 * 60_000));
    const again = await checkStuckTrucks();
    expect(again.late).toBe(1);
    expect(again.pushed).toBe(0);
    for (const uid of OFFICE) expect(pushesTo(uid), uid).toHaveLength(1);
  });

  it("fifteen more minutes of slip is a second push, replacing the first on the phone", async () => {
    stuckAtALongStop();
    await checkStuckTrucks();
    vi.setSystemTime(new Date(NOW.getTime() + 15 * 60_000));
    await checkStuckTrucks();
    for (const uid of OFFICE) {
      expect(
        pushesTo(uid).map((p) => p.payload.collapseId),
        uid,
      ).toEqual(["late:v2", "late:v2"]);
      expect(pushesTo(uid)[1].payload.title).toBe("Taylor is running about 35 min late");
      expect(rowsFor(uid).map((r) => r.event_key)).toEqual(["late:v2:0", "late:v2:1"]);
    }
  });

  it("after the GPS already told this slip, says nothing", async () => {
    stuckAtALongStop();
    // About 5.5 km north of the stop: an eleven-minute drive, so the ping
    // reads the same first slip the clock does.
    await checkRunningLateFromPosition({
      visitId: "v2",
      lat: 42.38,
      lng: -83.04,
      actorUserId: U.taylor,
    });
    for (const uid of OFFICE) expect(pushesTo(uid), uid).toHaveLength(1);
    resetNotifyMemoForTests(); // and the clock runs on another server
    const summary = await checkStuckTrucks();
    expect(summary.late).toBe(1);
    expect(summary.pushed).toBe(0);
    for (const uid of OFFICE) {
      expect(pushesTo(uid), uid).toHaveLength(1);
      expect(rowsFor(uid).map((r) => r.event_key)).toEqual(["late:v2:0"]);
    }
  });

  // Two runs at once both decide the stop is late, and both write. What makes
  // that one notification is the database: the insert is ON CONFLICT DO
  // NOTHING on (recipient, event key), and only a recipient whose row was
  // actually inserted is pushed (proved in Postgres by
  // nothing-in-the-field-told-anyone.proof.sql). So the run that loses the
  // race is a run that finds the winner's rows already there. (Not driven
  // with Promise.all: vitest hands a concurrent dynamic import of a mocked
  // module the REAL module, which is a fact about vitest, not about this.)
  it("a run that lost the race to another tells nobody", async () => {
    stuckAtALongStop();
    h.db.app_notifications = OFFICE.map((uid, i) => ({
      id: `won-${i}`,
      organization_id: ORG,
      recipient_user_id: uid,
      type: "visit_late",
      title: "Taylor is running about 20 min late",
      event_key: "late:v2:0",
      created_at: new Date().toISOString(),
    }));
    const summary = await checkStuckTrucks();
    expect(summary).toMatchObject({ late: 1, pushed: 0 });
    expect(h.pushed).toEqual([]);
    for (const uid of OFFICE) expect(rowsFor(uid), uid).toHaveLength(1);
  });
});

describe("where the drive starts", () => {
  it("is the stop last finished, when nothing is in progress and the plan has no drive", async () => {
    // Finished a stop 11 km north a minute ago; the next window closes in five.
    h.db.visits = [
      visit("v1", S.taylor, TODAY, 1, {
        status: "completed",
        completed_at: inMin(-1),
        properties: { street: "1 Far Rd", city: "Detroit", latitude: 42.44, longitude: -83.04 },
      }),
      visit("v2", S.taylor, TODAY, 2, { eta_end: inMin(5) }),
    ];
    const summary = await checkStuckTrucks();
    expect(summary.late).toBe(1);
    expect(pushesTo(U.owner)[0].payload.title).toMatch(/^Taylor is running about \d+ min late$/);
  });

  it("is where the day begins, for a route that has not started", async () => {
    h.db.staff[0].start_latitude = 42.44;
    h.db.staff[0].start_longitude = -83.04;
    h.db.visits = [visit("v1", S.taylor, TODAY, 1, { eta_end: inMin(5) })];
    expect((await checkStuckTrucks()).late).toBe(1);
    expect(pushesTo(U.owner)).toHaveLength(1);
  });
});

describe("what the clock does not tell", () => {
  it("anything outside the organization's working day", async () => {
    // 22:00 and 06:30 in Chicago.
    for (const at of ["2026-10-08T03:00:00Z", "2026-10-07T11:30:00Z"]) {
      vi.setSystemTime(new Date(at));
      // Both are still the 7th in Chicago.
      h.db.visits = [
        visit("v1", S.taylor, TODAY, 1, { status: "in_progress", started_at: inMin(-40) }),
        visit("v2", S.taylor, TODAY, 2, { eta_end: inMin(-5), travel_min: 15 }),
      ];
      const summary = await checkStuckTrucks();
      expect(summary.candidates, at).toBe(1);
      expect(summary.orgsInHours, at).toBe(0);
    }
    expect(h.pushed).toEqual([]);
    expect(h.db.app_notifications).toEqual([]);
  });

  it("an office that muted late arrivals", async () => {
    h.db.app_notification_prefs = OFFICE.map((user_id) => ({
      user_id,
      muted_types: ["visit_late"],
    }));
    stuckAtALongStop();
    const summary = await checkStuckTrucks();
    expect(summary.late).toBe(1);
    expect(summary.pushed).toBe(0);
    expect(h.pushed).toEqual([]);
    expect(h.db.app_notifications).toEqual([]);
  });

  it("a route not started whose first window is hours away, or a stop canceled or skipped", async () => {
    h.db.visits = [
      visit("v1", S.taylor, TODAY, 1, { status: "canceled", eta_end: inMin(-5), travel_min: 15 }),
      visit("v2", S.taylor, TODAY, 2, { status: "skipped", eta_end: inMin(-5), travel_min: 15 }),
      visit("v3", S.taylor, TODAY, 3, { eta_end: inMin(150), travel_min: 20 }),
      visit("v4", S.sam, TODAY, 1, { eta_end: inMin(LATE_LOOKAHEAD_MIN + 60), travel_min: 20 }),
    ];
    const summary = await checkStuckTrucks();
    expect(summary).toMatchObject({ candidates: 1, checked: 1, late: 0 });
    expect(h.pushed).toEqual([]);
  });

  it("a tech who is off today, or no longer works here", async () => {
    stuckAtALongStop();
    h.db.staff_time_off = [{ staff_id: S.taylor, starts_on: TODAY, ends_on: TOMORROW }];
    expect(await checkStuckTrucks()).toMatchObject({ off: 1, checked: 0, late: 0 });
    h.db.staff_time_off = [];
    h.db.staff[0].active = false;
    expect(await checkStuckTrucks()).toMatchObject({ off: 1, checked: 0, late: 0 });
    expect(h.pushed).toEqual([]);
  });

  it("a window that closed more than two hours ago: the office has heard it eight times", async () => {
    h.db.visits = [visit("v1", S.taylor, TODAY, 1, { eta_end: inMin(-LATE_GIVE_UP_MIN - 1) })];
    expect((await checkStuckTrucks()).candidates).toBe(0);
    expect(h.pushed).toEqual([]);
  });

  it("a stop on another calendar day", async () => {
    h.db.visits = [visit("v1", S.taylor, TOMORROW, 1, { eta_end: inMin(-5), travel_min: 15 })];
    expect((await checkStuckTrucks()).checked).toBe(0);
    expect(h.pushed).toEqual([]);
  });

  it("is bounded: an empty band costs one query", async () => {
    h.reads = 0;
    expect((await checkStuckTrucks()).candidates).toBe(0);
    expect(h.reads).toBe(1);
    expect(LATE_CHECK_TELL_CAP).toBeGreaterThan(0);
  });
});

// ── Mark all read sticks (#455) ─────────────────────────────────────────────
//
// On the Riverbend demo the owner pressed Mark all read and the lateness
// alerts came back: every 15 minutes of slip is a new event key, so a new
// unread row, and the finished-stop and GPS triggers had no give-up at all,
// so a stop whose window closed in the morning came back at the end of the
// day as "running about 400 min late".

const markAllRead = (uid: string) =>
  rowsFor(uid).forEach((r) => (r.read_at = new Date().toISOString()));

describe("lateness alerts after Mark all read (#455)", () => {
  it("a further slip on the same stop does not come back to someone who read it", async () => {
    stuckAtALongStop();
    await checkStuckTrucks();
    markAllRead(U.owner);
    vi.setSystemTime(new Date(NOW.getTime() + 15 * 60_000));
    await checkStuckTrucks();
    expect(pushesTo(U.owner)).toHaveLength(1);
    expect(rowsFor(U.owner).every((r) => r.read_at)).toBe(true);
    // The two who did not read it still hear the slip.
    for (const uid of [U.manager, U.dispatcher]) expect(pushesTo(uid), uid).toHaveLength(2);
  });

  it("still tells someone who read it about a different stop running late", async () => {
    stuckAtALongStop();
    await checkStuckTrucks();
    markAllRead(U.owner);
    h.db.visits.push(
      visit("s1", S.sam, TODAY, 1, { status: "in_progress", started_at: inMin(-40) }),
      visit("s2", S.sam, TODAY, 2, { eta_end: inMin(-5), travel_min: 15 }),
    );
    await checkStuckTrucks();
    expect(pushesTo(U.owner).map((p) => p.payload.collapseId)).toEqual(["late:v2", "late:s2"]);
  });

  it("a stop finished at the end of the day does not announce the next one hundreds of minutes late", async () => {
    // Afternoon: the next stop's window closed at 10:20, about 400 minutes ago.
    h.db.visits = [
      visit("v1", S.taylor, TODAY, 1, { status: "completed", completed_at: inMin(-1) }),
      visit("v2", S.taylor, TODAY, 2, { eta_end: inMin(-400), travel_min: 10 }),
    ];
    await afterStopResolved({ visitId: "v1", actorUserId: U.taylor });
    expect(h.pushed).toEqual([]);
    expect(h.db.app_notifications).toEqual([]);
  });

  it("nor does a GPS ping on the way to a stop whose window closed hours ago", async () => {
    h.db.visits = [visit("v2", S.taylor, TODAY, 2, { eta_end: inMin(-400) })];
    await checkRunningLateFromPosition({
      visitId: "v2",
      lat: 42.38,
      lng: -83.04,
      actorUserId: U.taylor,
    });
    expect(h.pushed).toEqual([]);
  });

  it("the rules: stale past the give-up, and only earlier steps count as read", () => {
    const now = new Date(NOW);
    expect(lateIsStale(inMin(-5), new Date(Date.now() + 15 * 60_000), now)).toBe(false);
    expect(lateIsStale(inMin(-LATE_GIVE_UP_MIN - 1), now, now)).toBe(true);
    expect(
      lateIsStale(inMin(30), new Date(Date.now() + (31 + LATE_GIVE_UP_MIN) * 60_000), now),
    ).toBe(true);
    expect(lateIsStale(null, now, now)).toBe(true);
    expect(earlierLateKeys("v2", 0)).toEqual([]);
    expect(earlierLateKeys("v2", 2)).toEqual(["late:v2:0", "late:v2:1"]);
  });
});

describe("the rules, without a database", () => {
  it("the working day runs from its start to an hour past its end, on the org's own clock", () => {
    const at = (iso: string) => orgLocalMinutes(new Date(iso), TZ);
    expect(withinWorkingHours(at("2026-10-07T12:59:00Z"), "08:00:00", "17:00:00")).toBe(false); // 07:59
    expect(withinWorkingHours(at("2026-10-07T13:00:00Z"), "08:00:00", "17:00:00")).toBe(true); // 08:00
    expect(withinWorkingHours(at("2026-10-07T23:00:00Z"), "08:00:00", "17:00:00")).toBe(true); // 18:00
    expect(withinWorkingHours(at("2026-10-07T23:01:00Z"), "08:00:00", "17:00:00")).toBe(false); // 18:01
    expect(withinWorkingHours(at("2026-10-07T23:00:00Z"), "08:00:00", "17:00:00", 0)).toBe(false);
    expect(withinWorkingHours(null, "08:00", "17:00")).toBe(false);
    // The column defaults when a value is missing.
    expect(withinWorkingHours(9 * 60, null, null)).toBe(true);
  });

  it("the next stop is the first in route order with a window, per tech and day", () => {
    const r = (id: string, staff: string, seq: number | null, status = "scheduled", end = "x") => ({
      id,
      assigned_staff_id: staff,
      scheduled_on: TODAY,
      status,
      sequence: seq,
      eta_end: end,
    });
    expect(
      nextStopPerTechDay([
        r("a", "s1", 3),
        r("b", "s1", 2),
        r("c", "s1", 1, "completed"),
        r("d", "s2", null),
        r("e", "s2", 5),
      ])
        .map((v) => v.id)
        .sort(),
    ).toEqual(["b", "e"]);
  });

  it("the truck is at the stop in progress, else the one finished last, else nowhere yet", () => {
    expect(
      whereTheTruckIs([
        { status: "completed", completed_at: "2026-10-07T15:00:00Z", id: "done" },
        { status: "in_progress", started_at: "2026-10-07T15:10:00Z", id: "here" },
      ])?.id,
    ).toBe("here");
    expect(
      whereTheTruckIs([
        { status: "completed", completed_at: "2026-10-07T14:00:00Z", id: "early" },
        { status: "completed", completed_at: "2026-10-07T15:00:00Z", id: "late" },
      ])?.id,
    ).toBe("late");
    expect(whereTheTruckIs([])).toBeNull();
  });
});

// ── The hook ───────────────────────────────────────────────────────────────

describe("/api/public/hooks/late-check", () => {
  const SERVICE = "svc-role-key-for-late-check";
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {
      CRON_SECRET: process.env.CRON_SECRET,
      SERVICE_ROLE_KEY: process.env.SERVICE_ROLE_KEY,
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    };
    delete process.env.CRON_SECRET;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.SERVICE_ROLE_KEY = SERVICE;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  async function post(headers: Record<string, string>) {
    const mod = await import("@/routes/api/public/hooks/late-check");
    const handler = (
      mod.Route as unknown as {
        options: {
          server: { handlers: { POST: (ctx: { request: Request }) => Promise<Response> } };
        };
      }
    ).options.server.handlers.POST;
    return handler({
      request: new Request("https://app.houndstack.com/api/public/hooks/late-check", {
        method: "POST",
        headers,
      }),
    });
  }

  it("refuses a caller with no credential, or the publishable key, and tells nobody", async () => {
    stuckAtALongStop();
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const headers of [{}, { apikey: "anon" }, { authorization: "Bearer anon" }]) {
      const res = await post(headers);
      expect(res.status).toBe(401);
    }
    expect(h.pushed).toEqual([]);
    expect(h.db.app_notifications).toEqual([]);
  });

  it("runs the check for the cron job's Bearer service-role key, and answers in counts only", async () => {
    stuckAtALongStop();
    const res = await post({ authorization: `Bearer ${SERVICE}` });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, candidates: 1, late: 1, pushed: 3 });
    // Nothing a person could be identified by lands in net._http_response.
    expect(JSON.stringify(body)).not.toMatch(/Taylor|Woodward|Client/);
  });
});

// ── The route changes that told nobody ─────────────────────────────────────

describe("a change to a tech's day that no dispatcher made", () => {
  it("a customer moving their visit off a tech's today is told to the tech, with nobody as the actor", async () => {
    h.db.visits = [visit("v1", S.taylor, TODAY, 1), visit("v2", S.taylor, TODAY, 2)];
    const watch = await startRouteWatch({ actorUserId: null, orgId: ORG, visitIds: ["v1"] });
    // What portal_reschedule_visit does: a new date, unassigned for the office.
    setVisit("v1", { scheduled_on: "2026-10-20", assigned_staff_id: null, sequence: null });
    const changed = await watch.finish();
    expect(changed).toEqual([{ staffId: S.taylor, day: TODAY }]);
    expect(pushesTo(U.taylor)).toHaveLength(1);
    expect(pushesTo(U.taylor)[0].payload).toMatchObject({
      title: "A stop came off today's route",
      data: { type: "route_stop_removed" },
    });
    for (const uid of OFFICE) expect(pushesTo(uid)).toEqual([]);
  });

  it("the office completing a stop on a tech's today tells the tech it came off", async () => {
    h.db.visits = [visit("v1", S.taylor, TODAY, 1), visit("v2", S.taylor, TODAY, 2)];
    const watch = await startRouteWatch({ actorUserId: U.manager, orgId: ORG, visitIds: ["v1"] });
    setVisit("v1", { status: "completed", completed_at: new Date().toISOString() });
    await watch.finish();
    expect(pushesTo(U.taylor).map((p) => p.payload.data.type)).toEqual(["route_stop_removed"]);
    expect(pushesTo(U.manager)).toEqual([]);
  });

  it("the nightly generation, outside working hours, is filed in-app and buzzes nobody", async () => {
    h.db.visits = [visit("v1", S.taylor, TOMORROW, 1)];
    const watch = await startRouteWatch({
      actorUserId: null,
      orgId: ORG,
      staffIds: [S.taylor, S.sam],
      push: false,
    });
    h.db.visits.push(visit("g1", S.taylor, TOMORROW, 2), visit("g2", S.sam, "2026-12-31", 1));
    const changed = await watch.finish();
    expect(changed).toEqual([{ staffId: S.taylor, day: TOMORROW }]);
    expect(h.pushed).toEqual([]);
    expect(rowsFor(U.taylor)).toHaveLength(1);
    expect(rowsFor(U.taylor)[0]).toMatchObject({
      type: "route_stop_added",
      title: "New stop on tomorrow's route",
      thread_id: `route:${S.taylor}:${TOMORROW}`,
    });
    // A day after tomorrow is nobody's notification.
    expect(rowsFor(U.sam)).toEqual([]);
  });

  it("pushes from the nightly run only when the organization's own clock is inside its day", () => {
    // The nightly job runs at 09:00 UTC.
    const nine = new Date("2026-10-07T09:00:00Z");
    const pushes = (tz: string) =>
      withinWorkingHours(orgLocalMinutes(nine, tz), "08:00:00", "17:00:00", 0);
    expect(pushes("America/Chicago")).toBe(false); // 04:00
    expect(pushes("America/Los_Angeles")).toBe(false); // 02:00
    expect(pushes("America/New_York")).toBe(false); // 05:00
    expect(pushes("Europe/Berlin")).toBe(true); // 11:00
  });
});

// ── Where it is wired ──────────────────────────────────────────────────────

const ROOT = join(import.meta.dirname, "..");
const src = (f: string) => readFileSync(join(ROOT, f), "utf8");

/** The body of one exported server function. */
function fn(file: string, name: string) {
  const s = src(file);
  // A module-private helper the exported handlers delegate to counts too
  // (#730: the portal's reschedule and skip share requestVisitChange).
  const at =
    [`export const ${name} =`, `async function ${name}(`]
      .map((k) => s.indexOf(k))
      .find((i) => i > -1) ?? -1;
  expect(at, `${name} in ${file}`).toBeGreaterThan(-1);
  const rest = s.slice(at + 1);
  const end = rest.indexOf("\nexport ");
  return end === -1 ? rest : rest.slice(0, end);
}

describe("every path that changes a tech's day is watched", () => {
  it.each([
    // #730: both portal changes go through one RPC, in one helper.
    ["src/lib/portal.functions.ts", "requestVisitChange", "portal_request_visit_change"],
    ["src/lib/portal.functions.ts", "portalRequestVacationHold", "portal_request_vacation_hold"],
    ["src/lib/visits.functions.ts", "completeVisitFromOffice", "office_complete_visit"],
  ])("%s %s watches before %s and finishes after it", (file, name, rpc) => {
    const body = fn(file, name);
    const start = body.indexOf("startRouteWatch(");
    const lock = body.indexOf("watchRouteLiveActivities(");
    const write = body.indexOf(`"${rpc}"`);
    const finish = body.indexOf("watch.finish(");
    const pushRoutes = body.indexOf("await pushRoutes()");
    expect(start, "startRouteWatch").toBeGreaterThan(-1);
    expect(lock, "watchRouteLiveActivities").toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(Math.max(start, lock));
    expect(finish).toBeGreaterThan(write);
    expect(pushRoutes).toBeGreaterThan(write);
  });

  it("the portal's reschedule and skip both go through the watched helper", () => {
    for (const name of ["portalRescheduleVisit", "portalRequestSkip"]) {
      expect(fn("src/lib/portal.functions.ts", name), name).toMatch(
        /return requestVisitChange\(session, data\.token, \{/,
      );
    }
  });

  it("a customer is nobody on the staff: the portal's watches name no actor and the session's org", () => {
    for (const name of ["requestVisitChange", "portalRequestVacationHold"]) {
      const body = fn("src/lib/portal.functions.ts", name);
      expect(body, name).toMatch(
        /startRouteWatch\(\{\s*actorUserId: null,\s*orgId: session\.organizationId,/,
      );
    }
  });

  it("the nightly generation and the seasonal deep-cleans are each watched, and the lock screens follow", () => {
    const s = src("src/routes/api/public/hooks/nightly.ts");
    for (const rpc of ["admin_generate_visits_through", "admin_generate_seasonal_deepcleans"]) {
      const write = s.indexOf(`"${rpc}"`);
      const before = s.lastIndexOf("await watchTheCrew(supabaseAdmin, org)", write);
      const after = s.indexOf("await watch.finish()", write);
      expect(before, `${rpc} is not watched`).toBeGreaterThan(-1);
      expect(write - before, `${rpc}: the watch is not the write's own`).toBeLessThan(600);
      expect(after, `${rpc}: never finished`).toBeGreaterThan(write);
    }
    const helper = s.slice(s.indexOf("async function watchTheCrew"));
    expect(helper).toMatch(
      /startRouteWatch\(\{ actorUserId: null, orgId: org\.id, staffIds, push \}\)/,
    );
    expect(helper).toMatch(/withinWorkingHours\(\s*orgLocalMinutes\(new Date\(\), org\.timezone/);
    expect(helper).toMatch(/refreshRouteLiveActivities\(changed\)/);
  });

  it("the tech's own close-out rebuilds their lock screen, and starts no watch that would tell the actor", () => {
    const body = fn("src/lib/my-day.functions.ts", "confirmOpenVisit");
    expect(body).toMatch(
      /refreshRouteLiveActivities\(await routeDaysForVisits\(\[data\.visitId\]\)\)/,
    );
    expect(src("src/lib/my-day.functions.ts")).not.toMatch(/startRouteWatch/);
  });
});

// ── The migration ──────────────────────────────────────────────────────────

const MIGRATION_FILE = "20261007160000_a-truck-that-never-moved.sql";
const MIGRATION = join(ROOT, "supabase/migrations", MIGRATION_FILE);
const PROOF = join(ROOT, "tests/sql/a-truck-that-never-moved.proof.sql");
const raw = readFileSync(MIGRATION, "utf8");
/** The migration with `--` comments removed, so prose cannot satisfy a check. */
const sql = raw.replace(/^\s*--.*$/gm, "").replace(/--[^\n]*/g, "");

describe("the late-check job", () => {
  it("runs every five minutes against the canonical host, only when a window is near", () => {
    const sched =
      /cron\.schedule\('late-check', '\*\/5 \* \* \* \*', \$job\$([\s\S]*?)\$job\$\)/.exec(sql);
    expect(sched, "late-check is not scheduled").not.toBeNull();
    const cmd = sched![1];
    expect(cmd).toMatch(/url := 'https:\/\/app\.houndstack\.com\/api\/public\/hooks\/late-check'/);
    expect(cmd).toMatch(
      /FROM vault\.decrypted_secrets s\s+WHERE s\.name = 'cron_service_role_key'\s+AND public\.late_check_due\(\);/,
    );
    expect(cmd).toMatch(/'Authorization', 'Bearer ' \|\| s\.decrypted_secret/);
  });

  it("opens the gate on the same band the hook reads", () => {
    const body = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.late_check_due"));
    expect(body).toMatch(new RegExp(`_at - interval '${LATE_GIVE_UP_MIN} minutes'`));
    expect(body).toMatch(new RegExp(`_at \\+ interval '${LATE_LOOKAHEAD_MIN} minutes'`));
    expect(body).toMatch(/v\.status = 'scheduled'\s+AND v\.assigned_staff_id IS NOT NULL/);
  });

  it("is reachable only by the service role, and runs as its caller", () => {
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.late_check_due\(timestamptz\) FROM PUBLIC, anon, authenticated;/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.late_check_due\(timestamptz\) TO service_role;/,
    );
    expect(sql).toMatch(/SECURITY INVOKER\s+SET search_path = public, pg_temp/);
  });

  it("only WARNS about its own cron job, which the-wiring-is-connected requires", () => {
    const cronCheck = sql.slice(sql.indexOf("DO $cron$"));
    expect(cronCheck).toMatch(/RAISE WARNING 'late-check is not scheduled/);
    expect(cronCheck).not.toMatch(/RAISE EXCEPTION/);
    const check = sql.slice(sql.indexOf("DO $check$"), sql.indexOf("DO $cron$"));
    expect(check).not.toMatch(/cron\.job/);
  });

  it("has a route that enforces the cron credential and runs the check", () => {
    const route = src("src/routes/api/public/hooks/late-check.ts");
    expect(route).toMatch(
      /const auth = authorizeCronRequest\(request\);\s+if \(!auth\.ok\) return cronUnauthorized\(/,
    );
    expect(route).toMatch(/checkStuckTrucks\(\)/);
  });
});

// ── The proof, in a real Postgres ───────────────────────────────────────────

function findPsql(): string | null {
  for (const p of [
    "psql",
    "/opt/homebrew/opt/libpq/bin/psql",
    "/opt/homebrew/opt/postgresql@18/bin/psql",
    "/opt/homebrew/opt/postgresql@17/bin/psql",
    "/usr/local/opt/libpq/bin/psql",
  ]) {
    const r = spawnSync(p, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return p;
  }
  return null;
}

const DB_URL =
  process.env.LATE_CHECK_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
const psql = findPsql();
const reachable =
  !!psql &&
  spawnSync(psql, [DB_URL, "-XAtc", "select 1"], {
    encoding: "utf8",
    timeout: 5_000,
  }).stdout?.trim() === "1";

if (!reachable) {
  console.warn(
    `\n  SKIPPED: the late-check proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set LATE_CHECK_PROOF_DB_URL to run them.\n",
  );
}

describe.skipIf(!reachable)("the late-check gate holds in a real database", () => {
  it("has the files it runs", () => {
    expect(existsSync(MIGRATION)).toBe(true);
    expect(existsSync(PROOF)).toBe(true);
  });

  it("proves every rule, and leaves nothing behind", () => {
    const r = spawnSync(psql!, [DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-f", PROOF], {
      encoding: "utf8",
      timeout: 300_000,
    });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    // Six groups of checks, each announcing itself only when it passed.
    expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(6);
    expect(out).toMatch(/ALL LATE-CHECK PROOFS PASSED/);

    const left = spawnSync(
      psql!,
      [
        DB_URL,
        "-XAtc",
        "select count(*) from public.organizations where name = 'Stuck Truck Proof'",
      ],
      { encoding: "utf8" },
    );
    expect(left.stdout.trim()).toBe("0");
  });
});
