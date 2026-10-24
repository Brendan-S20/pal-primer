// Packages lived only on each client's Services tab, so finding the ones
// running low meant opening every client (product review of #476, "the office
// has no packages overview"). /training-packages lists every running package
// with sessions used, booked and still to book, and puts the ones running low
// first: one session left, or the same 14 days the expiry notice uses.

import { describe, expect, it, vi } from "vitest";
import { RUNNING_LOW_DAYS, runningLow } from "@/lib/training-packages";

const context: { supabase: unknown; userId: string } = { supabase: null, userId: "office" };
vi.mock("@tanstack/react-start", () => {
  const builder = {
    middleware: () => builder,
    inputValidator: () => builder,
    handler: (fn: (a: { data: unknown; context: unknown }) => unknown) => () =>
      fn({ data: undefined, context }),
  };
  return { createServerFn: () => builder };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/lib/authz.server", () => ({
  resolveCaller: async () => ({ orgId: "org-a", role: "office_manager" }),
  requirePermission: vi.fn(),
}));
vi.mock("@/lib/manual-invoice.server", () => ({ insertManualInvoice: vi.fn() }));

import { listTrainingPackagesOverview } from "@/lib/training-packages.functions";

const pack = (over: Record<string, unknown> = {}) => ({
  sessions_count: 6,
  sessions_used: 2,
  expires_on: null as string | null,
  status: "active" as const,
  ...over,
});

describe("running low", () => {
  it("is one session left, or within 14 days of expiry, on a running package", () => {
    const today = "2090-01-01";
    expect(RUNNING_LOW_DAYS).toBe(14);
    expect(runningLow(pack({ sessions_used: 5 }), today)).toBe(true);
    expect(runningLow(pack({ expires_on: "2090-01-15" }), today)).toBe(true);
    expect(runningLow(pack({ expires_on: "2090-01-16" }), today)).toBe(false);
    expect(runningLow(pack(), today)).toBe(false);
    // Not running: nothing to chase.
    expect(runningLow(pack({ sessions_used: 6 }), today)).toBe(false);
    expect(runningLow(pack({ status: "canceled", sessions_used: 5 }), today)).toBe(false);
    expect(runningLow(pack({ expires_on: "2089-12-31" }), today)).toBe(false);
  });
});

describe("the overview", () => {
  it("counts used, booked and still to book, flags unpaid, and puts the low ones first", async () => {
    const filters: unknown[][] = [];
    const data: Record<string, unknown> = {
      client_packages: [
        {
          id: "p-roomy",
          name: "6-session package",
          client_id: "c-1",
          dog_id: null,
          sessions_count: 6,
          sessions_used: 1,
          expires_on: null,
          status: "active",
          invoice_id: "inv-paid",
          clients: { display_name: "Ana" },
          dogs: null,
        },
        {
          id: "p-low",
          name: "4-session package",
          client_id: "c-2",
          dog_id: "d-1",
          sessions_count: 4,
          sessions_used: 3,
          expires_on: null,
          status: "active",
          invoice_id: "inv-open",
          clients: { display_name: "Bo" },
          dogs: { name: "Pepper" },
        },
        {
          // Expired: not running, so not listed.
          id: "p-old",
          name: "old",
          client_id: "c-3",
          dog_id: null,
          sessions_count: 6,
          sessions_used: 1,
          expires_on: "2000-01-01",
          status: "active",
          invoice_id: null,
          clients: { display_name: "Cy" },
          dogs: null,
        },
      ],
      organizations: { timezone: "UTC" },
      visits: [
        { client_package_id: "p-roomy", status: "completed", skip_billable: false },
        { client_package_id: "p-roomy", status: "scheduled", skip_billable: false },
        { client_package_id: "p-roomy", status: "scheduled", skip_billable: false },
        // Canceled lessons give their session back.
        { client_package_id: "p-roomy", status: "skipped", skip_billable: false },
        { client_package_id: "p-low", status: "completed", skip_billable: false },
        { client_package_id: "p-low", status: "missed", skip_billable: true },
        { client_package_id: "p-low", status: "completed", skip_billable: false },
      ],
      invoices: [
        { id: "inv-paid", status: "paid" },
        { id: "inv-open", status: "open" },
      ],
    };
    context.supabase = {
      from(table: string) {
        const q: Record<string, unknown> = {};
        for (const m of ["select", "eq", "in", "order"])
          q[m] = (...args: unknown[]) => {
            filters.push([table, m, ...args]);
            return q;
          };
        q.single = async () => ({ data: data[table], error: null });
        q.then = (res: (v: unknown) => unknown) =>
          Promise.resolve({ data: data[table], error: null }).then(res);
        return q;
      },
    };
    const r = (await (listTrainingPackagesOverview as unknown as () => Promise<unknown>)()) as {
      packages: Array<Record<string, unknown>>;
    };
    expect(r.packages.map((p) => p.id)).toEqual(["p-low", "p-roomy"]);
    expect(r.packages[0]).toMatchObject({
      clientName: "Bo",
      dogName: "Pepper",
      used: 3,
      booked: 0,
      toBook: 1,
      runningLow: true,
      unpaid: true,
    });
    expect(r.packages[1]).toMatchObject({
      clientName: "Ana",
      dogName: null,
      used: 1,
      booked: 2,
      toBook: 3,
      runningLow: false,
      unpaid: false,
    });
    expect(filters).toContainEqual(["client_packages", "eq", "organization_id", "org-a"]);
    expect(filters).toContainEqual(["client_packages", "eq", "status", "active"]);
  });
});
