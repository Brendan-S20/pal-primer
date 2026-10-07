// Nothing in the field told anyone.
//
// The owner turned push on, a test notification arrived, and nothing else
// ever did: every notification in the product was an office event, and the
// one field event that notified (cash a tech took) did it from SQL, where a
// row can never become a push. This drives the field's events end to end --
// field-notify.server.ts through the real notifyUsers / notifyRoles -- against
// an in-memory database and a recording push sender, and asserts for each:
// who is told, the type, the thread, the collapse key and the link a tap
// opens. And the four rules that keep it from being noise: nobody hears about
// their own change, a burst is one notification, a late truck is announced
// once per slip and not once per GPS ping, and a mute is a mute.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import en from "@/lib/i18n/locales/en";
import { LANGUAGES } from "@/lib/i18n";
import { orgToday } from "@/lib/org-day";

// ── An in-memory database, as much of PostgREST as these paths use ─────────

type Row = Record<string, any>;
const h = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  pushed: [] as Array<{ userId: string; payload: any }>,
  seq: 0,
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
    in(c: string, vs: unknown[]) {
      this.filters.push((r) => vs.includes(r[c]));
      return this;
    }
    gte(c: string, v: any) {
      this.filters.push((r) => r[c] >= v);
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
  notifyAccessChanged,
  notifyFieldCollection,
  notifyVisitSkipped,
  startRouteWatch,
} from "@/lib/field-notify.server";
import { resetNotifyMemoForTests } from "@/lib/notify-center.server";
import {
  diffRoutes,
  lateStep,
  minutesLate,
  techRouteNotice,
  accessNotice,
  finishedTitle,
  tallyDay,
  myDayLink,
  type RouteRow,
} from "@/lib/field-notify";
import { techT, PUSH_LANGUAGES } from "@/lib/tech-push-i18n";

// ── The fixture: one org, an owner who also runs a route, the office, techs ─

const ORG = "org-1";
const TZ = "America/Chicago";
const TODAY = orgToday(TZ);
const TOMORROW = new Date(Date.parse(`${TODAY}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

const U = {
  owner: "u-owner",
  manager: "u-manager",
  dispatcher: "u-dispatcher",
  taylor: "u-taylor",
  sam: "u-sam",
};
const S = { owner: "s-owner", taylor: "s-taylor", sam: "s-sam" };

function home(lat: number, lng: number, street: string) {
  return { street, city: "Detroit", latitude: lat, longitude: lng };
}

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
    skip_reason: null,
    skip_reason_code: null,
    property_id: `p-${id}`,
    clients: { display_name: `Client ${id}` },
    properties: home(42.33 + seq / 100, -83.04, `${seq}00 Woodward Ave`),
    ...extra,
  };
}

beforeEach(() => {
  h.pushed = [];
  h.seq = 0;
  h.db = {
    organizations: [
      {
        id: ORG,
        timezone: TZ,
        avg_speed_kmh: 40,
        measured_speed_kmh: null,
        road_factor: 1.35,
        measured_road_factor: null,
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
      { id: S.owner, organization_id: ORG, user_id: U.owner, display_name: "Olivia", active: true },
      {
        id: S.taylor,
        organization_id: ORG,
        user_id: U.taylor,
        display_name: "Taylor",
        active: true,
      },
      { id: S.sam, organization_id: ORG, user_id: U.sam, display_name: "Sam", active: true },
    ],
    app_notification_prefs: [],
    app_notifications: [],
    visits: [],
    properties: [],
    field_collections: [],
  };
  resetNotifyMemoForTests();
});
afterEach(() => vi.clearAllMocks());

const pushesTo = (uid: string) => h.pushed.filter((p) => p.userId === uid);
const rowsFor = (uid: string) => h.db.app_notifications.filter((r) => r.recipient_user_id === uid);

/** A dispatcher's write, between the two snapshots. */
async function asDispatcher(
  scope: { visitIds?: string[]; staffIds?: string[] },
  write: () => void,
) {
  const watch = await startRouteWatch({ actorUserId: U.dispatcher, ...scope });
  write();
  await watch.finish();
}

const setVisit = (id: string, patch: Row) =>
  Object.assign(
    h.db.visits.find((v) => v.id === id)!,
    patch,
  );

// ── The tech's day ─────────────────────────────────────────────────────────

describe("a visit reassigned to a tech", () => {
  it("tells the tech it went to that a stop was added, and the tech it left that it came off", async () => {
    h.db.visits = [
      visit("v1", S.sam, TODAY, 1),
      visit("v2", S.sam, TODAY, 2),
      visit("v3", S.taylor, TODAY, 1),
    ];
    await asDispatcher({ visitIds: ["v1"] }, () =>
      setVisit("v1", { assigned_staff_id: S.taylor, sequence: 2 }),
    );

    const [toTaylor] = pushesTo(U.taylor);
    expect(pushesTo(U.taylor)).toHaveLength(1);
    expect(toTaylor.payload).toMatchObject({
      title: "New stop on today's route",
      body: "Client v1, 100 Woodward Ave, Detroit",
      url: `/my-day?date=${TODAY}&visit=v1`,
      threadId: `route:${S.taylor}:${TODAY}`,
      collapseId: "visit:v1",
      data: { type: "route_stop_added" },
    });
    expect(rowsFor(U.taylor)[0]).toMatchObject({
      type: "route_stop_added",
      thread_id: `route:${S.taylor}:${TODAY}`,
      link: `/my-day?date=${TODAY}&visit=v1`,
    });

    const [toSam] = pushesTo(U.sam);
    expect(pushesTo(U.sam)).toHaveLength(1);
    expect(toSam.payload).toMatchObject({
      title: "A stop came off today's route",
      url: `/my-day?date=${TODAY}`,
      threadId: `route:${S.sam}:${TODAY}`,
      // The same key its "added" had, so it replaces that on the phone.
      collapseId: "visit:v1",
      data: { type: "route_stop_removed" },
    });
    // The office is not told about its own dispatching.
    expect(pushesTo(U.dispatcher)).toEqual([]);
    expect(pushesTo(U.owner)).toEqual([]);
  });

  it("speaks the tech's language: Spanish, Arabic, Chinese", async () => {
    h.db.app_notification_prefs = [
      { user_id: U.taylor, muted_types: [], language: "es" },
      { user_id: U.sam, muted_types: [], language: "ar" },
    ];
    h.db.visits = [visit("v1", S.sam, TOMORROW, 1)];
    await asDispatcher({ visitIds: ["v1"] }, () => setVisit("v1", { assigned_staff_id: S.taylor }));
    expect(pushesTo(U.taylor)[0].payload.title).toBe("Nueva parada en la ruta de mañana");
    expect(pushesTo(U.sam)[0].payload.title).toBe("أُزيلت زيارة من مسار الغد");
  });

  it("says nothing about a day after tomorrow", async () => {
    const later = new Date(Date.parse(`${TODAY}T00:00:00Z`) + 3 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    h.db.visits = [visit("v1", S.sam, later, 1)];
    await asDispatcher({ visitIds: ["v1"] }, () => setVisit("v1", { assigned_staff_id: S.taylor }));
    expect(h.pushed).toEqual([]);
    expect(h.db.app_notifications).toEqual([]);
  });

  it("tells the tech when a stop is moved off today to another date", async () => {
    h.db.visits = [visit("v1", S.taylor, TODAY, 1)];
    await asDispatcher({ visitIds: ["v1"] }, () => setVisit("v1", { scheduled_on: "2099-01-01" }));
    expect(pushesTo(U.taylor).map((p) => p.payload.data.type)).toEqual(["route_stop_removed"]);
  });
});

describe("a tech's own change", () => {
  it("is never told back to them", async () => {
    h.db.visits = [visit("v1", S.taylor, TODAY, 1), visit("v2", S.taylor, TODAY, 2)];
    const watch = await startRouteWatch({ actorUserId: U.taylor, staffIds: [S.taylor] });
    setVisit("v1", { sequence: 2 });
    setVisit("v2", { sequence: 1 });
    await watch.finish();
    expect(h.pushed).toEqual([]);
    expect(h.db.app_notifications).toEqual([]);
  });

  it("an owner who runs a route and skips their own stop is not told they skipped it", async () => {
    h.db.visits = [
      visit("v1", S.owner, TODAY, 1, {
        status: "skipped",
        skip_reason: "Locked",
        skip_reason_code: "gate_locked",
      }),
      visit("v2", S.owner, TODAY, 2),
    ];
    await notifyVisitSkipped({ visitId: "v1", actorUserId: U.owner });
    expect(pushesTo(U.owner)).toEqual([]);
    expect(pushesTo(U.manager)).toHaveLength(1);
  });
});

describe("a dispatcher reordering ten stops", () => {
  it("is one summary, updated in place, not one push per drag", async () => {
    h.db.visits = Array.from({ length: 10 }, (_, i) => visit(`v${i}`, S.taylor, TODAY, i + 1));
    // Three drags inside the window.
    for (let drag = 0; drag < 3; drag++) {
      await asDispatcher({ staffIds: [S.taylor] }, () => {
        const a = h.db.visits[drag];
        const b = h.db.visits[drag + 1];
        [a.sequence, b.sequence] = [b.sequence, a.sequence];
      });
    }
    expect(pushesTo(U.taylor)).toHaveLength(1);
    expect(pushesTo(U.taylor)[0].payload).toMatchObject({
      title: "Your route for today changed",
      body: "New order · 10 stops in all",
      url: `/my-day?date=${TODAY}`,
      threadId: `route:${S.taylor}:${TODAY}`,
      collapseId: `route:${S.taylor}:${TODAY}`,
      data: { type: "route_changed" },
    });
    const rows = rowsFor(U.taylor);
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe("Changed again · 10 stops in all");
    expect(rows[0].read_at).toBeNull();
  });

  it("pushes again once the window has passed, replacing the old one on the phone", async () => {
    h.db.visits = [visit("v1", S.taylor, TODAY, 1), visit("v2", S.taylor, TODAY, 2)];
    await asDispatcher({ staffIds: [S.taylor] }, () => setVisit("v1", { sequence: 3 }));
    h.db.app_notifications[0].created_at = new Date(Date.now() - 4 * 60_000).toISOString();
    await asDispatcher({ staffIds: [S.taylor] }, () => setVisit("v1", { sequence: 0 }));
    expect(pushesTo(U.taylor).map((p) => p.payload.collapseId)).toEqual([
      `route:${S.taylor}:${TODAY}`,
      `route:${S.taylor}:${TODAY}`,
    ]);
  });

  it("bulk-assigning several stops is one summary with the counts", async () => {
    h.db.visits = [
      visit("v1", null, TODAY, 1),
      visit("v2", null, TODAY, 2),
      visit("v3", S.taylor, TODAY, 3),
    ];
    await asDispatcher({ visitIds: ["v1", "v2"] }, () => {
      setVisit("v1", { assigned_staff_id: S.taylor });
      setVisit("v2", { assigned_staff_id: S.taylor });
    });
    expect(pushesTo(U.taylor)[0].payload).toMatchObject({
      title: "Your route for today changed",
      body: "2 stops added · 3 stops in all",
      data: { type: "route_changed" },
    });
  });
});

describe("access to a stop today", () => {
  it("tells the tech going there that the gate code changed, and never what it is", async () => {
    h.db.properties = [
      {
        id: "p1",
        organization_id: ORG,
        street: "12 Elm St",
        city: "Detroit",
        clients: { display_name: "Pat" },
      },
    ];
    h.db.visits = [visit("v1", S.taylor, TODAY, 1, { property_id: "p1" })];
    await notifyAccessChanged({
      propertyId: "p1",
      before: { gate_code: "1234", do_not_enter_if_dog_out: false },
      after: { gate_code: "9876", do_not_enter_if_dog_out: true },
      actorUserId: U.manager,
    });
    const [p] = pushesTo(U.taylor);
    expect(p.payload).toMatchObject({
      title: "Access changed for a stop today",
      body: "Pat, 12 Elm St, Detroit · Gate code changed · Do-not-enter rule changed",
      url: `/my-day?date=${TODAY}&visit=v1`,
      threadId: "visit:v1",
      collapseId: "access:v1",
      data: { type: "visit_access_changed" },
    });
    expect(JSON.stringify(h.db.app_notifications)).not.toMatch(/9876|1234/);
    expect(JSON.stringify(h.pushed)).not.toMatch(/9876|1234/);
  });

  it("says nothing when nothing a tech needs at the gate changed, or nobody goes there today", async () => {
    h.db.properties = [
      { id: "p1", organization_id: ORG, street: "12 Elm St", city: "Detroit", clients: null },
    ];
    h.db.visits = [visit("v1", S.taylor, TOMORROW, 1, { property_id: "p1" })];
    await notifyAccessChanged({
      propertyId: "p1",
      before: { gate_code: "1" },
      after: { gate_code: "2" },
      actorUserId: U.manager,
    });
    await notifyAccessChanged({
      propertyId: "p1",
      before: { gate_code: "1" },
      after: { gate_code: " 1 " },
      actorUserId: U.manager,
    });
    expect(h.pushed).toEqual([]);
  });
});

// ── The office ─────────────────────────────────────────────────────────────

describe("a skipped stop", () => {
  it("tells the owner, office managers and dispatchers, with the reason, once", async () => {
    h.db.visits = [
      visit("v1", S.taylor, TODAY, 1, {
        status: "skipped",
        skip_reason: "Padlock on the side gate",
        skip_reason_code: "gate_locked",
      }),
      visit("v2", S.taylor, TODAY, 2),
    ];
    await notifyVisitSkipped({ visitId: "v1", actorUserId: U.taylor });
    resetNotifyMemoForTests(); // a replay on another server instance
    await notifyVisitSkipped({ visitId: "v1", actorUserId: U.taylor });

    for (const uid of [U.owner, U.manager, U.dispatcher]) {
      expect(pushesTo(uid), uid).toHaveLength(1);
      expect(pushesTo(uid)[0].payload).toMatchObject({
        title: "Taylor skipped Client v1",
        body: "Gate locked / no access: Padlock on the side gate. 100 Woodward Ave, Detroit",
        url: `/my-day?date=${TODAY}&staff=${S.taylor}&visit=v1`,
        threadId: `route:${S.taylor}:${TODAY}`,
        collapseId: "visit:v1",
        data: { type: "visit_skipped" },
      });
    }
    expect(pushesTo(U.taylor)).toEqual([]);
    expect(rowsFor(U.owner)[0].event_key).toBe("skip:v1");
  });

  it("respects a mute", async () => {
    h.db.app_notification_prefs = [{ user_id: U.dispatcher, muted_types: ["visit_skipped"] }];
    h.db.visits = [
      visit("v1", S.taylor, TODAY, 1, {
        status: "skipped",
        skip_reason: "x",
        skip_reason_code: "other",
      }),
      visit("v2", S.taylor, TODAY, 2),
    ];
    await notifyVisitSkipped({ visitId: "v1", actorUserId: U.taylor });
    expect(pushesTo(U.dispatcher)).toEqual([]);
    expect(rowsFor(U.dispatcher)).toEqual([]);
    expect(pushesTo(U.owner)).toHaveLength(1);
  });
});

describe("a finished route", () => {
  it("is in the notification centre only when every stop was done", async () => {
    h.db.visits = [
      visit("v1", S.taylor, TODAY, 1, { status: "completed" }),
      visit("v2", S.taylor, TODAY, 2, { status: "completed" }),
      visit("v3", S.taylor, TODAY, 3, { status: "canceled" }),
    ];
    await afterStopResolved({ visitId: "v2", actorUserId: U.taylor });
    expect(h.pushed).toEqual([]);
    expect(rowsFor(U.owner)[0]).toMatchObject({
      type: "route_finished",
      title: "Taylor finished 2 of 2",
      body: "Every stop done.",
      link: `/my-day?date=${TODAY}&staff=${S.taylor}`,
      event_key: `finished:${S.taylor}:${TODAY}:2`,
    });
  });

  it("pushes when something on it was skipped, and says what", async () => {
    h.db.visits = [
      ...Array.from({ length: 11 }, (_, i) =>
        visit(`v${i}`, S.taylor, TODAY, i + 1, { status: "completed" }),
      ),
      visit("vs", S.taylor, TODAY, 12, { status: "skipped" }),
    ];
    await afterStopResolved({ visitId: "v10", actorUserId: U.taylor });
    await afterStopResolved({ visitId: "v10", actorUserId: U.taylor });
    expect(pushesTo(U.owner)).toHaveLength(1);
    expect(pushesTo(U.owner)[0].payload).toMatchObject({
      title: "Taylor finished 12 of 12, 1 skipped",
      body: "Skipped: Client vs.",
      collapseId: `finished:${S.taylor}:${TODAY}`,
      threadId: `route:${S.taylor}:${TODAY}`,
      data: { type: "route_finished" },
    });
  });

  it("is not finished while a stop is still open", async () => {
    h.db.visits = [
      visit("v1", S.taylor, TODAY, 1, { status: "completed" }),
      visit("v2", S.taylor, TODAY, 2),
    ];
    await afterStopResolved({ visitId: "v1", actorUserId: U.taylor });
    expect(h.db.app_notifications.filter((r) => r.type === "route_finished")).toEqual([]);
  });
});

describe("a truck running late", () => {
  const inMin = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
  // About 11 km north of the stop, which at 40 km/h and a 1.35 road factor is
  // a drive of about 22 minutes.
  const PING = { lat: 42.44, lng: -83.04 };

  it("is told to the office once per stop, however many pings arrive", async () => {
    h.db.visits = [visit("v1", S.taylor, TODAY, 1, { eta_end: inMin(5) })];
    for (let i = 0; i < 5; i++) {
      await checkRunningLateFromPosition({ visitId: "v1", ...PING, actorUserId: U.taylor });
    }
    // And again from a fresh server instance: the database still says "told".
    resetNotifyMemoForTests();
    await checkRunningLateFromPosition({ visitId: "v1", ...PING, actorUserId: U.taylor });

    for (const uid of [U.owner, U.manager, U.dispatcher]) {
      expect(pushesTo(uid), uid).toHaveLength(1);
      expect(pushesTo(uid)[0].payload).toMatchObject({
        url: `/my-day?date=${TODAY}&staff=${S.taylor}&visit=v1`,
        threadId: `route:${S.taylor}:${TODAY}`,
        collapseId: "late:v1",
        data: { type: "visit_late" },
      });
      expect(pushesTo(uid)[0].payload.title).toMatch(/^Taylor is running about \d+ min late$/);
    }
    expect(rowsFor(U.owner)[0].event_key).toBe("late:v1:0");
    expect(pushesTo(U.taylor)).toEqual([]);
  });

  it("is told again only when it slips another fifteen minutes, replacing the first", async () => {
    h.db.visits = [visit("v1", S.taylor, TODAY, 1, { eta_end: inMin(5) })];
    await checkRunningLateFromPosition({ visitId: "v1", ...PING, actorUserId: U.taylor });
    setVisit("v1", { eta_end: inMin(-12) });
    await checkRunningLateFromPosition({ visitId: "v1", ...PING, actorUserId: U.taylor });
    expect(pushesTo(U.owner).map((p) => p.payload.collapseId)).toEqual(["late:v1", "late:v1"]);
    expect(rowsFor(U.owner).map((r) => r.event_key)).toEqual(["late:v1:0", "late:v1:1"]);
  });

  it("says nothing on time, or once the stop is under way", async () => {
    h.db.visits = [visit("v1", S.taylor, TODAY, 1, { eta_end: inMin(90) })];
    await checkRunningLateFromPosition({ visitId: "v1", ...PING, actorUserId: U.taylor });
    setVisit("v1", { eta_end: inMin(-60), status: "in_progress" });
    await checkRunningLateFromPosition({ visitId: "v1", ...PING, actorUserId: U.taylor });
    expect(h.pushed).toEqual([]);
  });

  it("is noticed when a stop is finished and the next one cannot be reached in its window", async () => {
    h.db.visits = [
      visit("v1", S.taylor, TODAY, 1, { status: "completed" }),
      visit("v2", S.taylor, TODAY, 2, { eta_end: inMin(10), travel_min: 35 }),
    ];
    await afterStopResolved({ visitId: "v1", actorUserId: U.taylor });
    expect(pushesTo(U.owner)).toHaveLength(1);
    expect(pushesTo(U.owner)[0].payload).toMatchObject({
      title: "Taylor is running about 25 min late",
      collapseId: "late:v2",
    });
  });

  it("respects a mute", async () => {
    h.db.app_notification_prefs = [{ user_id: U.manager, muted_types: ["visit_late"] }];
    h.db.visits = [visit("v1", S.taylor, TODAY, 1, { eta_end: inMin(5) })];
    await checkRunningLateFromPosition({ visitId: "v1", ...PING, actorUserId: U.taylor });
    expect(pushesTo(U.manager)).toEqual([]);
    expect(pushesTo(U.owner)).toHaveLength(1);
  });
});

describe("cash or a check a tech took", () => {
  it("is pushed to the owner and office managers, not dispatchers, once per collection", async () => {
    h.db.visits = [visit("v1", S.taylor, TODAY, 1)];
    h.db.field_collections = [
      {
        id: "fc1",
        organization_id: ORG,
        amount_cents: 1500,
        method: "check",
        reference: "1042",
        collected_by_staff_id: S.taylor,
        clients: { display_name: "Pat" },
        visits: { scheduled_on: TODAY },
      },
    ];
    await notifyFieldCollection({ collectionId: "fc1", actorUserId: U.taylor });
    resetNotifyMemoForTests();
    await notifyFieldCollection({ collectionId: "fc1", actorUserId: U.taylor }); // the queue's replay

    for (const uid of [U.owner, U.manager]) {
      expect(pushesTo(uid), uid).toHaveLength(1);
      expect(pushesTo(uid)[0].payload).toMatchObject({
        title: "Taylor collected $15.00 (check #1042)",
        body: "From Pat. Confirm it on Invoices to apply it to their open invoices.",
        url: "/invoices#field-collections",
        threadId: `route:${S.taylor}:${TODAY}`,
        collapseId: "collection:fc1",
        data: { type: "field_collection" },
      });
    }
    expect(pushesTo(U.dispatcher)).toEqual([]);
    expect(rowsFor(U.owner)).toHaveLength(1);
  });
});

// ── The rules, without a database ──────────────────────────────────────────

const ROOT = join(import.meta.dirname, "..");
const src = (f: string) => readFileSync(join(ROOT, f), "utf8");

describe("what changed on a day", () => {
  const r = (
    id: string,
    staff: string | null,
    day: string,
    seq: number,
    status = "scheduled",
  ): RouteRow => ({
    id,
    assigned_staff_id: staff,
    scheduled_on: day,
    status,
    sequence: seq,
  });

  it("is a removal from one tech and an addition to another when a stop moves", () => {
    const changes = diffRoutes(
      [r("a", "s1", TODAY, 1)],
      [r("a", "s2", TODAY, 1)],
      [TODAY, TOMORROW],
    );
    expect(changes.map((c) => [c.staffId, c.added.length, c.removed.length, c.reordered])).toEqual([
      ["s1", 0, 1, false],
      ["s2", 1, 0, false],
    ]);
  });

  it("is a new order when the same stops change places, and nothing when they do not", () => {
    const before = [r("a", "s1", TODAY, 1), r("b", "s1", TODAY, 2)];
    expect(
      diffRoutes(before, [r("a", "s1", TODAY, 2), r("b", "s1", TODAY, 1)], [TODAY])[0].reordered,
    ).toBe(true);
    expect(diffRoutes(before, before, [TODAY])).toEqual([]);
  });

  it("reads a stop that is no longer open as off the route, which is why only a dispatcher's writes are watched", () => {
    // A completion is not wrapped in startRouteWatch, so a tech finishing a
    // stop is never told "a stop came off today's route".
    expect(
      diffRoutes([r("a", "s1", TODAY, 1)], [r("a", "s1", TODAY, 1, "completed")], [TODAY])[0]
        .removed,
    ).toHaveLength(1);
    expect(src("src/lib/my-day.functions.ts")).not.toMatch(/startRouteWatch/);
  });

  it("finished means nothing left open", () => {
    expect(
      finishedTitle(
        "Taylor",
        tallyDay([{ status: "completed" }, { status: "skipped" }, { status: "canceled" }]),
      ),
    ).toBe("Taylor finished 2 of 2, 1 skipped");
    expect(tallyDay([{ status: "scheduled" }]).open).toBe(1);
  });

  it("is late past a ten-minute grace, in fifteen-minute steps", () => {
    const end = "2026-10-04T15:00:00Z";
    expect(minutesLate(end, new Date("2026-10-04T15:10:00Z"))).toBeNull();
    expect(minutesLate(end, new Date("2026-10-04T15:11:00Z"))).toBe(11);
    expect(minutesLate(null, new Date())).toBeNull();
    expect([11, 25, 26, 40, 41].map(lateStep)).toEqual([0, 0, 1, 1, 2]);
  });

  it("links a stop for a tech and for the office", () => {
    expect(myDayLink({ day: "2026-10-04", visitId: "v" })).toBe("/my-day?date=2026-10-04&visit=v");
    expect(myDayLink({ day: "2026-10-04", staffId: "s", visitId: "v" })).toBe(
      "/my-day?date=2026-10-04&staff=s&visit=v",
    );
  });
});

describe("a tech's push, in every language", () => {
  const change = (added: number, removed: number, reordered: boolean) => ({
    staffId: "s1",
    day: TODAY,
    added: Array.from({ length: added }, (_, i) => ({
      id: `a${i}`,
      assigned_staff_id: "s1",
      scheduled_on: TODAY,
      status: "scheduled",
      sequence: i,
      client: "Pat",
      address: "12 Elm St",
    })),
    removed: Array.from({ length: removed }, (_, i) => ({
      id: `r${i}`,
      assigned_staff_id: "s1",
      scheduled_on: TODAY,
      status: "scheduled",
      sequence: i,
      client: "Pat",
      address: "12 Elm St",
    })),
    reordered,
  });

  it("is offered in exactly the languages the app has", () => {
    expect([...PUSH_LANGUAGES]).toEqual(LANGUAGES.map((l) => l.code));
  });

  for (const lng of PUSH_LANGUAGES) {
    it(`${lng}: every shape resolves to words, with no key or placeholder left showing`, () => {
      const t = techT(lng);
      const texts: string[] = [];
      for (const kind of ["today", "tomorrow"] as const) {
        for (const [a, r, o] of [
          [1, 0, false],
          [0, 1, false],
          [0, 0, true],
          [3, 2, true],
          [2, 0, false],
          [11, 0, false],
          [0, 0, false],
        ] as const) {
          const n = techRouteNotice(t, change(a, r, o), kind, a + 7);
          texts.push(n.title, n.body);
        }
      }
      const access = accessNotice(
        t,
        { visitId: "v", day: TODAY, client: "Pat", address: "12 Elm St" },
        ["gateCode", "doNotEnter", "hazardNotes"],
      );
      texts.push(access.title, access.body);
      for (const s of texts) {
        expect(s, s).not.toMatch(/techPush\.|\{\{|\}\}/);
      }
      if (lng !== "en") {
        // Not English wearing another name: the title differs from en's.
        expect(techRouteNotice(t, change(1, 0, false), "today", 1).title).not.toBe(
          en.techPush.stopAddedToday,
        );
      }
    });
  }

  it("unknown or missing languages fall back to English", () => {
    expect(techT("fr-FR")("techPush.stopAddedToday")).toBe(en.techPush.stopAddedToday);
    expect(techT(null)("techPush.stopAddedToday")).toBe(en.techPush.stopAddedToday);
    expect(techT("es-MX")("techPush.stopAddedToday")).toBe("Nueva parada en la ruta de hoy");
  });
});

// ── Where it is wired ──────────────────────────────────────────────────────

describe("every field event is wired to its server function", () => {
  /** The body of one exported server function. */
  const fn = (file: string, name: string) => {
    const s = src(file);
    const at = s.indexOf(`export const ${name} =`);
    expect(at, `${name} in ${file}`).toBeGreaterThan(-1);
    const rest = s.slice(at + 1);
    const end = rest.indexOf("\nexport ");
    return end === -1 ? rest : rest.slice(0, end);
  };

  it.each([
    ["src/lib/visits.functions.ts", "reassignVisit"],
    ["src/lib/visits.functions.ts", "reorderRoute"],
    ["src/lib/visits.functions.ts", "bulkAssignVisits"],
    ["src/lib/visits.functions.ts", "bulkRescheduleVisits"],
    ["src/lib/visits.functions.ts", "redistributeStaffWork"],
    ["src/lib/visits.functions.ts", "rescheduleVisitFromOffice"],
    ["src/lib/visits.functions.ts", "cancelVisitFromOffice"],
    ["src/lib/visits.functions.ts", "createOneOffVisit"],
    ["src/lib/weather.functions.ts", "rescheduleVisits"],
    ["src/lib/weather.functions.ts", "undoReschedule"],
  ])("%s %s watches the routes it changes, and finishes after the write", (file, name) => {
    const body = fn(file, name);
    const start = body.indexOf("startRouteWatch(");
    const finish = body.indexOf(".finish(");
    expect(start, "startRouteWatch").toBeGreaterThan(-1);
    expect(finish, "watch.finish").toBeGreaterThan(start);
  });

  // CHANGED 2026-10-06: applyOptimize became a background run
  // (auto-routing.server.ts) whose whole write is one statement at the end.
  // The watch moved with it and now brackets that write exactly.
  it("an auto-routing run watches the routes it changes, around its one write", () => {
    const s = src("src/lib/auto-routing.server.ts");
    const body = s.slice(s.indexOf("export async function runAutoRouting"));
    const start = body.indexOf("startRouteWatch(");
    const write = body.indexOf("await applyRoutePlans(");
    const finish = body.indexOf("watch.finish(");
    expect(start, "startRouteWatch").toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(start);
    expect(finish).toBeGreaterThan(write);
  });

  it("a skip, a completion, a GPS ping, cash and a property edit each tell someone", () => {
    expect(fn("src/lib/my-day.functions.ts", "skipVisit")).toMatch(/notifyVisitSkipped\(/);
    expect(fn("src/lib/my-day.functions.ts", "completeVisit")).toMatch(/afterStopResolved\(/);
    expect(fn("src/lib/live-tracking.functions.ts", "postLiveLocation")).toMatch(
      /checkRunningLateFromPosition\(/,
    );
    expect(fn("src/lib/field-collections.functions.ts", "recordFieldCollection")).toMatch(
      /notifyFieldCollection\(/,
    );
    expect(fn("src/lib/properties.functions.ts", "updateProperty")).toMatch(
      /notifyAccessChanged\(/,
    );
  });

  it("no SQL function writes a notification a phone would never see", () => {
    // The newest definition of each function is the one that counts: walk the
    // migrations in order and keep the last body per name.
    const dir = join(ROOT, "supabase/migrations");
    const last = new Map<string, string>();
    for (const f of readdirSync(dir)
      .filter((x: string) => x.endsWith(".sql"))
      .sort()) {
      const sql = src(`supabase/migrations/${f}`);
      for (const m of sql.matchAll(
        /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?(\w+)\s*\(([\s\S]*?)\$(\w*)\$([\s\S]*?)\$\3\$/gi,
      )) {
        last.set(m[1].toLowerCase(), m[4]);
      }
    }
    const writers = [...last]
      .filter(([, body]) => /insert\s+into\s+(public\.)?app_notifications/i.test(body))
      .map(([n]) => n);
    expect(writers).toEqual([]);
    expect(last.has("record_field_collection")).toBe(true);
  });
});
