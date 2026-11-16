// #676, the server half. tests/a-prepaid-one-off-can-be-ended.test.ts checks
// the rules (canEndService, endServiceDecision, the drawer's words) and reads
// the source to see they are wired. This runs the real server functions
// against a fake Supabase and checks what they WRITE, against the issue's
// acceptance list:
//
//   - a prepaid one_time service with history can be ended without changing
//     its frequency (nothing in the write touches frequency or schedule);
//   - after End its status is not `active`, so Bill next and Pause leave the
//     card (both are drawn only for `status === "active"`) and visit
//     generation stops at ends_on;
//   - Delete on a service with history refuses, and the refusal names the
//     End service… control that is now on the card, not an End that is not;
//   - Delete still works on a service with no history.
//
// The service is the one the issue was found on, reduced to what the
// functions read: an Evaluation, frequency one_time, prepaid, its visit on
// Nov 3, being cleaned up on Nov 2 after the visit was canceled and the
// payment refunded.
//
// The clock is pinned to the middle of the UTC day, where the UTC date and
// the org's agree. The evening window where they differ is measured in
// tests/subscriptions-today-is-the-businesss-day.test.ts.

/* eslint-disable @typescript-eslint/no-explicit-any -- a fake of the supabase-js builder and createServerFn chain */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;

const h = vi.hoisted(() => ({
  sub: null as Row | null,
  /** visits.status <> 'scheduled' for this service (canceled, completed, …). */
  historyVisits: 0,
  invoiceLines: 0,
  updates: [] as Array<{ table: string; patch: Row; filters: Array<[string, unknown]> }>,
  deletes: [] as Array<{ table: string; filters: Array<[string, unknown]> }>,
  activity: [] as Row[],
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
  requirePermission: async () => ({ orgId: "org-1", role: "owner" }),
}));
vi.mock("@/lib/activity.server", () => ({
  logActivity: async (_s: unknown, entry: Row) => void h.activity.push(entry),
}));

import { deleteDraftSubscription, endSubscription } from "@/lib/subscriptions.functions";

const SUB_ID = "645458a1-78fa-41ca-8a90-cf5731b4e980";
const USER_ID = "00000000-0000-4000-8000-0000000000aa";
const TODAY = "2026-11-02";

/** As much of supabase-js as endSubscription and deleteDraftSubscription use. */
function fakeSupabase() {
  return {
    from(table: string) {
      let op: "select" | "update" | "delete" = "select";
      let patch: Row = {};
      let head = false;
      const filters: Array<[string, unknown]> = [];
      const settle = () => {
        if (op === "update") {
          h.updates.push({ table, patch, filters });
          return { data: null, error: null };
        }
        if (op === "delete") {
          h.deletes.push({ table, filters });
          return { data: null, error: null };
        }
        if (head && table === "visits") return { count: h.historyVisits, error: null };
        if (head && table === "invoice_line_items") return { count: h.invoiceLines, error: null };
        return { data: null, error: null };
      };
      const q: any = {
        select: (_cols: string, opts?: { head?: boolean }) => ((head = !!opts?.head), q),
        update: (p: Row) => ((op = "update"), (patch = p), q),
        delete: () => ((op = "delete"), q),
        eq: (col: string, val: unknown) => (filters.push([col, val]), q),
        neq: (col: string, val: unknown) => (filters.push([`${col}<>`, val]), q),
        single: async () => ({ data: h.sub, error: null }),
        // orgTodayFor reads organizations.timezone; none here means the default.
        maybeSingle: async () => ({ data: null, error: null }),
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(settle()).then(resolve, reject),
      };
      return q;
    },
  };
}

const call = (fn: any, data: Row) =>
  fn({ data, context: { supabase: fakeSupabase(), userId: USER_ID } });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`${TODAY}T15:00:00Z`));
  h.sub = {
    id: SUB_ID,
    organization_id: "org-1",
    client_id: "8af46978-56dd-49bd-aa27-5337bd54802f",
    property_id: "pppppppp-0000-4000-8000-000000000001",
    status: "active",
    frequency: "one_time",
    started_on: "2026-11-03",
    ends_on: "2026-11-03",
  };
  h.historyVisits = 1; // the canceled visit
  h.invoiceLines = 1; // the prepaid, refunded invoice
  h.updates = [];
  h.deletes = [];
  h.activity = [];
});
afterEach(() => vi.useRealTimers());

describe("End service… on a prepaid one_time before its visit day (#676)", () => {
  it("ends it today, canceled at once, without touching its frequency", async () => {
    await call(endSubscription, {
      subscriptionId: SUB_ID,
      effectiveDate: TODAY,
      reason: "customer_canceled",
    });
    expect(h.updates).toHaveLength(1);
    const { table, patch, filters } = h.updates[0];
    expect(table).toBe("subscriptions");
    expect(filters).toEqual([["id", SUB_ID]]);
    expect(patch).toMatchObject({
      ends_on: TODAY,
      status: "canceled",
      end_reason: "customer_canceled",
      ended_by: USER_ID,
      paused_at: null,
    });
    // The acceptance line that matters most: no detour through Weekly.
    for (const k of ["frequency", "interval_weeks", "weekdays", "started_on", "billing_cadence"]) {
      expect(patch, k).not.toHaveProperty(k);
    }
    expect(h.activity).toMatchObject([{ kind: "service.ended", subscriptionId: SUB_ID }]);
  });

  it("an end on a later day before the visit also cancels at once: it never runs", async () => {
    h.sub!.started_on = "2026-11-20";
    h.sub!.ends_on = "2026-11-20";
    await call(endSubscription, {
      subscriptionId: SUB_ID,
      effectiveDate: "2026-11-10",
      reason: "customer_canceled",
    });
    expect(h.updates[0].patch).toMatchObject({ ends_on: "2026-11-10", status: "canceled" });
  });

  it("refuses an end date in the past, and writes nothing", async () => {
    await expect(
      call(endSubscription, {
        subscriptionId: SUB_ID,
        effectiveDate: "2026-11-01",
        reason: "customer_canceled",
      }),
    ).rejects.toThrow("End date can't be in the past");
    expect(h.updates).toEqual([]);
  });

  it("a one_time whose day has passed (visit canceled) ends today too", async () => {
    h.sub!.started_on = "2026-10-30";
    h.sub!.ends_on = "2026-10-30";
    await call(endSubscription, {
      subscriptionId: SUB_ID,
      effectiveDate: TODAY,
      reason: "other",
    });
    expect(h.updates[0].patch).toMatchObject({ status: "canceled", ends_on: TODAY });
  });
});

describe("Delete service… on the same service", () => {
  it("refuses once there is history, and points at End service…, which is on the card", async () => {
    await expect(call(deleteDraftSubscription, { subscriptionId: SUB_ID })).rejects.toThrow(
      /can't be deleted\. Use End service… on the service instead\./,
    );
    expect(h.deletes).toEqual([]);
  });

  it("refuses on a refunded invoice line alone, with no visit history", async () => {
    h.historyVisits = 0;
    await expect(call(deleteDraftSubscription, { subscriptionId: SUB_ID })).rejects.toThrow(
      /Use End service…/,
    );
    expect(h.deletes).toEqual([]);
  });

  it("still deletes a service with no history at all", async () => {
    h.historyVisits = 0;
    h.invoiceLines = 0;
    await call(deleteDraftSubscription, { subscriptionId: SUB_ID });
    expect(h.deletes.map((d) => d.table)).toEqual(["visits", "subscriptions"]);
    // Only the not-yet-happened visits go with it.
    expect(h.deletes[0].filters).toEqual([
      ["subscription_id", SUB_ID],
      ["status", "scheduled"],
    ]);
  });
});
