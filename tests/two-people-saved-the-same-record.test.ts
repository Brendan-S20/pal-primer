import { beforeEach, describe, expect, it, vi } from "vitest";

// F-25 (#655). Two office users open the same client, visit or invoice. The
// first one saves. The second one, still looking at the record as it was,
// saves too. Before this change the second save quietly replaced the first.
// Now each save carries the updated_at its form was loaded with, the server
// refuses it if the row has changed since, and the first person's change is
// still there afterwards.
//
// Against a fake database that applies the filters it is given and stamps
// updated_at the way the touch triggers on visits and invoices do. Nothing
// here reaches Supabase.

type Row = Record<string, unknown>;
type Filter = [string, string, unknown];

const state = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  tick: 0,
  rpcCalls: [] as Array<[string, Record<string, unknown>]>,
  // Runs just before an UPDATE is applied: lets a test land somebody else's
  // save between the server's read and its write.
  beforeUpdate: null as null | ((table: string) => void),
}));

/** Postgres-shaped timestamps, six fractional digits, one apart. */
function now(): string {
  state.tick += 1;
  return `2026-11-02T10:00:00.${String(state.tick).padStart(6, "0")}+00:00`;
}

// Tables with a BEFORE UPDATE trigger that sets updated_at = now().
const TOUCHED = new Set(["visits", "invoices"]);

function matches(row: Row, [op, col, a]: Filter): boolean {
  const v = row[col];
  if (op === "eq") return v === a;
  if (op === "neq") return v !== a;
  if (op === "in") return (a as unknown[]).includes(v);
  if (op === "is") return v == null;
  return true;
}

function makeDb() {
  return {
    from(table: string) {
      const filters: Filter[] = [];
      let patch: Row | null = null;
      const rows = () =>
        (state.tables[table] ?? []).filter((r) => filters.every((f) => matches(r, f)));
      const run = () => {
        if (patch) {
          state.beforeUpdate?.(table);
          const hit = rows();
          for (const r of hit) {
            Object.assign(r, patch);
            if (TOUCHED.has(table)) r.updated_at = now();
          }
          return hit.map((r) => ({ ...r }));
        }
        return rows().map((r) => ({ ...r }));
      };
      const chain: Record<string, unknown> = {};
      for (const op of ["eq", "neq", "in", "is"])
        chain[op] = (col: string, a: unknown) => {
          filters.push([op, col, a]);
          return chain;
        };
      for (const op of ["select", "order", "limit", "gte", "lt", "lte"]) chain[op] = () => chain;
      chain.update = (p: Row) => {
        patch = p;
        return chain;
      };
      chain.single = async () => {
        const r = run()[0];
        return r ? { data: r, error: null } : { data: null, error: { message: "not found" } };
      };
      chain.maybeSingle = async () => ({ data: run()[0] ?? null, error: null });
      chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve({ data: run(), error: null }).then(res, rej);
      return chain;
    },
    async rpc(name: string, args: Record<string, unknown>) {
      state.rpcCalls.push([name, args]);
      const one = (table: string, id: unknown) =>
        (state.tables[table] ?? []).find((r) => r.id === id) as Row;
      if (name === "reschedule_visit") {
        const v = one("visits", args._visit_id);
        v.scheduled_on = args._new_date;
        v.updated_at = now();
        return { data: null, error: null };
      }
      if (name === "void_invoice") {
        const inv = one("invoices", args._invoice_id);
        if (inv.status === "paid")
          return { data: null, error: { message: "Cannot void a paid invoice" } };
        inv.status = "void";
        inv.updated_at = now();
        return { data: null, error: null };
      }
      if (name === "record_invoice_payment") {
        const inv = one("invoices", args._invoice_id);
        if (inv.status === "paid" || inv.status === "void") {
          return { data: null, error: { message: `This invoice is already ${inv.status}` } };
        }
        const paid = (state.tables.payments ?? [])
          .filter((p) => p.invoice_id === inv.id)
          .reduce((s, p) => s + (p.amount_cents as number), 0);
        const balance = (inv.total_cents as number) - paid;
        const amount = (args._amount_cents as number | undefined) ?? balance;
        // Like the real function: a payment row, and the invoice row is
        // touched only when the balance reaches zero.
        (state.tables.payments ??= []).push({
          id: `pay-${state.tick}`,
          invoice_id: inv.id,
          amount_cents: amount,
          created_at: now(),
        });
        const settled = amount === balance;
        if (settled) {
          inv.status = "paid";
          inv.updated_at = now();
        }
        return {
          data: {
            invoice_id: inv.id,
            organization_id: inv.organization_id,
            client_id: inv.client_id,
            amount_cents: amount,
            balance_cents: balance - amount,
            paid: settled,
          },
          error: null,
        };
      }
      return { data: null, error: null };
    },
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
vi.mock("@/lib/activity.server", () => ({ logActivity: async () => {} }));
vi.mock("@/lib/email/enqueue.server", () => ({ enqueueAppEmail: async () => {} }));
vi.mock("@/lib/field-notify.server", () => ({
  startRouteWatch: async () => ({ finish: async () => {} }),
}));
vi.mock("@/lib/push-liveactivity.server", () => ({
  watchRouteLiveActivities: async () => async () => {},
  refreshRouteLiveActivities: async () => {},
  refreshOrgRouteLiveActivities: async () => {},
}));
vi.mock("@/lib/walk-notify.server", () => ({
  watchWalkSchedule: async () => ({ finish: async () => {} }),
}));
vi.mock("@/lib/booking-dates.server", () => ({ refusePastDay: async () => {} }));
vi.mock("@/lib/groom-clash.server", () => ({
  refuseGroomMoveClash: async () => {},
  groomWriteError: async (_s: unknown, e: { message: string }) => new Error(e.message),
}));
vi.mock("@/lib/overnight-clashes.server", () => ({ overnightClashWarning: async () => null }));
vi.mock("@/lib/training-packages.server", () => ({ lessonClashesAfterMove: async () => [] }));
vi.mock("@/lib/invoice-reconcile.server", () => ({
  syncInvoicePaymentIntentAmount: async () => {},
  reconcileInvoicePayment: async () => "unchanged",
}));
vi.mock("@/lib/refunds.server", () => ({ refundedCentsByPayment: async () => new Map() }));

import { getClient, updateClient } from "@/lib/clients.functions";
import { correctVisitTimestamps, rescheduleVisitFromOffice } from "@/lib/visits.functions";
import { bulkMarkInvoicesPaid, getInvoiceDetail, voidInvoice } from "@/lib/invoices.functions";
import {
  STALE_WRITE_MESSAGE,
  instantMicros,
  invoiceVersion,
  isStaleWriteError,
  sameInstant,
} from "@/lib/stale-write";

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CLIENT = ID(1);
const VISIT = ID(2);
const DONE = ID(3);
const INVOICE = ID(4);

beforeEach(() => {
  state.tick = 0;
  state.rpcCalls = [];
  state.beforeUpdate = null;
  state.tables = {
    organizations: [{ id: "org-1", timezone: "America/Chicago" }],
    clients: [
      {
        id: CLIENT,
        organization_id: "org-1",
        display_name: "Dana Ortiz",
        first_name: "Dana",
        last_name: "Ortiz",
        company: null,
        primary_phone: "555-0100",
        primary_email: "dana@example.com",
        tags: [],
        updated_at: now(),
      },
    ],
    visits: [
      {
        id: VISIT,
        organization_id: "org-1",
        client_id: CLIENT,
        property_id: "p",
        scheduled_on: "2026-11-10",
        status: "scheduled",
        started_at: null,
        completed_at: null,
        updated_at: now(),
      },
      {
        id: DONE,
        organization_id: "org-1",
        client_id: CLIENT,
        property_id: "p",
        scheduled_on: "2026-10-30",
        status: "completed",
        started_at: "2026-10-30T14:00:00+00:00",
        completed_at: "2026-10-30T14:20:00+00:00",
        updated_at: now(),
      },
    ],
    invoices: [
      {
        id: INVOICE,
        organization_id: "org-1",
        client_id: CLIENT,
        number: 1042,
        status: "open",
        total_cents: 5000,
        credit_applied_cents: 0,
        updated_at: now(),
      },
    ],
    payments: [],
  };
});

const row = (table: string, id: string) => state.tables[table].find((r) => r.id === id) as Row;

async function refused(p: Promise<unknown>) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, "the second save went through").not.toBeNull();
  expect(isStaleWriteError(err)).toBe(true);
  expect((err as Error).message).toBe(STALE_WRITE_MESSAGE);
}

describe("client: the Edit client drawer", () => {
  it("refuses the second save on a stale client and keeps the first one", async () => {
    // Both open the drawer.
    const ana = (await getClient({ data: { clientId: CLIENT } })).client as Row;
    const ben = (await getClient({ data: { clientId: CLIENT } })).client as Row;
    expect(ana.updated_at).toBe(ben.updated_at);

    await updateClient({
      data: {
        clientId: CLIENT,
        primaryPhone: "555-1111",
        expectedUpdatedAt: ana.updated_at as string,
      },
    });
    expect(row("clients", CLIENT).primary_phone).toBe("555-1111");

    await refused(
      updateClient({
        data: {
          clientId: CLIENT,
          primaryPhone: "555-2222",
          expectedUpdatedAt: ben.updated_at as string,
        },
      }),
    );
    expect(row("clients", CLIENT).primary_phone).toBe("555-1111");

    // Reload, and the same change goes through on the fresh copy.
    const fresh = (await getClient({ data: { clientId: CLIENT } })).client as Row;
    await updateClient({
      data: {
        clientId: CLIENT,
        primaryPhone: "555-2222",
        expectedUpdatedAt: fresh.updated_at as string,
      },
    });
    expect(row("clients", CLIENT).primary_phone).toBe("555-2222");
  });

  it("catches a save that lands between the check and the write", async () => {
    const ben = (await getClient({ data: { clientId: CLIENT } })).client as Row;
    // Ana's save lands after Ben's request has read the row but before it
    // writes: the guard in the UPDATE itself has to catch it.
    state.beforeUpdate = (table) => {
      if (table !== "clients") return;
      state.beforeUpdate = null;
      Object.assign(row("clients", CLIENT), { primary_phone: "555-1111", updated_at: now() });
    };
    await refused(
      updateClient({
        data: {
          clientId: CLIENT,
          primaryPhone: "555-2222",
          expectedUpdatedAt: ben.updated_at as string,
        },
      }),
    );
    expect(row("clients", CLIENT).primary_phone).toBe("555-1111");
  });

  it("does not check a caller that sends no version", async () => {
    await updateClient({ data: { clientId: CLIENT, primaryPhone: "555-1111" } });
    await updateClient({ data: { clientId: CLIENT, primaryPhone: "555-3333" } });
    expect(row("clients", CLIENT).primary_phone).toBe("555-3333");
  });
});

describe("visit: moving it and correcting its times", () => {
  it("refuses the second reschedule on a stale visit and keeps the first move", async () => {
    const loaded = row("visits", VISIT).updated_at as string;

    await rescheduleVisitFromOffice({
      data: { visitId: VISIT, newDate: "2026-11-12", expectedUpdatedAt: loaded },
    });
    expect(row("visits", VISIT).scheduled_on).toBe("2026-11-12");

    await refused(
      rescheduleVisitFromOffice({
        data: { visitId: VISIT, newDate: "2026-11-14", expectedUpdatedAt: loaded },
      }),
    );
    expect(row("visits", VISIT).scheduled_on).toBe("2026-11-12");
    // Refused before the move was sent, so nobody was told about it either.
    expect(state.rpcCalls.filter(([n]) => n === "reschedule_visit")).toHaveLength(1);
  });

  it("refuses the second timestamp correction on a stale visit", async () => {
    const loaded = row("visits", DONE).updated_at as string;

    await correctVisitTimestamps({
      data: {
        visitId: DONE,
        startedAt: "2026-10-30T13:50:00+00:00",
        completedAt: "2026-10-30T14:25:00+00:00",
        reason: "Tech forgot to tap start",
        expectedUpdatedAt: loaded,
      },
    });
    await refused(
      correctVisitTimestamps({
        data: {
          visitId: DONE,
          startedAt: "2026-10-30T15:00:00+00:00",
          completedAt: "2026-10-30T15:10:00+00:00",
          reason: "Wrong day",
          expectedUpdatedAt: loaded,
        },
      }),
    );
    expect(row("visits", DONE).started_at).toBe("2026-10-30T13:50:00+00:00");
    expect(row("visits", DONE).completed_at).toBe("2026-10-30T14:25:00+00:00");
  });
});

describe("invoice: voiding it and recording a payment", () => {
  const version = async () =>
    (await getInvoiceDetail({ data: { invoiceId: INVOICE } })).version as string;

  it("refuses a void from a page that has not seen a partial payment", async () => {
    // Both open the invoice; $50 owed.
    const ana = await version();
    const ben = await version();

    // Ana records $20. A partial payment adds a payments row and does not
    // touch the invoice row, so updated_at alone would not see it.
    const r = await bulkMarkInvoicesPaid({
      data: { ids: [INVOICE], method: "check", amountCents: 2000, expectedVersion: ana },
    });
    expect(r.ok).toBe(1);
    expect(row("invoices", INVOICE).status).toBe("open");

    // Ben, still looking at $50 owed, voids it.
    await refused(voidInvoice({ data: { id: INVOICE, expectedVersion: ben } }));
    expect(row("invoices", INVOICE).status).toBe("open");
    expect(state.tables.payments).toHaveLength(1);
    expect(state.rpcCalls.some(([n]) => n === "void_invoice")).toBe(false);

    // Reloaded, the version has moved on and the void goes through.
    const fresh = await version();
    expect(fresh).not.toBe(ben);
    await voidInvoice({ data: { id: INVOICE, expectedVersion: fresh } });
    expect(row("invoices", INVOICE).status).toBe("void");
  });

  it("refuses a payment from a page that has not seen the void", async () => {
    const ana = await version();
    const ben = await version();

    await voidInvoice({ data: { id: INVOICE, expectedVersion: ana } });
    expect(row("invoices", INVOICE).status).toBe("void");

    await refused(
      bulkMarkInvoicesPaid({
        data: { ids: [INVOICE], method: "cash", expectedVersion: ben },
      }),
    );
    expect(row("invoices", INVOICE).status).toBe("void");
    expect(state.tables.payments).toHaveLength(0);
    expect(state.rpcCalls.some(([n]) => n === "record_invoice_payment")).toBe(false);
  });

  it("will not check a version across several invoices at once", async () => {
    const v = await version();
    await expect(
      bulkMarkInvoicesPaid({ data: { ids: [INVOICE, ID(9)], expectedVersion: v } }),
    ).rejects.toThrow(/one invoice/);
  });
});

describe("comparing versions", () => {
  it("keeps the microseconds Postgres sends", () => {
    expect(
      sameInstant("2026-11-02T10:00:00.123456+00:00", "2026-11-02T10:00:00.123457+00:00"),
    ).toBe(false);
    expect(sameInstant("2026-11-02T10:00:00.123+00:00", "2026-11-02T10:00:00.123000Z")).toBe(true);
    expect(sameInstant("2026-11-02T05:00:00-05:00", "2026-11-02T10:00:00+00:00")).toBe(true);
    expect(instantMicros("not a date")).toBeNull();
  });

  it("takes an invoice's newest payment as its version when that is later", () => {
    expect(
      invoiceVersion("2026-11-02T10:00:00.000001+00:00", [
        { created_at: "2026-11-02T10:00:00.000005+00:00" },
        { created_at: "2026-11-02T10:00:00.000003+00:00" },
      ]),
    ).toBe("2026-11-02T10:00:00.000005+00:00");
    expect(invoiceVersion("2026-11-02T10:00:00.000009+00:00", [])).toBe(
      "2026-11-02T10:00:00.000009+00:00",
    );
  });
});
