import { beforeEach, describe, expect, it, vi } from "vitest";
import { SERVICE_LINES } from "@/lib/service-lines";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({ tables: {} as Record<string, Row[]> }));

// Apply the filters and selected columns so a dropped refund row or column
// changes the report's answer, just as it does with PostgREST.
function makeDb() {
  return {
    from(table: string) {
      const filters: Array<(row: Row) => boolean> = [];
      let columns = "*";
      let range: [number, number] | undefined;
      const value = (row: Row, column: string) => {
        if (column === "raw_event->>partial") {
          const partial = (row.raw_event as Row | null)?.partial;
          return partial == null ? null : String(partial);
        }
        return row[column];
      };
      const rows = () => {
        const filtered = (state.tables[table] ?? []).filter((row) =>
          filters.every((filter) => filter(row)),
        );
        const page = range ? filtered.slice(range[0], range[1] + 1) : filtered;
        return page.map((row) =>
          columns === "*"
            ? { ...row }
            : Object.fromEntries(columns.split(",").map((key) => [key.trim(), row[key.trim()]])),
        );
      };
      const query = {
        select(selected: string) {
          columns = selected;
          return query;
        },
        eq(column: string, expected: unknown) {
          filters.push((row) => value(row, column) === expected);
          return query;
        },
        neq(column: string, expected: unknown) {
          filters.push((row) => value(row, column) !== expected);
          return query;
        },
        in(column: string, expected: unknown[]) {
          filters.push((row) => expected.includes(value(row, column)));
          return query;
        },
        gte(column: string, expected: string) {
          filters.push((row) => String(value(row, column)) >= expected);
          return query;
        },
        lte(column: string, expected: string) {
          filters.push((row) => String(value(row, column)) <= expected);
          return query;
        },
        order() {
          return query;
        },
        range(from: number, to: number) {
          range = [from, to];
          return query;
        },
        async maybeSingle() {
          return { data: rows()[0] ?? null, error: null };
        },
        then(resolve: (result: { data: Row[]; error: null }) => unknown) {
          return Promise.resolve({ data: rows(), error: null }).then(resolve);
        },
      };
      return query;
    },
  };
}

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const builder = {
      middleware: () => builder,
      inputValidator: () => builder,
      handler: (fn: unknown) => fn,
    };
    return builder;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    return makeDb();
  },
}));
vi.mock("@/lib/authz.server", () => ({
  requirePermission: async () => ({ orgId: "test-org", role: "owner" }),
}));

import { getTaxReport, type ReportResult } from "@/lib/cpa-reports.functions";

const invoice = (id: string, total: number, overrides: Row = {}): Row => ({
  id,
  organization_id: "test-org",
  number: 1,
  client_id: "test-client",
  status: "open",
  total_cents: total,
  credit_applied_cents: 0,
  amount_paid_cents: 0,
  deposit_for_invoice_id: null,
  issued_at: "2026-11-01T15:00:00Z",
  due_on: "2026-11-01",
  paid_at: null,
  voided_at: null,
  ...overrides,
});

const payment = (id: string, invoiceId: string, overrides: Row = {}): Row => ({
  id,
  invoice_id: invoiceId,
  organization_id: "test-org",
  amount_cents: 10_000,
  refunded_cents: 0,
  status: "succeeded",
  paid_at: "2026-11-10T15:00:00Z",
  created_at: "2026-11-10T15:00:00Z",
  raw_event: { partial: true },
  ...overrides,
});

function book(withDeposit: boolean, serviceLine: string) {
  state.tables.organizations = [
    { id: "test-org", name: "Test business", timezone: "UTC", service_lines: [serviceLine] },
  ];
  state.tables.clients = [
    { id: "test-client", organization_id: "test-org", display_name: "Test client" },
  ];
  state.tables.invoices = [
    invoice("service", 35_000, { amount_paid_cents: 20_000 }),
    invoice("later", 50_000, { due_on: "2026-12-01" }),
    ...(withDeposit
      ? [
          invoice("deposit", 15_000, {
            deposit_for_invoice_id: "service",
            amount_paid_cents: 10_000,
          }),
        ]
      : []),
  ];
  state.tables.payments = [
    payment("partial-refund", withDeposit ? "deposit" : "service", {
      amount_cents: 15_000,
      refunded_cents: 5_000,
      status: "refunded",
      paid_at: "2026-11-02T15:00:00Z",
      created_at: "2026-11-02T15:00:00Z",
      raw_event: withDeposit ? {} : { partial: true },
    }),
    payment("fully-refunded", "service", {
      amount_cents: 2_500,
      refunded_cents: 2_500,
      status: "refunded",
    }),
    payment("top-up", "service", { tip_cents: 2_000 }),
    payment("pending", "service", { status: "pending" }),
    payment("failed", "service", { status: "failed" }),
    payment("other-org", "service", { organization_id: "another-test-org" }),
  ];
}

async function report(reportId: string, to = "2026-11-12") {
  const handler = getTaxReport as unknown as (args: unknown) => Promise<ReportResult>;
  return handler({
    data: { reportId, from: "2026-11-01", to },
    context: { supabase: makeDb(), userId: "test-owner" },
  });
}

beforeEach(() => {
  state.tables = {};
});

describe("CPA receivables after a partial refund and a later payment", () => {
  it("keeps $100 of the stay deposit and reports $650 owed after the $100 top-up", async () => {
    book(true, "pet_sitting");
    const aging = await report("ar_aging");
    expect(aging.rows).toEqual([
      {
        clientName: "Test client",
        currentCents: 50_000,
        d30Cents: 15_000,
        d60Cents: 0,
        d90Cents: 0,
        d90PlusCents: 0,
        totalCents: 65_000,
      },
    ]);
    expect(aging.totals?.totalCents).toBe(65_000);

    const bridge = await report("cash_accrual_bridge");
    expect(
      bridge.rows.find((row) => row.line === "Actual closing receivables at 2026-11-12"),
    ).toEqual({ line: "Actual closing receivables at 2026-11-12", amountCents: 65_000 });
  });

  it.each(SERVICE_LINES)("nets ordinary invoice payments for %s", async (line) => {
    book(false, line);
    const aging = await report("ar_aging");
    expect(aging.totals?.totalCents).toBe(65_000);
    expect(aging.totals?.d30Cents).toBe(15_000);
    expect(aging.totals?.currentCents).toBe(50_000);
  });

  it("counts the later top-up only from its payment day", async () => {
    book(true, "pet_sitting");
    const beforeTopUp = await report("ar_aging", "2026-11-09");
    expect(beforeTopUp.totals?.totalCents).toBe(75_000);
    expect((await report("ar_aging")).totals?.totalCents).toBe(65_000);
  });
});
