/* eslint-disable @typescript-eslint/no-explicit-any -- an in-memory query builder */
// A repeat groom keeps what was booked on every visit, at any date, and a
// groomer's day holds one groom at a time.
//
// Until 20261016220000 the booking call stamped the length, price, summary
// and add-ons on the visits it generated itself, the first 60 days, and the
// nightly generator made every later visit with the service default and no
// add-ons. The plan now lives on the subscription and a BEFORE INSERT trigger
// on visits copies it. The fake below mirrors that trigger (stampFromPlan) and
// is checked against the migration's text, so the server half and the
// database half are tested against the same rule.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bookGroomAppointment, type BookGroomInput } from "@/lib/groom-booking.server";
import {
  groomClashes,
  groomHoldMinutes,
  groomPlanSummary,
  groomRepeatDates,
  openGroomStarts,
} from "@/lib/groom";

const sql = readFileSync(
  new URL(
    "../supabase/migrations/20261016220000_grooming-repeat-stamp-start-time.sql",
    import.meta.url,
  ),
  "utf8",
);

type Row = Record<string, any>;
const ORG = "org-1";
const CLIENT = "client-1";
const PROP = "prop-1";
const SERVICE = "svc-1";
const STAFF = "staff-1";
const ADDON = "addon-teeth";

function addDays(iso: string, days: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** What visits_groom_plan_stamp does to an inserted visit. */
function stampFromPlan(visit: Row, sub: Row): Row {
  if (sub.groom_duration_min == null) return visit;
  return {
    ...visit,
    duration_min: visit.duration_min ?? sub.groom_duration_min,
    groom_summary: visit.groom_summary ?? sub.groom_summary,
    start_time: visit.start_time ?? sub.groom_start_time,
    price_cents: visit.price_cents ?? sub.price_cents,
  };
}

function fakeDb(seed: Partial<Record<string, Row[]>> = {}) {
  const tables: Record<string, Row[]> = {
    clients: [
      { id: CLIENT, organization_id: ORG, account_type: "residential", display_name: "Ada" },
    ],
    properties: [
      { id: PROP, client_id: CLIENT, organization_id: ORG, zone_id: null, total_units: 1 },
    ],
    services: [
      {
        id: SERVICE,
        name: "Full groom",
        organization_id: ORG,
        active: true,
        service_line: "mobile_grooming",
        price_unit: "visit",
        base_price_cents: 9000,
        extra_pet_cents: 0,
        default_duration_min: 90,
      },
    ],
    dogs: [
      {
        id: "dog-1",
        name: "Biscuit",
        property_id: PROP,
        organization_id: ORG,
        weight_class: "large",
        weight_lb: null,
        coat_type: "double",
        active: true,
      },
    ],
    service_size_rules: [
      {
        service_id: SERVICE,
        organization_id: ORG,
        size: "large",
        coat_type: null,
        duration_min: 120,
        price_cents: 11000,
      },
    ],
    addon_services: [
      {
        id: ADDON,
        organization_id: ORG,
        name: "Teeth brushing",
        unit_price_cents: 1500,
        duration_min: 10,
        service_line: "mobile_grooming",
        active: true,
      },
    ],
    organizations: [
      {
        id: ORG,
        service_lines: ["mobile_grooming"],
        vaccine_rule: "warn",
        required_vaccines: ["rabies"],
        timezone: "America/Chicago",
        groom_buffer_min: 15,
      },
    ],
    pet_vaccinations: [
      {
        dog_id: "dog-1",
        organization_id: ORG,
        vaccine: "rabies",
        expires_on: "2028-01-01",
        source: "office",
        verified_at: "2026-01-01T00:00:00Z",
      },
    ],
    subscriptions: [],
    visits: [],
    activity_log: [],
    ...seed,
  };
  const rpcCalls: { fn: string; args: Row }[] = [];

  function query(table: string) {
    const filters: ((r: Row) => boolean)[] = [];
    let op: "select" | "insert" | "update" | "delete" = "select";
    let payload: Row | Row[] | null = null;
    let order: { col: string; asc: boolean } | null = null;
    let limit: number | null = null;
    const q: any = {
      select: () => q,
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
      in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), q),
      is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), q),
      not: (c: string, o: string, v: unknown) => (
        filters.push((r) => (o === "is" ? (r[c] ?? null) !== v : true)),
        q
      ),
      lt: (c: string, v: string) => (filters.push((r) => r[c] < v), q),
      order: (c: string, o?: { ascending?: boolean }) => (
        (order = { col: c, asc: o?.ascending !== false }),
        q
      ),
      limit: (n: number) => ((limit = n), q),
      insert: (p: Row | Row[]) => ((op = "insert"), (payload = p), q),
      update: (p: Row) => ((op = "update"), (payload = p), q),
      delete: () => ((op = "delete"), q),
    };
    const run = () => {
      const rows = (tables[table] ??= []);
      if (op === "insert") {
        const list = (Array.isArray(payload) ? payload : [payload]).map((p, i) => ({
          id: `${table}-${rows.length + i + 1}`,
          ...p,
        }));
        rows.push(...list);
        return { data: list, error: null };
      }
      const hit = rows.filter((r) => filters.every((f) => f(r)));
      if (op === "update") {
        hit.forEach((r) => Object.assign(r, payload));
        return { data: hit, error: null };
      }
      if (op === "delete") {
        tables[table] = rows.filter((r) => !hit.includes(r));
        return { data: hit, error: null };
      }
      let out = [...hit];
      if (order) {
        const { col, asc } = order;
        out.sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
      }
      if (limit != null) out = out.slice(0, limit);
      return { data: out, error: null };
    };
    q.maybeSingle = async () => {
      const r = run();
      return { data: r.data[0] ?? null, error: null };
    };
    q.single = async () => {
      const r = run();
      return { data: r.data[0] ?? null, error: null };
    };
    q.then = (resolve: any, reject: any) => Promise.resolve(run()).then(resolve, reject);
    return q;
  }

  /** Any generator: every interval from started_on through _through, stamped by the trigger. */
  function generate(subId: string, through: string) {
    const sub = tables.subscriptions.find((s) => s.id === subId)!;
    const step = sub.frequency === "one_time" ? 0 : sub.interval_days;
    let date = sub.started_on;
    while (date <= through) {
      if (!tables.visits.some((v) => v.subscription_id === subId && v.scheduled_on === date)) {
        tables.visits.push(
          stampFromPlan(
            {
              id: `visit-${tables.visits.length + 1}`,
              organization_id: sub.organization_id,
              subscription_id: subId,
              client_id: sub.client_id,
              property_id: sub.property_id,
              scheduled_on: date,
              status: "scheduled",
              assigned_staff_id: null,
            },
            sub,
          ),
        );
      }
      if (!step) break;
      date = addDays(date, step);
    }
  }

  const db = {
    from: (table: string) => query(table),
    rpc: async (fn: string, args: Row) => {
      rpcCalls.push({ fn, args });
      if (fn === "generate_visits_for_subscription") generate(args._subscription_id, args._through);
      if (fn === "reassign_visit") {
        const v = tables.visits.find((x) => x.id === args._visit_id);
        if (v) v.assigned_staff_id = args._staff_id;
      }
      return { data: null, error: null };
    },
  };
  return { db, tables, rpcCalls, generate };
}

const base: BookGroomInput = {
  orgId: ORG,
  actorUserId: "user-1",
  clientId: CLIENT,
  propertyId: PROP,
  serviceId: SERVICE,
  petIds: ["dog-1"],
  addons: [{ addonServiceId: ADDON, quantity: 1 }],
  scheduledOn: "2026-11-02",
  startTime: "09:00",
  everyWeeks: 6,
  staffId: STAFF,
  parkingNotes: null,
  acknowledgeWarning: false,
};

describe("a repeat groom keeps its plan past day 60", () => {
  it("stores the length, price, summary, start and add-ons on the plan", async () => {
    const { db, tables, rpcCalls } = fakeDb();
    const r = await bookGroomAppointment(db, base);
    const sub = tables.subscriptions[0];
    // 120 pet minutes + 10 add-on minutes + 15 setup and cleanup.
    expect(r.minutes).toBe(145);
    expect(sub).toMatchObject({
      interval_days: 42,
      price_cents: 11000,
      groom_duration_min: 145,
      groom_start_time: "09:00",
      groom_summary: "Full groom: Biscuit (large) + Teeth brushing",
      groom_addons: [
        { addon_service_id: ADDON, quantity: 1, unit_price_cents: 1500, name: "Teeth brushing" },
      ],
    });
    // Add-ons are charged when each groom is completed, by the database.
    expect(rpcCalls.map((c) => c.fn)).not.toContain("create_addon_charge");
  });

  it("every visit the nightly generator makes later carries the plan", async () => {
    const { db, tables, generate } = fakeDb();
    await bookGroomAppointment(db, base);
    const sub = tables.subscriptions[0];
    // The rolling generator, months later, inserting with nothing but dates.
    generate(sub.id, addDays(base.scheduledOn, 400));
    const late = tables.visits.filter((v) => v.scheduled_on > addDays(base.scheduledOn, 60));
    expect(late.length).toBeGreaterThanOrEqual(7);
    for (const v of late) {
      expect(v).toMatchObject({
        duration_min: 145,
        price_cents: 11000,
        groom_summary: "Full groom: Biscuit (large) + Teeth brushing",
        start_time: "09:00",
      });
    }
  });

  it("the booking no longer stamps visits itself; the trigger does, on every insert", () => {
    const server = readFileSync(
      new URL("../src/lib/groom-booking.server.ts", import.meta.url),
      "utf8",
    );
    expect(server).not.toMatch(/\.update\(\{\s*duration_min/);
    expect(server).toContain("groom_duration_min: holdMinutes");
    expect(sql).toMatch(/CREATE TRIGGER visits_groom_plan_stamp\s+BEFORE INSERT ON public\.visits/);
    for (const col of ["duration_min", "groom_summary", "start_time", "price_cents"])
      expect(sql).toMatch(new RegExp(`NEW\\.${col} := COALESCE\\(NEW\\.${col}, _plan\\.`));
    expect(sql).toMatch(
      /CREATE TRIGGER visits_groom_plan_addons\s+AFTER UPDATE OF status ON public\.visits[\s\S]*?WHEN \(NEW\.status = 'completed' AND OLD\.status IS DISTINCT FROM NEW\.status\)/,
    );
    // Once per visit and add-on, and the prepaid debit create_addon_charge makes.
    expect(sql).toMatch(/c\.visit_id = NEW\.id\s+AND c\.addon_service_id = _svc\.id/);
    expect(sql).toContain("'addon_debit'");
    for (const fn of [
      "tg_visits_groom_plan_stamp",
      "tg_visits_groom_plan_addons",
      "tg_pet_groom_notes_before_write",
    ])
      expect(sql).toContain(
        `REVOKE ALL ON FUNCTION public.${fn}() FROM PUBLIC, anon, authenticated;`,
      );
    expect(sql).toMatch(/groom_buffer_min smallint NOT NULL DEFAULT 15/);
    expect(sql).not.toMatch(/pg_get_functiondef/);
  });
});

describe("one groomer, one groom at a time", () => {
  const otherGroom = (date: string, start: string, minutes: number) => ({
    id: `busy-${date}-${start}`,
    organization_id: ORG,
    subscription_id: "other-sub",
    scheduled_on: date,
    status: "scheduled",
    assigned_staff_id: STAFF,
    start_time: `${start}:00`,
    duration_min: minutes,
    groom_summary: "Another groom",
  });

  it("refuses an overlapping start and names the open times left that day", async () => {
    const { db, tables } = fakeDb({ visits: [otherGroom("2026-11-02", "10:00", 120)] });
    await expect(bookGroomAppointment(db, base)).rejects.toThrow(
      /already has a groom at that time on 2026-11-02\. Open start times that day: 07:00, 07:15, 07:30, 12:00, 12:15/,
    );
    expect(tables.subscriptions).toHaveLength(0);
  });

  it("books back to back, and reports a repeat that collides", async () => {
    const later = addDays(base.scheduledOn, 42);
    const { db, tables } = fakeDb({
      visits: [otherGroom("2026-11-02", "11:25", 60), otherGroom(later, "09:30", 60)],
    });
    const r = await bookGroomAppointment(db, base);
    expect(tables.subscriptions).toHaveLength(1);
    expect(r.assignWarning).toContain(`already has a groom at that time on ${later}`);
  });

  it("a different groomer's day does not count", async () => {
    const busy = { ...otherGroom("2026-11-02", "09:00", 120), assigned_staff_id: "staff-2" };
    const { db } = fakeDb({ visits: [busy] });
    await expect(bookGroomAppointment(db, base)).resolves.toMatchObject({ startTime: "09:00" });
  });

  it("requires a start time", async () => {
    const { db } = fakeDb();
    await expect(bookGroomAppointment(db, { ...base, startTime: "" })).rejects.toThrow(
      "Pick a start time",
    );
  });

  it("holds pets, add-ons and the setup buffer, and finds openings between grooms", () => {
    expect(groomHoldMinutes(130, 15)).toBe(145);
    expect(groomHoldMinutes(130, null)).toBe(145);
    expect(groomHoldMinutes(130, 0)).toBe(130);
    const booked = [{ start: "09:00", minutes: 120 }];
    expect(groomClashes("10:59", 30, booked)).toHaveLength(1);
    expect(groomClashes("11:00", 30, booked)).toHaveLength(0);
    expect(groomClashes("08:30", 30, booked)).toHaveLength(0);
    expect(openGroomStarts(60, booked, "08:00", "13:00")).toEqual([
      "08:00",
      "11:00",
      "11:15",
      "11:30",
      "11:45",
      "12:00",
    ]);
    expect(groomRepeatDates("2026-11-02", 6, 90)).toEqual([
      "2026-11-02",
      "2026-12-14",
      "2027-01-25",
    ]);
    expect(groomRepeatDates("2026-11-02", null, 365)).toEqual(["2026-11-02"]);
    expect(
      groomPlanSummary("Bath", [{ name: "Rex", size: null }], [{ name: "Nails", quantity: 2 }]),
    ).toBe("Bath: Rex + Nails x2");
  });
});

describe("each groom's vaccines are checked on its own date", () => {
  it("warns when rabies lapses before a later repeat, naming that date", async () => {
    const { db, tables } = fakeDb({
      pet_vaccinations: [
        {
          dog_id: "dog-1",
          organization_id: ORG,
          vaccine: "rabies",
          expires_on: "2027-02-01",
          source: "office",
          verified_at: "2026-01-01T00:00:00Z",
        },
      ],
    });
    // 2026-11-02 is fine, 2026-12-14 is fine, 2027-01-25 is inside the
    // 30-day window (allowed), 2027-03-08 is past expiry.
    await expect(bookGroomAppointment(db, base)).rejects.toThrow(
      /not yet verified for the groom on 2027-03-08/,
    );
    expect(tables.subscriptions).toHaveLength(0);
    await expect(
      bookGroomAppointment(db, { ...base, acknowledgeWarning: true }),
    ).resolves.toBeTruthy();
  });

  it("an unverified portal upload warns until the office verifies it", async () => {
    const { db } = fakeDb({
      pet_vaccinations: [
        {
          dog_id: "dog-1",
          organization_id: ORG,
          vaccine: "rabies",
          expires_on: "2028-01-01",
          source: "portal",
          verified_at: null,
        },
      ],
    });
    await expect(bookGroomAppointment(db, base)).rejects.toThrow(/Confirm the vaccine warning/);
  });

  it("the block rule blocks the first groom only", async () => {
    const organizations = [
      {
        id: ORG,
        service_lines: ["mobile_grooming"],
        vaccine_rule: "block",
        required_vaccines: ["rabies"],
        timezone: "America/Chicago",
        groom_buffer_min: 15,
      },
    ];
    const lapsed = fakeDb({
      organizations,
      pet_vaccinations: [
        {
          dog_id: "dog-1",
          organization_id: ORG,
          vaccine: "rabies",
          expires_on: "2026-10-01",
          source: "office",
          verified_at: "2026-01-01T00:00:00Z",
        },
      ],
    });
    await expect(bookGroomAppointment(lapsed.db, base)).rejects.toThrow(/blocks the booking/);
    const later = fakeDb({
      organizations,
      pet_vaccinations: [
        {
          dog_id: "dog-1",
          organization_id: ORG,
          vaccine: "rabies",
          expires_on: "2027-02-01",
          source: "office",
          verified_at: "2026-01-01T00:00:00Z",
        },
      ],
    });
    await expect(bookGroomAppointment(later.db, base)).rejects.toThrow(
      /Confirm the vaccine warning/,
    );
  });
});
