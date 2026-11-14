import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// One van is one groomer. Booking refused a groom on top of another for the
// same groomer; moving one to another day or dragging it to another groomer
// did not. groom-clash.server.ts is now the one check, and every office path
// that moves or reassigns a visit runs it. Against a fake database that
// applies the filters it is given; nothing here reaches Supabase.

// The whole file runs on Chicago's clock, the org's default timezone
// (DEFAULT_ORG_TIMEZONE), so "today" means the same day to the test, to
// orgToday() and to anything that formats a local date. Set in vi.hoisted so
// it is in place before any module under test is imported, and put back after.
const PREVIOUS_TZ = vi.hoisted(() => {
  const previous = process.env.TZ;
  process.env.TZ = "America/Chicago";
  return previous;
});

type Row = Record<string, unknown>;
type Filter = [string, string, unknown, unknown?];

const state = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  selects: [] as Array<{ table: string; filters: Filter[] }>,
  rpc: vi.fn(async (..._args: unknown[]) => ({ data: null, error: null })),
}));

function matches(row: Row, [op, col, a, b]: Filter): boolean {
  const v = row[col];
  if (op === "eq") return v === a;
  if (op === "in") return (a as unknown[]).includes(v);
  if (op === "is") return v == null;
  if (op === "not") return a === "is" && b === null ? v != null : true;
  if (op === "gte") return String(v) >= String(a);
  if (op === "lte") return String(v) <= String(a);
  return true;
}

function makeDb() {
  return {
    from(table: string) {
      const filters: Filter[] = [];
      state.selects.push({ table, filters });
      const rows = () => (state.tables[table] ?? []).filter((r) => filters.every((f) => matches(r, f)));
      const chain: Record<string, unknown> = {};
      for (const op of ["eq", "in", "is", "not", "gte", "lte"])
        chain[op] = (col: string, a: unknown, b?: unknown) => {
          filters.push([op, col, a, b]);
          return chain;
        };
      for (const op of ["select", "order", "limit"]) chain[op] = () => chain;
      chain.single = async () => ({ data: rows()[0] ?? null, error: null });
      chain.maybeSingle = chain.single;
      chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve({ data: rows(), error: null }).then(res, rej);
      return chain;
    },
    rpc: (...args: unknown[]) => state.rpc(...args),
  };
}

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (d: unknown) => unknown = (d) => d;
    const builder = {
      middleware: () => builder,
      inputValidator: (fn: typeof validate) => {
        validate = fn;
        return builder;
      },
      handler:
        (fn: (a: { data: unknown; context: unknown }) => unknown) =>
        async (args?: { data: unknown }) =>
          fn({ data: validate(args?.data), context: { supabase: makeDb(), userId: "office" } }),
    };
    return builder;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/lib/authz.server", () => ({
  requirePermission: async () => ({ orgId: "org-1", role: "owner" }),
  resolveCaller: async () => ({ orgId: "org-1", role: "owner" }),
}));
vi.mock("@/lib/field-notify.server", () => ({
  startRouteWatch: async () => ({ finish: async () => {} }),
}));
vi.mock("@/lib/push-liveactivity.server", () => ({
  watchRouteLiveActivities: async () => async () => {},
  refreshRouteLiveActivities: async () => {},
  refreshOrgRouteLiveActivities: async () => {},
}));
vi.mock("@/lib/activity.server", () => ({ logActivity: async () => {} }));
vi.mock("@/lib/email/enqueue.server", () => ({ enqueueAppEmail: async () => {} }));

import {
  groomClashRefusal,
  loadGroomerBusy,
  refuseGroomMoveClash,
} from "@/lib/groom-clash.server";
import {
  bulkAssignVisits,
  bulkRescheduleVisits,
  reassignVisit,
  rescheduleVisitFromOffice,
} from "@/lib/visits.functions";
import { rescheduleVisits, undoReschedule } from "@/lib/weather.functions";

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ANA = ID(101);
const BEN = ID(102);
const MOVED = ID(1);
const OTHER = ID(2);
const SCOOP = ID(3);
const SECOND = ID(4);
const DAY = "2026-11-02";
const NEXT = "2026-11-09";

const groom = (over: Row): Row => ({
  organization_id: "org-1",
  client_id: "c",
  property_id: "p",
  status: "scheduled",
  start_time: "09:00:00",
  // 90 minutes of grooming and 30 of setup and cleanup (groom_buffer_min).
  duration_min: 120,
  groom_summary: "Full groom",
  services: { service_line: "mobile_grooming" },
  ...over,
});

// DAY and NEXT are fixed calendar days, and moving a visit onto a day that
// is already over is refused (booking-dates.ts) before the clash check runs.
// Without a pinned clock this file passed until 2026-11-09 and then failed
// on the past-day refusal instead of the clash it is about (#843). The pin
// is file-level — these hooks sit outside every describe, so they wrap every
// test in the file — and the instant is spelled in Chicago's own offset (CST,
// DST ended at 02:00 that morning) so it is noon on 2026-11-01 for the org
// whatever the machine's zone. Do not make the fixture days relative to the
// real date: a fixed day is what makes a failure reproducible. Only Date is
// faked, so promises and timers run as normal.
const PINNED_NOW = new Date("2026-11-01T12:00:00-06:00");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(PINNED_NOW);
});
afterEach(() => {
  vi.useRealTimers();
});
afterAll(() => {
  if (PREVIOUS_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = PREVIOUS_TZ;
});

beforeEach(() => {
  state.selects = [];
  state.rpc.mockClear();
  state.tables = {
    visits: [
      groom({ id: MOVED, scheduled_on: DAY, assigned_staff_id: ANA }),
      // Ben's 10:30 groom: overlaps Ana's 09:00-11:00 hold.
      groom({ id: OTHER, scheduled_on: DAY, assigned_staff_id: BEN, start_time: "10:30:00" }),
      // Ben's groom a week on at 10:00.
      groom({ id: ID(5), scheduled_on: NEXT, assigned_staff_id: BEN, start_time: "10:00:00" }),
      {
        id: SCOOP,
        organization_id: "org-1",
        scheduled_on: DAY,
        assigned_staff_id: ANA,
        status: "scheduled",
        start_time: "09:00:00",
        duration_min: 30,
        groom_summary: null,
        services: { service_line: "pet_waste" },
      },
    ],
    organizations: [{ id: "org-1", work_days: [0, 1, 2, 3, 4, 5, 6] }],
    blackout_dates: [],
  };
});

describe("groomClashRefusal, the sentence booking refuses with", () => {
  const booked = [{ start: "10:00", minutes: 60 }];

  it("is null when the hold fits beside the other grooms", () => {
    expect(groomClashRefusal(DAY, "08:00", 120, booked)).toBeNull();
    expect(groomClashRefusal(DAY, "11:00", 30, booked)).toBeNull();
  });

  it("counts setup and cleanup: a hold that ends inside the next groom clashes", () => {
    // 90 minutes of grooming fits before 10:00; the 30-minute buffer does not.
    expect(groomClashRefusal(DAY, "08:30", 90, booked)).toBeNull();
    expect(groomClashRefusal(DAY, "08:30", 120, booked)).toMatch(/already has a groom/);
  });

  it("names the day and the open start times, or says none is left", () => {
    expect(groomClashRefusal(DAY, "10:30", 60, booked)).toMatch(
      /^This groomer already has a groom at that time on 2026-11-02\. Open start times that day: .*09:00, 11:00/,
    );
    expect(groomClashRefusal(DAY, "09:00", 600, [{ start: "12:00", minutes: 60 }])).toBe(
      "This groomer already has a groom at that time on 2026-11-02, and no 600-minute opening is left that day.",
    );
  });
});

describe("loadGroomerBusy", () => {
  it("reads one groomer's held time on those days and leaves out the visits being moved", async () => {
    const busy = await loadGroomerBusy(makeDb(), {
      orgId: "org-1",
      staffId: ANA,
      dates: [DAY],
      excludeVisitIds: [MOVED],
    });
    // The scoop at 09:00 holds Ana's time; her groom being moved does not.
    expect(busy.get(DAY)).toEqual([{ start: "09:00:00", minutes: 30, summary: null }]);
  });

  it("reads the unassigned pool for no groomer, as booking always has", async () => {
    await loadGroomerBusy(makeDb(), { orgId: "org-1", staffId: null, dates: [DAY] });
    expect(state.selects.at(-1)!.filters).toContainEqual(["is", "assigned_staff_id", null, undefined]);
  });
});

describe("refuseGroomMoveClash", () => {
  it("refuses a groom dragged onto a groomer who is busy then", async () => {
    await expect(
      refuseGroomMoveClash(makeDb(), { visitIds: [MOVED], toStaffId: BEN }),
    ).rejects.toThrow("This groomer already has a groom at that time on 2026-11-02.");
  });

  it("does not clash a groom with itself", async () => {
    // Ana has nothing on the 9th, so her groom moves there. Kept on Ana, it is
    // not a move at all and is not checked against its own slot.
    await expect(
      refuseGroomMoveClash(makeDb(), { visitIds: [MOVED], toDate: NEXT }),
    ).resolves.toBeUndefined();
    await expect(
      refuseGroomMoveClash(makeDb(), { visitIds: [MOVED], toStaffId: ANA }),
    ).resolves.toBeUndefined();
  });

  it("refuses a groom moved to a day its groomer is already booked at that time", async () => {
    state.tables.visits.push(
      groom({ id: ID(6), scheduled_on: NEXT, assigned_staff_id: ANA, start_time: "10:00:00" }),
    );
    await expect(
      refuseGroomMoveClash(makeDb(), { visitIds: [MOVED], toDate: NEXT }),
    ).rejects.toThrow(/already has a groom at that time on 2026-11-09\. Open start times/);
  });

  it("leaves a visit that is not a groom alone, after one read", async () => {
    await expect(
      refuseGroomMoveClash(makeDb(), { visitIds: [SCOOP], toStaffId: BEN }),
    ).resolves.toBeUndefined();
    expect(state.selects).toHaveLength(1);
  });

  it("never refuses taking a groom off its groomer", async () => {
    state.tables.visits.push(
      groom({ id: ID(7), scheduled_on: DAY, assigned_staff_id: null, start_time: "09:30:00" }),
    );
    await expect(
      refuseGroomMoveClash(makeDb(), { visitIds: [MOVED], toStaffId: null }),
    ).resolves.toBeUndefined();
  });

  it("checks grooms moved together against each other", async () => {
    state.tables.visits.push(
      groom({ id: SECOND, scheduled_on: DAY, assigned_staff_id: BEN, start_time: "13:00:00" }),
      groom({ id: ID(8), scheduled_on: DAY, assigned_staff_id: null, start_time: "13:30:00" }),
    );
    // Ben's 13:00 stays put; the unassigned 13:30 cannot go to him.
    await expect(
      refuseGroomMoveClash(makeDb(), { visitIds: [SECOND, ID(8)], toStaffId: BEN }),
    ).rejects.toThrow(/already has a groom at that time on 2026-11-02/);
    // Two unassigned grooms at 13:00 and 13:30, both to Ana: the first lands,
    // the second clashes with it.
    state.tables.visits.find((v) => v.id === SECOND)!.assigned_staff_id = null;
    await expect(
      refuseGroomMoveClash(makeDb(), { visitIds: [SECOND, ID(8)], toStaffId: ANA }),
    ).rejects.toThrow(/already has a groom at that time on 2026-11-02/);
  });

  it("ignores a canceled groom on either side", async () => {
    state.tables.visits.find((v) => v.id === OTHER)!.status = "canceled";
    await expect(
      refuseGroomMoveClash(makeDb(), { visitIds: [MOVED], toStaffId: BEN }),
    ).resolves.toBeUndefined();
  });
});

describe("every office path that moves or reassigns runs it", () => {
  const rpcNames = () => state.rpc.mock.calls.map((c) => c[0]);

  it("reassignVisit (the board's drag between lanes) refuses before the RPC", async () => {
    await expect(reassignVisit({ data: { visitId: MOVED, staffId: BEN } })).rejects.toThrow(
      /already has a groom at that time/,
    );
    expect(rpcNames()).not.toContain("reassign_visit");
    await reassignVisit({ data: { visitId: SCOOP, staffId: BEN } });
    expect(rpcNames()).toContain("reassign_visit");
  });

  it("a save that loses the race to the database's guard gets the server's sentence", async () => {
    // The check passed (Carl is free), then another save gave Carl a 09:30
    // groom before this one wrote, and zz_visits_groom_no_overlap refused it.
    const CARL = ID(103);
    state.rpc.mockImplementationOnce(async () => {
      state.tables.visits.push(
        groom({ id: ID(7), scheduled_on: DAY, assigned_staff_id: CARL, start_time: "09:30:00" }),
      );
      return {
        data: null,
        error: { code: "23P01", message: `This groomer already has a groom at that time on ${DAY}.` },
      } as any;
    });
    await expect(reassignVisit({ data: { visitId: MOVED, staffId: CARL } })).rejects.toThrow(
      new RegExp(`already has a groom at that time on ${DAY}\\. Open start times that day: `),
    );
    // Any other database error keeps its own message.
    state.rpc.mockImplementationOnce(
      async () => ({ data: null, error: { code: "P0001", message: "staff not in org" } }) as any,
    );
    await expect(reassignVisit({ data: { visitId: SCOOP, staffId: CARL } })).rejects.toThrow(
      /^staff not in org$/,
    );
  });

  it("rescheduleVisitFromOffice refuses before the RPC", async () => {
    state.tables.visits.push(
      groom({ id: ID(6), scheduled_on: NEXT, assigned_staff_id: ANA, start_time: "10:00:00" }),
    );
    await expect(
      rescheduleVisitFromOffice({ data: { visitId: MOVED, newDate: NEXT } }),
    ).rejects.toThrow(/on 2026-11-09/);
    expect(rpcNames()).not.toContain("reschedule_visit");
    await rescheduleVisitFromOffice({ data: { visitId: MOVED, newDate: "2026-11-16" } });
    expect(rpcNames()).toContain("reschedule_visit");
  });

  it("bulkAssignVisits refuses the batch before the RPC", async () => {
    await expect(
      bulkAssignVisits({ data: { visitIds: [SCOOP, MOVED], staffId: BEN } }),
    ).rejects.toThrow(/already has a groom at that time/);
    expect(rpcNames()).not.toContain("bulk_reassign_visits");
  });

  it("bulkRescheduleVisits refuses the batch before the RPC", async () => {
    // Ben's 10:30 groom to the 9th, where he has 10:00.
    await expect(
      bulkRescheduleVisits({ data: { visitIds: [OTHER], toDate: NEXT } }),
    ).rejects.toThrow(/on 2026-11-09/);
    expect(rpcNames()).not.toContain("bulk_reschedule_visits");
  });

  it("the weather reschedule leaves a clashing groom where it was and reports it", async () => {
    const r = await rescheduleVisits({ data: { visitIds: [OTHER, SCOOP], newDate: NEXT } });
    expect(r.moved).toBe(1);
    expect(r.errors).toEqual([expect.stringMatching(/already has a groom at that time on 2026-11-09/)]);
    expect(state.rpc.mock.calls.map((c) => (c[1] as { _visit_id: string })._visit_id)).toEqual([
      SCOOP,
    ]);
  });

  it("undoing a weather reschedule is checked too", async () => {
    const r = await undoReschedule({
      data: { moves: [{ visitId: ID(5), from: DAY, to: NEXT }] },
    });
    // Ben's groom from the 9th back to the 2nd at 10:00 lands on his 10:30.
    expect(r.restored).toBe(0);
    expect(r.errors[0]).toMatch(/already has a groom at that time on 2026-11-02/);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("booking uses the same helper, and keeps its own refusal for the first date", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/groom-booking.server.ts"), "utf8");
    expect(src).toMatch(
      /import \{\s*GROOM_OVERLAP_SQLSTATE,\s*groomClashRefusal,\s*groomWriteError,\s*loadGroomerBusy,\s*\} from "@\/lib\/groom-clash\.server"/,
    );
    expect(src).toMatch(/if \(date === input\.scheduledOn\) throw new Error\(refusal\);/);
    // No second copy of the overlap rule anywhere in src/lib.
    expect(src).not.toMatch(/groomClashes\(|openGroomStarts\(/);
  });
});
