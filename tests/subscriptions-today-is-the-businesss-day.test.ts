// "Today" in subscriptions.functions.ts is the BUSINESS's day, not UTC's.
//
// Three server paths used `new Date().toISOString().slice(0, 10)`, which is the
// UTC date. For an Eastern-time business that is already tomorrow from 7 PM
// (8 PM in summer) until midnight, so in the evening:
//
//   - endSubscription refused "end it today" as a date in the past, and a
//     service ended tomorrow read as ended now;
//   - updateSubscription's endsInPast canceled a service whose end date is
//     tomorrow, and trimSeriesVisits looked for closed days from tomorrow;
//   - applyFrequencyChangeRequest's future-clear (`scheduled_on > today`)
//     started from tomorrow, so it was the boundary that was off a day.
//
// Each now reads organizations.timezone through orgTodayFor
// (src/lib/booking-dates.server.ts). These run the real handlers against a
// fake Supabase at 11:30 PM in Detroit (04:30Z the next day), and again in two
// non-Eastern zones: Los Angeles (behind UTC, same direction, later) and
// Auckland (ahead of UTC, where the UTC date is YESTERDAY's).

/* eslint-disable @typescript-eslint/no-explicit-any -- a fake of the supabase-js builder and createServerFn chain */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;
type Call = {
  table: string;
  op: "select" | "update" | "delete";
  patch?: Row;
  filters: Array<[string, string, unknown]>;
};

const h = vi.hoisted(() => ({
  timezone: "America/Detroit" as string | null,
  sub: null as Row | null,
  calls: [] as Call[],
}));

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (d: unknown) => unknown = (d) => d;
    const b: any = {
      middleware: () => b,
      inputValidator: (v: (d: unknown) => unknown) => ((validate = v), b),
      handler:
        (fn: (ctx: { data: unknown; context: unknown }) => unknown) =>
        (opts: { data?: unknown; context?: unknown } = {}) =>
          fn({ data: validate(opts.data), context: opts.context ?? {} }),
    };
    return b;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/lib/authz.server", () => ({
  requirePermission: async () => ({ orgId: ORG_ID, role: "owner" }),
}));
vi.mock("@/lib/activity.server", () => ({ logActivity: async () => {} }));
vi.mock("@/lib/estimate.server", () => ({ recomputePropertyEstimate: async () => {} }));
vi.mock("@/lib/visit-generation.server", () => ({ generateVisitHorizon: async () => {} }));
vi.mock("@/lib/walk-notify.server", () => ({ notifyWalkPlanChanged: async () => {} }));

import {
  applyFrequencyChangeRequest,
  endSubscription,
  updateSubscription,
} from "@/lib/subscriptions.functions";

const ORG_ID = "00000000-0000-4000-8000-0000000000f1";
const SUB_ID = "645458a1-78fa-41ca-8a90-cf5731b4e980";
const PROPERTY_ID = "00000000-0000-4000-8000-0000000000b1";
const USER_ID = "00000000-0000-4000-8000-0000000000aa";

/** As much of supabase-js as the three handlers and orgTodayFor use. Every
 *  query is recorded with its filters; reads answer from `h`. */
function fakeSupabase() {
  return {
    from(table: string) {
      const call: Call = { table, op: "select", filters: [] };
      h.calls.push(call);
      const one = () => {
        if (table === "organizations") return { data: { timezone: h.timezone }, error: null };
        if (table === "subscriptions") return { data: h.sub, error: null };
        return { data: null, error: null };
      };
      const many = () => {
        if (call.op !== "select") return { data: null, error: null };
        if (table === "subscriptions") return { data: [{ organization_id: ORG_ID }], error: null };
        return { data: [], error: null };
      };
      const filter = (kind: string) => (col: string, val: unknown) => (
        call.filters.push([kind, col, val]),
        q
      );
      const q: any = {
        select: () => q,
        update: (p: Row) => ((call.op = "update"), (call.patch = p), q),
        delete: () => ((call.op = "delete"), q),
        eq: filter("eq"),
        gt: filter("gt"),
        gte: filter("gte"),
        in: filter("in"),
        single: async () => one(),
        maybeSingle: async () => one(),
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(many()).then(resolve, reject),
      };
      return q;
    },
  };
}

const call = (fn: any, data: Row) =>
  fn({ data, context: { supabase: fakeSupabase(), userId: USER_ID } });

const subscriptionUpdates = () =>
  h.calls.filter((c) => c.table === "subscriptions" && c.op === "update");

/** The zones and instants under test. `local` is the business's date at that
 *  instant; `utc` is what the old code computed. They differ in every case. */
const CASES = [
  {
    name: "Detroit at 11:30 PM (04:30Z the next day)",
    tz: "America/Detroit",
    now: "2026-11-13T04:30:00Z",
    local: "2026-11-12",
    utc: "2026-11-13",
  },
  {
    name: "Los Angeles at 11:30 PM (07:30Z the next day)",
    tz: "America/Los_Angeles",
    now: "2026-11-13T07:30:00Z",
    local: "2026-11-12",
    utc: "2026-11-13",
  },
  {
    name: "Auckland at 1:30 AM (12:30Z the day before)",
    tz: "Pacific/Auckland",
    now: "2026-11-12T12:30:00Z",
    local: "2026-11-13",
    utc: "2026-11-12",
  },
] as const;

const dayAfter = (d: string) => {
  const t = new Date(`${d}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
};

beforeEach(() => {
  vi.useFakeTimers();
  h.calls = [];
});
afterEach(() => vi.useRealTimers());

describe.each(CASES)("$name", ({ tz, now, local, utc }) => {
  beforeEach(() => {
    vi.setSystemTime(new Date(now));
    h.timezone = tz;
  });

  it("the clock really is on two different days here", () => {
    expect(new Date().toISOString().slice(0, 10)).toBe(utc);
    expect(local).not.toBe(utc);
  });

  describe("endSubscription", () => {
    beforeEach(() => {
      h.sub = {
        id: SUB_ID,
        organization_id: ORG_ID,
        client_id: "8af46978-56dd-49bd-aa27-5337bd54802f",
        property_id: PROPERTY_ID,
        status: "active",
        frequency: "weekly",
        started_on: local,
        ends_on: null,
      };
    });

    it("ending it today ends it on the business's today, canceled now", async () => {
      // A service that started today, ended today. Under the UTC day in
      // Detroit this read as an end before it started and was refused; in
      // Auckland it was "today" a day early.
      await call(endSubscription, {
        subscriptionId: SUB_ID,
        effectiveDate: local,
        reason: "customer_canceled",
      });
      const [u] = subscriptionUpdates();
      expect(u.patch).toMatchObject({ ends_on: local, status: "canceled" });
    });

    it("ending it tomorrow (local) leaves it active until then", async () => {
      await call(endSubscription, {
        subscriptionId: SUB_ID,
        effectiveDate: dayAfter(local),
        reason: "customer_canceled",
      });
      const [u] = subscriptionUpdates();
      expect(u.patch).toMatchObject({ ends_on: dayAfter(local), status: "active" });
    });

    it("reads the subscription's organization for the time zone", async () => {
      await call(endSubscription, {
        subscriptionId: SUB_ID,
        effectiveDate: local,
        reason: "customer_canceled",
      });
      const org = h.calls.find((c) => c.table === "organizations");
      expect(org?.filters).toContainEqual(["eq", "id", ORG_ID]);
    });
  });

  describe("updateSubscription", () => {
    const edit = (over: Row = {}) => ({
      subscriptionId: SUB_ID,
      propertyId: PROPERTY_ID,
      frequency: "weekly",
      priceCents: 3000,
      ...over,
    });

    beforeEach(() => {
      h.sub = {
        organization_id: ORG_ID,
        client_id: "8af46978-56dd-49bd-aa27-5337bd54802f",
        client_package_id: null,
        stay_id: null,
        account_type: "residential",
        dog_count: 1,
        unit_count: null,
        price_cents: 3000,
        frequency: "weekly",
        weekdays: null,
        started_on: "2026-01-01",
        ends_on: null,
        status: "active",
        service_id: null,
        earliest_time: null,
        latest_time: null,
      };
    });

    it("an end date of the business's tomorrow is not in the past", async () => {
      await call(updateSubscription, edit({ endsOn: dayAfter(local) }));
      const [u] = subscriptionUpdates();
      expect(u.patch.ends_on).toBe(dayAfter(local));
      expect(u.patch).not.toHaveProperty("status");
    });

    it("an end date of the business's today is, and cancels", async () => {
      await call(updateSubscription, edit({ endsOn: local }));
      const [u] = subscriptionUpdates();
      expect(u.patch).toMatchObject({ ends_on: local, status: "canceled" });
    });

    it("trimSeriesVisits looks for closed days from the business's today", async () => {
      await call(updateSubscription, edit({ skipClosedDays: true }));
      const blackout = h.calls.find((c) => c.table === "blackout_dates");
      const holiday = h.calls.find((c) => c.table === "holiday_dates");
      expect(blackout?.filters).toContainEqual(["gte", "blackout_on", local]);
      expect(holiday?.filters).toContainEqual(["gte", "holiday_on", local]);
    });
  });

  describe("applyFrequencyChangeRequest", () => {
    beforeEach(() => {
      h.sub = {
        organization_id: ORG_ID,
        client_id: "8af46978-56dd-49bd-aa27-5337bd54802f",
        property_id: PROPERTY_ID,
        frequency: "monthly",
        status: "active",
        price_cents: 9600,
      };
    });

    it("clears scheduled visits strictly after the business's today", async () => {
      await call(applyFrequencyChangeRequest, { subscriptionId: SUB_ID, frequency: "weekly" });
      const future = h.calls.find(
        (c) => c.table === "visits" && c.op === "select" && c.filters.some(([k]) => k === "gt"),
      );
      // `scheduled_on > local`: today's local visit is NOT in the clear set.
      expect(future?.filters).toContainEqual(["gt", "scheduled_on", local]);
      expect(future?.filters).not.toContainEqual(["gt", "scheduled_on", utc]);
    });
  });
});

describe("an organization with no time zone on file", () => {
  it("falls back to the default zone (America/Chicago), not UTC", async () => {
    vi.setSystemTime(new Date("2026-11-13T04:30:00Z")); // 10:30 PM in Chicago
    h.timezone = null;
    h.sub = {
      id: SUB_ID,
      organization_id: ORG_ID,
      client_id: "8af46978-56dd-49bd-aa27-5337bd54802f",
      property_id: PROPERTY_ID,
      status: "active",
      frequency: "weekly",
      started_on: "2026-11-12",
      ends_on: null,
    };
    // Tomorrow in Chicago, today in UTC: still active until then.
    await call(endSubscription, {
      subscriptionId: SUB_ID,
      effectiveDate: "2026-11-13",
      reason: "customer_canceled",
    });
    const [u] = subscriptionUpdates();
    expect(u.patch).toMatchObject({ ends_on: "2026-11-13", status: "active" });
  });
});
