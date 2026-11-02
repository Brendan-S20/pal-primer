// #655 (F-25). Two office users open the same client, visit or invoice. The
// first one saves. The second one, still looking at what was there before,
// saves too, and until this change the second save wrote over the first with
// no warning.
//
// Each save now sends the updated_at its screen loaded with, and the server
// refuses it when the row has changed since. These tests drive the real server
// functions against an in-memory database that behaves as Postgres does for
// what they touch: visits and invoices carry a BEFORE UPDATE trigger that
// stamps updated_at with microseconds, and clients do not (updateClient
// stamps its own). Each case is the scenario in the issue: A and B load, B
// saves, A saves, A is refused and B's change is what is stored.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;

const h = vi.hoisted(() => ({
  db: {} as Record<string, Map<string, Record<string, any>>>,
  tick: 0,
}));

vi.mock("@tanstack/react-start", () => ({
  createServerOnlyFn: (fn: unknown) => fn,
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
  resolveCaller: async () => ({ orgId: "org-1", role: "owner" }),
}));
vi.mock("@/lib/activity.server", () => ({ logActivity: async () => {} }));
vi.mock("@/lib/field-notify.server", () => ({
  startRouteWatch: async () => ({ finish: async () => {} }),
}));
vi.mock("@/lib/push-liveactivity.server", () => ({
  watchRouteLiveActivities: async () => async () => {},
}));
vi.mock("@/lib/walk-notify.server", () => ({
  watchWalkSchedule: async () => ({ finish: async () => {} }),
  notifyWalksCanceled: async () => {},
}));
vi.mock("@/lib/booking-dates.server", () => ({
  refusePastDay: async () => {},
  orgTodayFor: async () => "2026-11-02",
}));
vi.mock("@/lib/groom-clash.server", () => ({
  refuseGroomMoveClash: async () => {},
  groomWriteError: async (_s: unknown, e: { message: string }) => new Error(e.message),
}));
vi.mock("@/lib/overnight-clashes.server", () => ({ overnightClashWarning: async () => null }));
vi.mock("@/lib/training-packages.server", () => ({ lessonClashesAfterMove: async () => [] }));
vi.mock("@/lib/training-portal.server", () => ({ afterLessonSessionChange: async () => {} }));
vi.mock("@/lib/invoice-reconcile.server", () => ({
  syncInvoicePaymentIntentAmount: async () => {},
  invoiceHasProcessingIntent: async () => false,
}));
vi.mock("@/lib/invoice-labels", () => ({
  invoiceRef: async () => "INV-1001",
  invoiceNumberLabel: () => "INV-1001",
}));

import { sameInstant } from "@/lib/stale-write";

/** What a BEFORE UPDATE trigger's now() writes: six fractional digits. */
function triggerNow(): string {
  h.tick += 1;
  return `2026-11-02T10:00:00.${String(h.tick).padStart(6, "0")}+00:00`;
}

const TRIGGER_STAMPED = new Set(["visits", "invoices"]);

function matches(row: Row, filters: Array<[string, unknown]>) {
  return filters.every(([col, val]) =>
    col === "updated_at" ? sameInstant(row[col], val as string) : row[col] === val,
  );
}

function update(table: string, filters: Array<[string, unknown]>, patch: Row): Row[] {
  const hit: Row[] = [];
  for (const row of h.db[table]?.values() ?? []) {
    if (!matches(row, filters)) continue;
    Object.assign(row, patch);
    if (TRIGGER_STAMPED.has(table)) row.updated_at = triggerNow();
    hit.push({ ...row });
  }
  return hit;
}

function bump(table: string, id: string, patch: Row): Row {
  const [row] = update(table, [["id", id]], patch);
  return row;
}

/** As much of supabase-js as the five server functions use. */
function fakeSupabase() {
  return {
    rpc: async (fn: string, args: Row) => {
      if (fn === "reschedule_visit") {
        bump("visits", args._visit_id, { scheduled_on: args._new_date });
      } else if (fn === "office_skip_visit") {
        bump("visits", args._visit_id, { status: "skipped", skip_reason: args._reason });
      } else if (fn === "office_complete_visit") {
        bump("visits", args._visit_id, { status: "completed" });
      } else if (fn === "void_invoice") {
        bump("invoices", args._invoice_id, { status: "void" });
      } else if (fn === "record_invoice_payment") {
        const inv = h.db.invoices.get(args._invoice_id)!;
        const balance = inv.total_cents - inv.amount_paid_cents;
        const amount = args._amount_cents ?? balance;
        if (amount > balance) return { data: null, error: { message: "More than the balance" } };
        const paid = amount === balance;
        bump("invoices", inv.id, {
          amount_paid_cents: inv.amount_paid_cents + amount,
          ...(paid ? { status: "paid" } : {}),
        });
        return {
          data: {
            invoice_id: inv.id,
            organization_id: "org-1",
            client_id: inv.client_id,
            amount_cents: amount,
            balance_cents: balance - amount,
            paid,
          },
          error: null,
        };
      }
      return { data: null, error: null };
    },
    from(table: string) {
      let op: "select" | "update" = "select";
      let patch: Row = {};
      let returning = false;
      let one: "single" | "maybe" | null = null;
      const filters: Array<[string, unknown]> = [];
      const q: any = {
        select: () => {
          if (op === "update") returning = true;
          return q;
        },
        eq: (col: string, val: unknown) => (filters.push([col, val]), q),
        update: (p: Row) => ((op = "update"), (patch = p), q),
        single: () => ((one = "single"), q),
        maybeSingle: () => ((one = "maybe"), q),
        then(res: any, rej: any) {
          let out: any;
          if (op === "update") {
            const hit = update(table, filters, patch);
            out = { data: returning ? hit : null, error: null };
          } else {
            const rows = [...(h.db[table]?.values() ?? [])]
              .filter((r) => matches(r, filters))
              .map((r) => ({ ...r }));
            if (one === "single")
              out = rows[0]
                ? { data: rows[0], error: null }
                : { data: null, error: { message: "no rows" } };
            else if (one === "maybe") out = { data: rows[0] ?? null, error: null };
            else out = { data: rows, error: null };
          }
          return Promise.resolve(out).then(res, rej);
        },
      };
      return q;
    },
  };
}

import { updateClient } from "@/lib/clients.functions";
import {
  cancelVisitFromOffice,
  correctVisitTimestamps,
  rescheduleVisitFromOffice,
} from "@/lib/visits.functions";
import { bulkMarkInvoicesPaid, voidInvoice } from "@/lib/invoices.functions";

const CLIENT = "11111111-1111-4111-8111-111111111111";
const VISIT = "22222222-2222-4222-8222-222222222222";
const INVOICE = "33333333-3333-4333-8333-333333333333";
const ctx = (userId: string) => ({ supabase: fakeSupabase(), userId });
const STALE = /^Someone else changed this (client|visit|invoice) after you opened it/;

/** What a screen reads when it opens the record. */
const load = (table: string, id: string) => ({ ...h.db[table].get(id)! });

beforeEach(() => {
  h.tick = 0;
  h.db = {
    clients: new Map([
      [
        CLIENT,
        {
          id: CLIENT,
          organization_id: "org-1",
          display_name: "Ana Ruiz",
          first_name: "Ana",
          last_name: "Ruiz",
          company: null,
          primary_phone: "555-0100",
          primary_email: "ana@example.com",
          tags: [],
          // Written long before either person opened it.
          updated_at: "2026-10-01T08:00:00.123456+00:00",
        },
      ],
    ]),
    visits: new Map([
      [
        VISIT,
        {
          id: VISIT,
          organization_id: "org-1",
          client_id: CLIENT,
          property_id: null,
          scheduled_on: "2026-11-05",
          status: "scheduled",
          started_at: null,
          completed_at: null,
          updated_at: triggerNow(),
        },
      ],
    ]),
    invoices: new Map([
      [
        INVOICE,
        {
          id: INVOICE,
          organization_id: "org-1",
          client_id: CLIENT,
          status: "open",
          total_cents: 10_000,
          amount_paid_cents: 0,
          updated_at: triggerNow(),
        },
      ],
    ]),
  };
});

describe("a client edit made from a stale form", () => {
  it("is refused, and the first person's change survives", async () => {
    const a = load("clients", CLIENT);
    const b = load("clients", CLIENT);

    await updateClient({
      data: { clientId: CLIENT, primaryPhone: "555-0199", expectedUpdatedAt: b.updated_at },
      context: ctx("u-b"),
    });
    expect(h.db.clients.get(CLIENT)!.primary_phone).toBe("555-0199");

    await expect(
      updateClient({
        data: { clientId: CLIENT, primaryPhone: "555-0111", expectedUpdatedAt: a.updated_at },
        context: ctx("u-a"),
      }),
    ).rejects.toThrow(STALE);
    expect(h.db.clients.get(CLIENT)!.primary_phone).toBe("555-0199");
  });

  it("goes through once the form is reloaded", async () => {
    const a = load("clients", CLIENT);
    await updateClient({
      data: { clientId: CLIENT, primaryPhone: "555-0199", expectedUpdatedAt: a.updated_at },
      context: ctx("u-b"),
    });
    const reloaded = load("clients", CLIENT);
    await updateClient({
      data: {
        clientId: CLIENT,
        primaryEmail: "a@example.com",
        expectedUpdatedAt: reloaded.updated_at,
      },
      context: ctx("u-a"),
    });
    expect(h.db.clients.get(CLIENT)).toMatchObject({
      primary_phone: "555-0199",
      primary_email: "a@example.com",
    });
  });

  it("is still accepted from an older build that sends no stamp", async () => {
    await updateClient({
      data: { clientId: CLIENT, primaryPhone: "555-0142" },
      context: ctx("u-a"),
    });
    expect(h.db.clients.get(CLIENT)!.primary_phone).toBe("555-0142");
  });
});

describe("a visit change made from a stale screen", () => {
  it("a reschedule is refused, and the first move survives", async () => {
    const a = load("visits", VISIT);
    const b = load("visits", VISIT);

    await rescheduleVisitFromOffice({
      data: { visitId: VISIT, newDate: "2026-11-06", expectedUpdatedAt: b.updated_at },
      context: ctx("u-b"),
    });
    await expect(
      rescheduleVisitFromOffice({
        data: { visitId: VISIT, newDate: "2026-11-09", expectedUpdatedAt: a.updated_at },
        context: ctx("u-a"),
      }),
    ).rejects.toThrow(STALE);
    expect(h.db.visits.get(VISIT)!.scheduled_on).toBe("2026-11-06");
  });

  it("a cancel is refused after somebody else moved it", async () => {
    const a = load("visits", VISIT);
    await rescheduleVisitFromOffice({
      data: { visitId: VISIT, newDate: "2026-11-06", expectedUpdatedAt: a.updated_at },
      context: ctx("u-b"),
    });
    await expect(
      cancelVisitFromOffice({
        data: { visitId: VISIT, reason: "Client called", expectedUpdatedAt: a.updated_at },
        context: ctx("u-a"),
      }),
    ).rejects.toThrow(STALE);
    expect(h.db.visits.get(VISIT)).toMatchObject({
      status: "scheduled",
      scheduled_on: "2026-11-06",
    });
  });

  it("a timestamp correction is refused, and the first correction survives", async () => {
    const a = load("visits", VISIT);
    const b = load("visits", VISIT);
    const first = "2026-11-05T14:00:00.000Z";
    await correctVisitTimestamps({
      data: {
        visitId: VISIT,
        startedAt: first,
        completedAt: null,
        reason: "Tech forgot to start",
        expectedUpdatedAt: b.updated_at,
      },
      context: ctx("u-b"),
    });
    await expect(
      correctVisitTimestamps({
        data: {
          visitId: VISIT,
          startedAt: "2026-11-05T15:00:00.000Z",
          completedAt: null,
          reason: "Other guess",
          expectedUpdatedAt: a.updated_at,
        },
        context: ctx("u-a"),
      }),
    ).rejects.toThrow(STALE);
    expect(h.db.visits.get(VISIT)!.started_at).toBe(first);
  });

  it("tells apart two writes in the same millisecond", async () => {
    // The trigger's now() differs only past the third digit here; a check
    // that went through Date would call these the same moment.
    const a = load("visits", VISIT);
    await rescheduleVisitFromOffice({
      data: { visitId: VISIT, newDate: "2026-11-06", expectedUpdatedAt: a.updated_at },
      context: ctx("u-b"),
    });
    expect(new Date(a.updated_at).getTime()).toBe(
      new Date(h.db.visits.get(VISIT)!.updated_at).getTime(),
    );
    await expect(
      rescheduleVisitFromOffice({
        data: { visitId: VISIT, newDate: "2026-11-09", expectedUpdatedAt: a.updated_at },
        context: ctx("u-a"),
      }),
    ).rejects.toThrow(STALE);
  });
});

describe("an invoice action taken from a stale page", () => {
  it("recording the whole balance is refused after somebody else recorded part of it", async () => {
    const a = load("invoices", INVOICE);
    const b = load("invoices", INVOICE);

    await bulkMarkInvoicesPaid({
      data: { ids: [INVOICE], method: "cash", amountCents: 4_000, expectedUpdatedAt: b.updated_at },
      context: ctx("u-b"),
    });
    // A still sees $100 owed and records "the whole balance".
    await expect(
      bulkMarkInvoicesPaid({
        data: { ids: [INVOICE], method: "check", expectedUpdatedAt: a.updated_at },
        context: ctx("u-a"),
      }),
    ).rejects.toThrow(STALE);
    expect(h.db.invoices.get(INVOICE)).toMatchObject({ amount_paid_cents: 4_000, status: "open" });
  });

  it("a void is refused after somebody else recorded a payment", async () => {
    const a = load("invoices", INVOICE);
    await bulkMarkInvoicesPaid({
      data: { ids: [INVOICE], method: "cash", amountCents: 4_000, expectedUpdatedAt: a.updated_at },
      context: ctx("u-b"),
    });
    await expect(
      voidInvoice({ data: { id: INVOICE, expectedUpdatedAt: a.updated_at }, context: ctx("u-a") }),
    ).rejects.toThrow(STALE);
    expect(h.db.invoices.get(INVOICE)).toMatchObject({ status: "open", amount_paid_cents: 4_000 });
  });

  it("a void from a page loaded after the payment goes through", async () => {
    const a = load("invoices", INVOICE);
    await bulkMarkInvoicesPaid({
      data: { ids: [INVOICE], method: "cash", amountCents: 4_000, expectedUpdatedAt: a.updated_at },
      context: ctx("u-b"),
    });
    const reloaded = load("invoices", INVOICE);
    await voidInvoice({
      data: { id: INVOICE, expectedUpdatedAt: reloaded.updated_at },
      context: ctx("u-a"),
    });
    expect(h.db.invoices.get(INVOICE)!.status).toBe("void");
  });

  it("a stamp is only checked against one invoice", async () => {
    const a = load("invoices", INVOICE);
    await expect(
      bulkMarkInvoicesPaid({
        data: {
          ids: [INVOICE, "44444444-4444-4444-8444-444444444444"],
          expectedUpdatedAt: a.updated_at,
        },
        context: ctx("u-a"),
      }),
    ).rejects.toThrow(/one invoice/);
  });
});

describe("the screens send what they loaded and offer Reload", () => {
  const read = (p: string) => readFileSync(join(import.meta.dirname, "..", p), "utf8");

  it("every read the screens load from carries updated_at", () => {
    const clients = read("src/lib/clients.functions.ts");
    const getClient = clients.slice(
      clients.indexOf("export const getClient "),
      clients.indexOf("export const getFieldClientInfo"),
    );
    expect(getClient).toMatch(/vet_treatment_limit_cents, updated_at"/);
    const history = clients.slice(clients.indexOf("export const listClientVisitHistory"));
    expect(history.slice(0, 1500)).toMatch(/client_package_id, updated_at,/);
    const visits = read("src/lib/visits.functions.ts");
    const detail = visits.slice(visits.indexOf("export const getVisitDetail"));
    expect(detail.slice(0, 1200)).toMatch(/client_id, property_id, updated_at,/);
    const invoices = read("src/lib/invoices.functions.ts");
    const invDetail = invoices.slice(invoices.indexOf("export const getInvoiceDetail"));
    expect(invDetail.slice(0, 2500)).toMatch(/created_at, updated_at, clients\(/);
    // getInvoice reads "*", which includes it.
    const getInvoice = invoices.slice(invoices.indexOf("export const getInvoice "));
    expect(getInvoice.slice(0, 600)).toMatch(/\.select\("\*, clients/);
  });

  it.each([
    ["src/components/client-detail/EditClientDrawer.tsx", 1],
    ["src/components/VisitDetailDrawer.tsx", 3],
    ["src/components/client-detail/VisitsTab.tsx", 4],
    ["src/routes/_authenticated/invoices.$invoiceId.tsx", 2],
    ["src/components/InvoiceDrawer.tsx", 2],
  ])("%s sends the stamp and shows a refusal with Reload", (file, saves) => {
    const src = read(file);
    expect(src.match(/expectedUpdatedAt/g)?.length ?? 0).toBeGreaterThanOrEqual(saves);
    expect(src.match(/toastSaveError\(e, reload\)/g)?.length ?? 0).toBe(saves);
  });

  it("the client form keeps the stamp it was filled from, not the live one", () => {
    const src = read("src/components/client-detail/EditClientDrawer.tsx");
    expect(src).toMatch(
      /setForm\(initial\);[\s\S]{0,120}loadedUpdatedAt\.current = client\?\.updated_at/,
    );
    expect(src).toMatch(/expectedUpdatedAt: loadedUpdatedAt\.current/);
  });

  it("Reload is offered only for a refusal", async () => {
    const toast = { error: vi.fn() };
    vi.doMock("sonner", () => ({ toast }));
    vi.resetModules();
    const { toastSaveError } = await import("@/lib/stale-write-toast");
    const { staleWriteMessage } = await import("@/lib/stale-write");
    const reload = vi.fn();
    toastSaveError(new Error("Network down"), reload);
    expect(toast.error).toHaveBeenLastCalledWith("Network down");
    toastSaveError(new Error(staleWriteMessage("invoice")), reload);
    const [msg, opts] = toast.error.mock.calls.at(-1)!;
    expect(msg).toBe(staleWriteMessage("invoice"));
    expect(opts.action.label).toBe("Reload");
    opts.action.onClick();
    expect(reload).toHaveBeenCalledOnce();
    vi.doUnmock("sonner");
  });
});

describe("sameInstant", () => {
  it("compares to the microsecond across the two ways a stamp is printed", () => {
    expect(sameInstant("2026-11-02T10:00:00.123+00:00", "2026-11-02T10:00:00.123Z")).toBe(true);
    expect(
      sameInstant("2026-11-02T10:00:00.123456+00:00", "2026-11-02T10:00:00.123457+00:00"),
    ).toBe(false);
    expect(sameInstant("2026-11-02T05:00:00-05:00", "2026-11-02T10:00:00+00:00")).toBe(true);
    expect(sameInstant("2026-11-02 10:00:00.5+00", "2026-11-02T10:00:00.500Z")).toBe(true);
    expect(sameInstant(null, "2026-11-02T10:00:00Z")).toBe(false);
  });
});
