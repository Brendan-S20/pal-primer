// Pet sitting (#411), the pieces a working sitter flow was still missing:
//
//   1. A dispatcher books and confirms a stay at the service's price. Before
//      this, createStay, confirmStay and confirm_stay all asked for
//      manage_pricing, which #616 deliberately keeps from the front desk, so
//      the person the issue says books a stay could not.
//   2. A client adds a pet (a cat, a rabbit) from the portal's stay request.
//      Before this the whole form was replaced by "Contact the office to add a
//      pet" for a client with no pet on file.
//   3. A stay whose last visit was skipped or went missed still gets its
//      summary. It used to go out only from a COMPLETED visit.
//   4. "A sitter missed a medication" is listed once in notification
//      settings, and only to a business that runs pet sitting.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const state = vi.hoisted(() => ({
  role: "dispatcher" as string,
  rpc: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  touched: [] as string[],
  inserted: [] as Array<{ table: string; row: any }>,
  tables: {} as Record<string, any[]>,
  queued: [] as any[],
}));

/** A tiny query builder over state.tables: eq / in / is / gte / lte / neq /
 *  ilike filters, order, limit, single and maybeSingle. Enough for the
 *  handlers under test and nothing more. */
function makeDb() {
  return {
    from(table: string) {
      state.touched.push(table);
      const filters: Array<(r: any) => boolean> = [];
      let limit: number | null = null;
      let order: { col: string; asc: boolean } | null = null;
      let insertRow: any = null;
      const rows = () => {
        let out = (state.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        if (order) {
          const { col, asc } = order;
          out = [...out].sort((a, b) => (a[col] < b[col] ? -1 : 1) * (asc ? 1 : -1));
        }
        return limit == null ? out : out.slice(0, limit);
      };
      const q: any = {
        select: () => q,
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
        neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), q),
        in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), q),
        is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), q),
        gte: (c: string, v: string) => (filters.push((r) => r[c] >= v), q),
        lte: (c: string, v: string) => (filters.push((r) => r[c] <= v), q),
        ilike: (c: string, v: string) => (
          filters.push((r) => String(r[c]).toLowerCase() === v.replace(/\\/g, "").toLowerCase()),
          q
        ),
        order: (col: string, o?: { ascending?: boolean }) => (
          (order = { col, asc: o?.ascending !== false }),
          q
        ),
        limit: (n: number) => ((limit = n), q),
        insert: (row: any) => {
          insertRow = { id: `new-${table}`, ...row };
          state.inserted.push({ table, row });
          (state.tables[table] ??= []).push(insertRow);
          return q;
        },
        delete: () => q,
        update: () => q,
        upsert: async () => ({ error: null }),
        single: async () => ({ data: insertRow ?? rows()[0] ?? null, error: null }),
        maybeSingle: async () => ({ data: insertRow ?? rows()[0] ?? null, error: null }),
        then: (res: any) => Promise.resolve({ data: rows(), error: null }).then(res),
      };
      return q;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.rpc.push({ fn, args });
      if (fn === "confirm_stay") return { data: "invoice-1", error: null };
      if (fn === "stay_contact_gaps") return { data: [], error: null };
      return { data: null, error: null };
    },
  };
}

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (d: unknown) => unknown = (d) => d;
    const builder = {
      middleware: () => builder,
      inputValidator: (fn: typeof validate) => ((validate = fn), builder),
      handler:
        (fn: (a: { data: unknown; context: unknown }) => unknown) =>
        async (args?: { data: unknown }) =>
          fn({ data: validate(args?.data), context: { supabase: makeDb(), userId: "user-1" } }),
    };
    return builder;
  },
  createServerOnlyFn: (fn: unknown) => fn,
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    return makeDb();
  },
}));
vi.mock("@/lib/authz.server", async () => {
  const { hasPermission } = await import("@/lib/permissions");
  return {
    requirePermission: async (_s: unknown, _u: string, permission: any) => {
      if (!hasPermission(state.role as any, permission)) throw new Error("Not authorized");
      return { orgId: "org-1", role: state.role };
    },
    resolveCaller: async () => ({ orgId: "org-1", role: state.role }),
  };
});
vi.mock("@/lib/stay-notify.server", () => ({ notifyStayConfirmed: async () => {} }));
vi.mock("@/lib/overnight-clashes.server", () => ({ overnightClashWarning: async () => null }));
vi.mock("@/lib/activity.server", () => ({ logActivity: async () => {} }));
vi.mock("@/lib/portal-auth.server", () => ({
  requirePortalSession: async () => ({ organizationId: "org-1", clientId: "client-1" }),
}));
vi.mock("@/lib/service-line-availability.server", () => ({
  loadServiceLineAvailability: async () => ({
    bookable: ["pet_waste", "pet_sitting"],
    customerRequestable: ["pet_waste", "pet_sitting"],
  }),
}));
vi.mock("@/lib/portal-links.server", () => ({ buildPortalLink: async () => null }));
vi.mock("@/lib/email/enqueue.server", () => ({
  enqueueAppEmail: async (p: any) => {
    state.queued.push(p);
    return { ok: true };
  },
}));

import { createStay, stayPriceRefusal } from "@/lib/stays.functions";
import { confirmStay } from "@/lib/stay-booking.functions";
import { portalAddPet, portalPetRow } from "@/lib/portal-stays.functions";
import { sendSettledStaySummaries } from "@/lib/sit-report.server";
import { NOTIFICATION_TYPES, notificationTypesFor } from "@/lib/notifications-center.functions";
import { customerCanRequestStay } from "@/lib/service-lines";

const ids = {
  client: "00000000-0000-4000-8000-000000000001",
  property: "00000000-0000-4000-8000-000000000002",
  service: "00000000-0000-4000-8000-000000000003",
  pet: "00000000-0000-4000-8000-000000000004",
  stay: "00000000-0000-4000-8000-000000000005",
  token: "00000000-0000-4000-8000-000000000006",
};

const booking = {
  clientId: ids.client,
  propertyId: ids.property,
  serviceId: ids.service,
  startsOn: "2099-03-02",
  endsOn: "2099-03-07",
  windows: [],
  arrival: null,
  petIds: [ids.pet],
};

beforeEach(() => {
  state.role = "dispatcher";
  state.rpc = [];
  state.touched = [];
  state.inserted = [];
  state.queued = [];
  state.tables = {
    services: [
      {
        id: ids.service,
        organization_id: "org-1",
        service_line: "pet_sitting",
        price_unit: "night",
        base_price_cents: 7500,
        extra_pet_cents: 1000,
        default_duration_min: null,
        active: true,
      },
    ],
    clients: [{ id: ids.client, organization_id: "org-1", account_type: "residential" }],
    dogs: [
      { id: ids.pet, property_id: ids.property, name: "Biscuit", species: "dog", active: true },
    ],
    stays: [],
    organizations: [{ id: "org-1", service_lines: ["pet_sitting"] }],
    properties: [
      // The portal session (mocked above) is client-1.
      { id: ids.property, organization_id: "org-1", client_id: "client-1", archived_at: null },
    ],
  };
});

describe("a dispatcher books a stay at the set price", () => {
  it("refuses a typed price or deposit only to someone who cannot set prices", () => {
    expect(stayPriceRefusal(true, { priceCents: 100, depositCents: 100 })).toBeNull();
    expect(stayPriceRefusal(false, {})).toBeNull();
    expect(stayPriceRefusal(false, { priceCents: null, depositCents: null })).toBeNull();
    expect(stayPriceRefusal(false, { priceCents: 9000 })).toMatch(/service's price/);
    expect(stayPriceRefusal(false, { depositCents: 5000 })).toMatch(/deposit/);
  });

  it("books an overnight stay and leaves the price to confirm_stay", async () => {
    const r = await createStay({ data: booking });
    expect(r.kind).toBe("overnight");
    expect(r.visits).toBe(5); // Mon -> Sat is five nights
    const confirm = state.rpc.find((c) => c.fn === "confirm_stay");
    expect(confirm?.args).toEqual({ _stay_id: "new-stays" });
    const stay = state.inserted.find((i) => i.table === "stays")!.row;
    expect(stay.deposit_cents).toBeNull();
    expect(stay.assigned_staff_id).toBeNull();
  });

  it("refuses a dispatcher's typed price before anything is written", async () => {
    await expect(createStay({ data: { ...booking, priceCents: 1 } })).rejects.toThrow(
      /owner or office manager/,
    );
    await expect(createStay({ data: { ...booking, depositCents: 5000 } })).rejects.toThrow(
      /deposit/,
    );
    expect(state.touched).toEqual([]);
    expect(state.rpc).toEqual([]);
  });

  it("still sends an owner's price, as before", async () => {
    state.role = "owner";
    await createStay({ data: { ...booking, priceCents: 9900, depositCents: 2000 } });
    expect(state.rpc.find((c) => c.fn === "confirm_stay")?.args).toEqual({
      _stay_id: "new-stays",
      _price_cents: 9900,
    });
    expect(state.inserted.find((i) => i.table === "stays")!.row.deposit_cents).toBe(2000);
  });

  it("lets a dispatcher confirm a client's request, without a deposit", async () => {
    await confirmStay({ data: { stayId: ids.stay } });
    expect(state.rpc.find((c) => c.fn === "confirm_stay")?.args).toEqual({
      _stay_id: ids.stay,
      _deposit_cents: undefined,
    });
    state.rpc = [];
    await expect(confirmStay({ data: { stayId: ids.stay, depositCents: 100 } })).rejects.toThrow(
      /deposit/,
    );
    expect(state.rpc).toEqual([]);
  });

  it("does not let a tech book or confirm", async () => {
    state.role = "tech";
    await expect(createStay({ data: booking })).rejects.toThrow(/Not authorized/);
    await expect(confirmStay({ data: { stayId: ids.stay } })).rejects.toThrow(/Not authorized/);
  });

  it("holds the database to the same rule: confirm_stay changed in one block", () => {
    const before = read(
      "supabase/migrations/20261031130000_a-client-care-edit-waits-for-the-office.sql",
    );
    const after = read(
      "supabase/migrations/20261109120000_a-dispatcher-books-a-stay-at-the-set-price.sql",
    );
    const body = (sql: string) =>
      sql.slice(
        sql.indexOf("CREATE OR REPLACE FUNCTION public.confirm_stay"),
        sql.indexOf("GRANT EXECUTE ON FUNCTION public.confirm_stay"),
      );
    const newBlock = [
      "  -- manage_pricing, or booking at the set price (20261109120000).",
      "  IF NOT public.has_permission(auth.uid(), _st.organization_id, 'manage_pricing') THEN",
      "    IF NOT public.has_permission(auth.uid(), _st.organization_id, 'booking') THEN RAISE EXCEPTION 'Not authorized'; END IF;",
      "    IF _price_cents IS NOT NULL OR _deposit_cents IS NOT NULL OR _st.deposit_cents IS NOT NULL THEN",
      "      RAISE EXCEPTION 'Only an owner or office manager can set a stay''s price or deposit.' USING ERRCODE = 'insufficient_privilege';",
      "    END IF;",
      "  END IF;",
    ].join("\n");
    const oldLine =
      "  IF NOT public.has_permission(auth.uid(), _st.organization_id, 'manage_pricing') THEN RAISE EXCEPTION 'Not authorized'; END IF;";
    expect(body(after)).toContain(newBlock);
    expect(body(after).replace(newBlock, oldLine)).toBe(body(before));
    // No later file redefines it.
    expect(after).toContain(
      "REVOKE ALL ON FUNCTION public.confirm_stay(uuid, integer, integer) FROM PUBLIC, anon;",
    );
    expect(after).toMatch(/DO \$check\$[\s\S]*booking caller to the set price/);
  });

  it("shows a dispatcher the price, not a price field or a deposit", () => {
    const section = read("src/components/client-detail/StaysSection.tsx");
    expect(section).toContain('const canBook = can("booking")');
    expect(section).toContain('canConfirm={can("booking")}');
    expect(section).toMatch(/readOnly=\{!canSetPrices\}/);
    expect(section).toMatch(
      /\{canSetPrices && \(\s*<div className="min-w-0">\s*<Label htmlFor="stay-deposit">/,
    );
    const confirm = read("src/components/client-detail/ConfirmStayButton.tsx");
    expect(confirm).toMatch(/\{canSetDeposit && \(/);
    const queue = read("src/components/RequestedStays.tsx");
    expect(queue).toContain('can("booking") && (');
    expect(queue).toContain('canSetDeposit={can("manage_pricing")}');
  });
});

describe("a client adds a cat from the portal", () => {
  const add = (over: Record<string, unknown> = {}) =>
    portalAddPet({
      data: { token: ids.token, propertyId: ids.property, name: "Mochi", species: "cat", ...over },
    });

  it("keeps a note only for 'other'", () => {
    expect(portalPetRow({ name: " Mochi ", species: "cat", speciesNote: "tabby" })).toEqual({
      name: "Mochi",
      species: "cat",
      species_note: null,
    });
    expect(portalPetRow({ name: "Hops", species: "other", speciesNote: " rabbit " })).toEqual({
      name: "Hops",
      species: "other",
      species_note: "rabbit",
    });
  });

  it("adds the pet at the client's own home", async () => {
    expect(await add()).toEqual({ id: "new-dogs", added: true });
    expect(state.inserted).toEqual([
      {
        table: "dogs",
        row: {
          organization_id: "org-1",
          property_id: ids.property,
          name: "Mochi",
          species: "cat",
          species_note: null,
        },
      },
    ]);
  });

  it("returns the pet already on file instead of adding a twin", async () => {
    state.tables.dogs.push({
      id: "cat-1",
      property_id: ids.property,
      name: "mochi",
      species: "cat",
      active: true,
    });
    expect(await add()).toEqual({ id: "cat-1", added: false });
    expect(state.inserted).toEqual([]);
  });

  it("refuses another client's home", async () => {
    state.tables.properties[0].client_id = "someone-else";
    await expect(add()).rejects.toThrow(/your homes/);
    expect(state.inserted).toEqual([]);
  });

  it("leaves a business that does not run pet sitting as it was", async () => {
    state.tables.organizations[0].service_lines = ["pet_waste"];
    await expect(add()).rejects.toThrow(/Contact the office/);
    expect(state.inserted).toEqual([]);
  });

  it("is only offered where a stay can be requested", () => {
    expect(
      customerCanRequestStay({
        bookable: ["pet_waste"],
        customerRequestable: ["pet_waste"],
      } as any),
    ).toBe(false);
    const form = read("src/components/portal/Stays.tsx");
    expect(form).not.toContain("Contact the office to add a pet");
    expect(form).toContain("<PortalAddPet");
  });
});

describe("a stay that ended on a skipped visit still gets its summary", () => {
  const visit = (id: string, day: string, status: string) => ({
    id,
    subscription_id: "plan-1",
    organization_id: "org-1",
    client_id: ids.client,
    scheduled_on: day,
    status,
    started_at: null,
    completed_at: null,
    report_note: null,
    assigned_staff_id: null,
    services: { service_line: "pet_sitting" },
    organizations: { timezone: "America/Chicago" },
    subscriptions: {
      stays: {
        id: ids.stay,
        kind: "drop_in",
        starts_on: "2026-11-05",
        ends_on: "2026-11-07",
        pet_ids: [ids.pet],
      },
    },
    properties: {
      visit_contact_email: null,
      dogs: [{ id: ids.pet, name: "Biscuit", active: true }],
    },
  });

  beforeEach(() => {
    state.tables.stays = [
      { id: ids.stay, organization_id: "org-1", status: "confirmed", ends_on: "2026-11-07" },
    ];
    state.tables.subscriptions = [{ id: "plan-1", stay_id: ids.stay }];
    state.tables.care_log = [];
    state.tables.clients = [{ id: ids.client, portal_token: null }];
  });

  it("sends it once nothing is left to do, though the last visit was skipped", async () => {
    state.tables.visits = [
      visit("v1", "2026-11-05", "completed"),
      visit("v2", "2026-11-06", "completed"),
      visit("v3", "2026-11-07", "skipped"),
    ];
    expect(await sendSettledStaySummaries("org-1", "2026-11-08")).toBe(1);
    expect(state.queued).toHaveLength(1);
    expect(state.queued[0]).toMatchObject({
      templateName: "stay-summary",
      idempotencyKey: `stay-summary-${ids.stay}`,
      oncePerKey: true,
      templateData: { visitsDone: 2, visitsTotal: 3 },
    });
  });

  it("waits while a visit is still scheduled", async () => {
    state.tables.visits = [
      visit("v1", "2026-11-05", "completed"),
      visit("v2", "2026-11-06", "scheduled"),
      visit("v3", "2026-11-07", "missed"),
    ];
    expect(await sendSettledStaySummaries("org-1", "2026-11-08")).toBe(0);
    expect(state.queued).toEqual([]);
  });

  it("runs from the nightly job after missed visits are settled, for sitting businesses", () => {
    const nightly = read("src/routes/api/public/hooks/nightly.ts");
    const missed = nightly.indexOf('"admin_transition_missed_visits"');
    const summary = nightly.indexOf("sendSettledStaySummaries(org.id, todayStr)");
    expect(missed).toBeGreaterThan(0);
    expect(summary).toBeGreaterThan(missed);
    const gate = nightly.lastIndexOf('if (org.service_lines?.includes("pet_sitting"))', summary);
    expect(gate).toBeGreaterThan(missed);
  });
});

describe("the missed medication switch", () => {
  it("is listed once", () => {
    const types = NOTIFICATION_TYPES.map((t) => t.type);
    expect(types.filter((t) => t === "missed_meds")).toHaveLength(1);
    expect(new Set(types).size).toBe(types.length);
  });

  it("is offered only to a business that runs pet sitting", () => {
    expect(notificationTypesFor(["pet_waste"]).map((t) => t.type)).not.toContain("missed_meds");
    expect(notificationTypesFor(["pet_waste", "pet_sitting"]).map((t) => t.type)).toContain(
      "missed_meds",
    );
    expect(notificationTypesFor(["pet_waste"])).toHaveLength(NOTIFICATION_TYPES.length - 1);
  });
});
