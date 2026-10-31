import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hasPermission } from "@/lib/permissions";
import {
  oneOffGridPriceCents,
  NO_ONE_OFF_PRICE,
  NO_SERVICE_PRICE,
} from "@/lib/booking-price.server";

// #616: the front desk could not book. Book a groom, Book a visit and the
// Schedule's one-off all asked for manage_pricing, which a dispatcher does not
// hold. Booking is now its own permission. The price is the part that stays
// manage_pricing: a dispatcher books at the set price, and is refused only
// when the price differs from it.
//
// The handlers run here against fakes. Nothing reaches a real Supabase.

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

const USER_DB = { who: "the signed-in user's client" };
const ADMIN_DB = { who: "the service role" };

const state = vi.hoisted(() => ({
  role: "dispatcher" as string,
  grid: { cents: 4500, reason: null } as { cents: number | null; reason: string | null },
  bookOneOff: vi.fn(),
  bookGroom: vi.fn(),
}));

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (data: unknown) => unknown = (data) => data;
    const builder = {
      middleware: () => builder,
      inputValidator: (fn: typeof validate) => {
        validate = fn;
        return builder;
      },
      handler:
        (fn: (args: { data: unknown; context: unknown }) => unknown) =>
        async (args?: { data: unknown }) =>
          fn({ data: validate(args?.data), context: { supabase: USER_DB, userId: "user-1" } }),
    };
    return builder;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: ADMIN_DB }));
vi.mock("@/lib/authz.server", async () => {
  const { hasPermission: can } = await import("@/lib/permissions");
  return {
    resolveCaller: async () => ({ orgId: "org-1", role: state.role }),
    requirePermission: async (_db: unknown, _user: string, permission: any) => {
      if (!can(state.role as any, permission)) throw new Error("Not authorized");
      return { orgId: "org-1", role: state.role };
    },
  };
});
vi.mock("@/lib/booking-price.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/booking-price.server")>();
  return {
    ...real,
    oneOffGridPriceCents: vi.fn(async (db: unknown, input: any) =>
      input.__real ? real.oneOffGridPriceCents(db, input) : state.grid,
    ),
  };
});
vi.mock("@/lib/one-off-visit.server", () => ({ bookOneOffVisit: state.bookOneOff }));
vi.mock("@/lib/groom-booking.server", () => ({ bookGroomAppointment: state.bookGroom }));

const { createOneOffVisit } = await import("@/lib/visits.functions");
const { bookGroom } = await import("@/lib/groom-booking.functions");

const CLIENT = "11111111-1111-4111-8111-111111111111";
const PROPERTY = "22222222-2222-4222-8222-222222222222";
const SERVICE = "33333333-3333-4333-8333-333333333333";
const PET = "44444444-4444-4444-8444-444444444444";

const oneOff = (extra: Record<string, unknown> = {}) =>
  createOneOffVisit({
    data: { clientId: CLIENT, propertyId: PROPERTY, scheduledOn: "2026-11-02", ...extra },
  } as any);
const groom = () =>
  bookGroom({
    data: {
      clientId: CLIENT,
      propertyId: PROPERTY,
      serviceId: SERVICE,
      petIds: [PET],
      addons: [],
      scheduledOn: "2026-11-02",
      startTime: "09:30",
      everyWeeks: 6,
      staffId: null,
      parkingNotes: null,
      acknowledgeWarning: false,
    },
  } as any);

beforeEach(() => {
  state.role = "dispatcher";
  state.grid = { cents: 4500, reason: null };
  state.bookOneOff.mockReset().mockResolvedValue({
    visitId: "v",
    subscriptionId: "s",
    scheduledOn: "2026-11-02",
    assigned: false,
    assignWarning: null,
  });
  state.bookGroom.mockReset().mockResolvedValue({ visitId: "v" });
});

describe("the booking permission", () => {
  it("is held by dispatcher, owner and office manager, and not by a tech", () => {
    expect(hasPermission("dispatcher", "booking")).toBe(true);
    expect(hasPermission("owner", "booking")).toBe(true);
    expect(hasPermission("office_manager", "booking")).toBe(true);
    expect(hasPermission("tech", "booking")).toBe(false);
  });

  it("does not bring a price with it", () => {
    expect(hasPermission("dispatcher", "manage_pricing")).toBe(false);
    expect(hasPermission("owner", "manage_pricing")).toBe(true);
    expect(hasPermission("office_manager", "manage_pricing")).toBe(true);
  });
});

describe("a dispatcher's one-off", () => {
  it("books at the set price when no price is sent", async () => {
    await oneOff({ staffId: null });
    const [db, input] = state.bookOneOff.mock.calls[0];
    expect(input.priceCents).toBe(4500);
    expect(input.actorUserId).toBe("user-1");
    // The plan is written past the manage_pricing policy, and the tech is
    // assigned as the person.
    expect(db).toBe(ADMIN_DB);
    expect(input.asService).toBe(true);
    expect(input.assignDb).toBe(USER_DB);
  });

  it("books when the price sent is the set price", async () => {
    await oneOff({ priceCents: 4500 });
    expect(state.bookOneOff.mock.calls[0][1].priceCents).toBe(4500);
  });

  it("is refused when the price differs, and nothing is booked", async () => {
    await expect(oneOff({ priceCents: 0 })).rejects.toThrow(
      "Only someone who sets prices can change this price. The set price is $45.00.",
    );
    await expect(oneOff({ priceCents: 9900 })).rejects.toThrow("The set price is $45.00");
    expect(state.bookOneOff).not.toHaveBeenCalled();
  });

  it("is refused, and says why, when the business has no set price", async () => {
    state.grid = { cents: null, reason: NO_ONE_OFF_PRICE };
    await expect(oneOff()).rejects.toThrow(NO_ONE_OFF_PRICE);
    expect(state.bookOneOff).not.toHaveBeenCalled();
  });
});

describe("an owner's and an office manager's one-off, as before", () => {
  it.each(["owner", "office_manager"])("%s types any price, on their own client", async (role) => {
    state.role = role;
    await oneOff({ priceCents: 0 });
    const [db, input] = state.bookOneOff.mock.calls[0];
    expect(db).toBe(USER_DB);
    expect(input.priceCents).toBe(0);
    expect(input.asService).toBeUndefined();
    expect(input.assignDb).toBeUndefined();
  });

  it("a tech still cannot book", async () => {
    state.role = "tech";
    await expect(oneOff({ priceCents: 4500 })).rejects.toThrow("Not authorized");
  });
});

describe("a groom, which takes no price from anyone", () => {
  it("a dispatcher books one, and a repeat, through the service role", async () => {
    await groom();
    const [db, input] = state.bookGroom.mock.calls[0];
    expect(db).toBe(ADMIN_DB);
    expect(input).toMatchObject({ asService: true, assignDb: USER_DB, everyWeeks: 6 });
    expect(input).not.toHaveProperty("priceCents");
  });

  it.each(["owner", "office_manager"])("%s books on their own client, as before", async (role) => {
    state.role = role;
    await groom();
    const [db, input] = state.bookGroom.mock.calls[0];
    expect(db).toBe(USER_DB);
    expect(input.asService).toBeUndefined();
  });

  it("a tech still cannot book one", async () => {
    state.role = "tech";
    await expect(groom()).rejects.toThrow("Not authorized");
  });
});

describe("the set price of a one-off", () => {
  type Rows = Record<string, any>;
  const fakeDb = (rows: Rows) => ({
    from(table: string) {
      const chain: any = {};
      for (const f of ["select", "eq", "not"]) chain[f] = () => chain;
      chain.maybeSingle = async () => ({ data: rows[table] ?? null, error: null });
      chain.then = (res: any) => res({ count: rows[`${table}.count`] ?? 0, error: null });
      return chain;
    },
  });
  const price = (rows: Rows, serviceId?: string) =>
    oneOffGridPriceCents(fakeDb(rows), {
      orgId: "org-1",
      propertyId: PROPERTY,
      serviceId,
      __real: true,
    } as any);

  it("is the business's one-off price for pet waste, or for no service named", async () => {
    expect(await price({ organizations: { one_off_price_cents: 3500 } })).toEqual({
      cents: 3500,
      reason: null,
    });
    const waste = {
      id: SERVICE,
      organization_id: "org-1",
      active: true,
      service_line: "pet_waste",
    };
    expect(
      await price({ services: waste, organizations: { one_off_price_cents: 3500 } }, SERVICE),
    ).toEqual({ cents: 3500, reason: null });
  });

  it("is nothing, with the reason, when the business never set one", async () => {
    expect(await price({ organizations: { one_off_price_cents: null } })).toEqual({
      cents: null,
      reason: NO_ONE_OFF_PRICE,
    });
  });

  it("is the service's own price for the property's dogs otherwise", async () => {
    const walk = {
      id: SERVICE,
      organization_id: "org-1",
      active: true,
      service_line: "dog_walking",
      price_unit: "visit",
      base_price_cents: 2500,
      extra_pet_cents: 500,
      default_duration_min: 30,
    };
    const prop = {
      id: PROPERTY,
      organization_id: "org-1",
      client: { account_type: "residential" },
    };
    expect(await price({ services: walk, properties: prop, "dogs.count": 3 }, SERVICE)).toEqual({
      cents: 3500,
      reason: null,
    });
    expect(
      await price({ services: { ...walk, base_price_cents: null }, properties: prop }, SERVICE),
    ).toEqual({ cents: null, reason: NO_SERVICE_PRICE });
  });

  it("refuses another business's service", async () => {
    await expect(
      price({ services: { id: SERVICE, organization_id: "org-2", active: true } }, SERVICE),
    ).rejects.toThrow("That service is not offered");
  });
});

describe("the screens and the words", () => {
  it("shows Book a groom, Book a visit and the one-off to whoever holds booking", () => {
    for (const file of [
      "src/components/client-detail/VisitsTab.tsx",
      "src/routes/_authenticated/routes.tsx",
      "src/components/CreateSheet.tsx",
    ]) {
      const src = read(file);
      expect(src, file).toMatch(/const canBookOneOff = (can|canDo)\("booking"\);/);
    }
  });

  it("the dialog lets only a price setter type a price", () => {
    const dialog = read("src/components/OneOffVisitDialog.tsx");
    expect(dialog).toContain('const setsPrices = can("manage_pricing");');
    expect(dialog).toContain("readOnly");
  });

  it("the groom dialog's reads ask for booking, not pricing", () => {
    const fns = read("src/lib/groom-booking.functions.ts");
    expect(fns.match(/requirePermission\([^)]*"booking"\)/g)).toHaveLength(3);
    expect(fns).not.toMatch(/requirePermission\([^)]*"manage_pricing"\)/);
  });

  it("the Roles help page says what a dispatcher can actually do", () => {
    const help = read("src/lib/help-content.ts");
    expect(help).toContain(
      "A dispatcher books one-off visits and grooms at the prices the business has set; only an owner or office manager can change a price.",
    );
  });

  it("the plan write policy is not widened", () => {
    const sql = read("supabase/migrations/20261031140000_a-dispatcher-books-at-the-set-price.sql");
    expect(sql).not.toMatch(/CREATE POLICY|ALTER POLICY|DROP POLICY/i);
    expect(sql).toContain(
      "(ur.role = 'dispatcher' AND _permission IN ('view_client_directory', 'record_field_addons', 'booking'))",
    );
  });
});
