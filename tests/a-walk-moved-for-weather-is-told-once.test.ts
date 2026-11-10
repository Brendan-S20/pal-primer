// A walk moved for weather is told once (#410).
//
// The weather move (rescheduleVisits) sent every client the weather email,
// and a dog walk's client never got the walk email an office move sends. Now
// a walk's client gets the walk email, behind the walk schedule switch, and
// not the weather one as well. Every other visit gets the weather email it
// always got. If the walks cannot be read before the move, the weather email
// still goes, so the client hears something.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The fixtures are fixed walk days in October 2026, and the date formatters
// drop the year only when it is the CURRENT year, so against the real clock
// these assertions turn red on 2027-01-01 (found by running the suite under
// faketime for #843). Pin the clock for the whole file instead of making the
// days relative to today. Only Date is faked, so promises and timers run as
// normal.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-01T12:00:00-06:00"));
});
afterEach(() => {
  vi.useRealTimers();
});

const ORG = "org-1";

const db = vi.hoisted(() => ({
  visits: [] as any[],
  organizations: [] as any[],
  blackout_dates: [] as any[],
  sent: [] as any[],
  adminDown: false,
}));

function makeClient(admin: boolean) {
  const from = (table: string) => {
    if (admin && db.adminDown) throw new Error("admin read failed");
    const filters: Array<(r: any) => boolean> = [];
    const q: any = {
      select: () => q,
      eq: (col: string, v: unknown) => (filters.push((r) => r[col] === v), q),
      in: (col: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[col])), q),
      gte: (col: string, v: string) => (filters.push((r) => r[col] >= v), q),
      lte: (col: string, v: string) => (filters.push((r) => r[col] <= v), q),
      limit: () => q,
      rows: () =>
        ((db as any)[table] ?? [])
          .filter((r: any) => filters.every((f) => f(r)))
          .map((r: any) => structuredClone(r)),
      maybeSingle: async () => ({ data: q.rows()[0] ?? null, error: null }),
      then: (res: (v: unknown) => unknown) =>
        Promise.resolve({ data: q.rows(), error: null }).then(res),
    };
    return q;
  };
  const rpc = async (name: string, args: any) => {
    if (name === "reschedule_visit") {
      const v = db.visits.find((r) => r.id === args._visit_id);
      if (v) v.scheduled_on = args._new_date;
    }
    return { data: null, error: null };
  };
  return { from, rpc };
}

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (d: unknown) => unknown = (d) => d;
    const b: any = {
      middleware: () => b,
      inputValidator: (v: (d: unknown) => unknown) => ((validate = v), b),
      handler:
        (h: (ctx: { data: unknown; context: unknown }) => unknown) =>
        (opts: { data?: unknown } = {}) =>
          h({ data: validate(opts.data), context: { supabase: makeClient(false), userId: "user-1" } }),
    };
    return b;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
// The past-day refusal (#654) is tested on its own in
// a-past-day-is-not-bookable-and-an-early-finish-is-confirmed.test.ts. Here it
// would read the stub client and date-stamp this file's fixed days.
vi.mock("@/lib/booking-dates.server", () => ({
  refusePastDay: async () => {},
  orgTodayFor: async () => "2000-01-01",
}));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: makeClient(true) }));
vi.mock("@/lib/authz.server", () => ({
  resolveCaller: async () => ({ orgId: ORG, role: "owner" }),
}));
vi.mock("@/lib/field-notify.server", () => ({
  startRouteWatch: async () => ({ finish: async () => {} }),
}));
vi.mock("@/lib/email/enqueue.server", () => ({
  enqueueAppEmail: async (p: any) => {
    db.sent.push(p);
    return { ok: true };
  },
}));

const { rescheduleVisits } = await import("@/lib/weather.functions");

const W = "11111111-1111-4111-8111-111111111111";
const P = "22222222-2222-4222-8222-222222222222";

const WALK = { service_line: "dog_walking" };
const SCOOP = { service_line: "pet_waste" };

function visit(over: Record<string, unknown>) {
  return {
    id: "v1",
    organization_id: ORG,
    client_id: "c1",
    scheduled_on: "2026-10-19",
    status: "scheduled",
    skip_reason_code: null,
    subscription_id: "s1",
    services: WALK,
    subscriptions: { earliest_time: "10:00:00", latest_time: "12:00:00", preferred_weekdays: null },
    properties: { visit_contact_email: null, dogs: [{ name: "Bella", active: true }] },
    ...over,
  };
}

const move = (visitIds: string[]) =>
  (rescheduleVisits as any)({ data: { visitIds, newDate: "2026-10-21", note: "Storms" } });

beforeEach(() => {
  db.visits = [];
  db.organizations = [{ id: ORG, work_days: [0, 1, 2, 3, 4, 5, 6] }];
  db.blackout_dates = [];
  db.sent = [];
  db.adminDown = false;
});

describe("a weather move", () => {
  it("sends a walk's client the walk email and not the weather email", async () => {
    db.visits = [
      visit({ id: W, client_id: "c1", services: WALK }),
      visit({ id: P, client_id: "c2", services: SCOOP }),
    ];
    const r = await move([W, P]);
    expect(r.moved).toBe(2);
    expect(r.notifyFailed).toBe(0);

    const toWalkClient = db.sent.filter((s) => s.clientId === "c1");
    expect(toWalkClient).toHaveLength(1);
    expect(toWalkClient[0]).toMatchObject({
      templateName: "walk-schedule-changed",
      notifyKey: "notify_email_walk_schedule_change",
    });
    expect(toWalkClient[0].idempotencyKey).toMatch(/^walk-moved-c1-weather-2026-10-21-/);
    expect(toWalkClient[0].templateData.changes).toHaveLength(1);
    expect(toWalkClient[0].templateData.changes[0].after).toMatch(/Oct 21, 10 AM to 12 PM$/);

    const toScoopClient = db.sent.filter((s) => s.clientId === "c2");
    expect(toScoopClient).toHaveLength(1);
    expect(toScoopClient[0]).toMatchObject({
      templateName: "weather-reschedule",
      notifyKey: "notify_email_weather_reschedule",
      idempotencyKey: `weather-${P}-2026-10-21`,
      templateData: { originalDate: "2026-10-19", newDate: "2026-10-21", reason: "Storms" },
    });
  });

  it("sends a cleanup's client only the weather email, as before", async () => {
    db.visits = [visit({ id: P, client_id: "c2", services: SCOOP })];
    await move([P]);
    expect(db.sent.map((s) => s.templateName)).toEqual(["weather-reschedule"]);
  });

  it("falls back to the weather email when the walks could not be read", async () => {
    db.visits = [visit({ id: W, client_id: "c1", services: WALK })];
    db.adminDown = true;
    const r = await move([W]);
    expect(r.moved).toBe(1);
    expect(db.sent.map((s) => s.templateName)).toEqual(["weather-reschedule"]);
  });
});
