// The service catalog (phase 1 of docs/other-trades-service-catalog.md):
// the rules in src/lib/services.ts, the server functions in
// src/lib/services.functions.ts, and the wiring that makes Settings → Services
// a page somebody can reach.
//
// The database half -- RLS, two-step sign-in, the seed -- is proved against a
// real Postgres by tests/a-walk-is-not-a-cleanup-in-a-real-database.test.ts.
// Nothing here can reach a database: the Supabase client below is a fake
// that records what it was asked.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PRICE_UNITS,
  centsToDollarInput,
  defaultServiceLine,
  defaultServiceSeedsFor,
  durationRequired,
  parseDollarsToCents,
  priceUnitsFor,
  serviceDurationLabel,
  serviceLineChoices,
  servicePriceCents,
  servicePriceLabel,
  serviceProblem,
  sortServices,
  type ServiceDraft,
} from "@/lib/services";
import { SERVICE_LINES } from "@/lib/service-lines";
import { ROUTE_ROLES, canAccess } from "@/hooks/useMyRole";
import { hasPermission } from "@/lib/permissions";
import { APP_LINK_PATH_PREFIXES, appLinkClaims } from "@/lib/android-app-links";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

// ── Server functions without the framework ──────────────────────────────────
// The builder collapses to "validate, then run the handler with this context",
// which is what TanStack Start does once the auth middleware has run.
let context: { supabase: unknown; userId: string } = { supabase: null, userId: "" };
vi.mock("@tanstack/react-start", () => ({
  createServerOnlyFn: (fn: unknown) => fn,
  createServerFn: () => {
    let validate: (d: unknown) => unknown = (d) => d;
    const b: any = {
      middleware: () => b,
      inputValidator: (v: (d: unknown) => unknown) => ((validate = v), b),
      handler:
        (h: (ctx: { data: unknown; context: unknown }) => unknown) =>
        async (opts: { data?: unknown } = {}) =>
          h({ data: validate(opts.data), context }),
    };
    return b;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/lib/impersonation-session.server", () => ({
  assertImpersonationSessionActive: async () => {},
}));

type Call = { table: string; op: string; args: unknown[] };

/** A Supabase client that answers user_roles with `role` in org-a, and
 *  services with whatever `answer` says, recording every call. */
function fakeSupabase(role: string, answer: { data?: unknown; error?: unknown } = {}) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const q: any = {};
      const rec =
        (op: string) =>
        (...args: unknown[]) => {
          calls.push({ table, op, args });
          return q;
        };
      for (const op of ["select", "insert", "update", "delete", "eq", "order"]) q[op] = rec(op);
      q.maybeSingle = async () =>
        table === "user_roles"
          ? { data: { organization_id: "org-a", role }, error: null }
          : { data: null, error: null };
      q.single = async () => ({ data: answer.data ?? null, error: answer.error ?? null });
      q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve({ data: answer.data ?? null, error: answer.error ?? null }).then(res, rej);
      return q;
    },
    // resolveCaller also asks access_turned_off() (#378, off means off). Nobody
    // here is turned off, so it answers with no business.
    async rpc(fn: string) {
      calls.push({ table: `rpc:${fn}`, op: "rpc", args: [] });
      return { data: [], error: null };
    },
  };
  return { client, calls };
}

const WALK: ServiceDraft = {
  name: "30-minute walk",
  service_line: "dog_walking",
  price_unit: "visit",
  base_price_cents: 2500,
  extra_pet_cents: 500,
  default_duration_min: 30,
};

const ID = "11111111-1111-4111-8111-111111111111";

describe("pricing: both, business chooses", () => {
  it("offers flat and hourly on every line, and nightly only for sitting", () => {
    for (const line of SERVICE_LINES) {
      expect(priceUnitsFor(line)).toContain("visit");
      expect(priceUnitsFor(line)).toContain("hour");
      expect(priceUnitsFor(line).includes("night")).toBe(line === "pet_sitting");
    }
    expect(PRICE_UNITS).toEqual(["visit", "hour", "night"]);
  });

  it("prices a flat visit, with each extra pet on top", () => {
    expect(servicePriceCents(WALK)).toBe(2500);
    expect(servicePriceCents(WALK, { pets: 3 })).toBe(3500);
    // Nonsense pet counts read as one pet, never as a discount.
    expect(servicePriceCents(WALK, { pets: 0 })).toBe(2500);
  });

  it("prices hourly by the minute and rounds once, at the end", () => {
    const hourly = {
      ...WALK,
      price_unit: "hour" as const,
      base_price_cents: 2000,
      extra_pet_cents: 0,
    };
    expect(servicePriceCents(hourly, { minutes: 45 })).toBe(1500);
    // Falls back to the service's own duration.
    expect(servicePriceCents(hourly)).toBe(1000);
    // $20.01/hour for 20 minutes is 667 cents, not two rounded thirds.
    expect(servicePriceCents({ ...hourly, base_price_cents: 2001 }, { minutes: 20 })).toBe(667);
    // No duration anywhere is no price, not $0.
    expect(servicePriceCents({ ...hourly, default_duration_min: null })).toBeNull();
  });

  it("prices nightly per night, extra pets per night", () => {
    const stay = {
      price_unit: "night" as const,
      base_price_cents: 6000,
      extra_pet_cents: 1500,
      default_duration_min: 720,
    };
    expect(servicePriceCents(stay, { nights: 3, pets: 2 })).toBe(22500);
  });

  it("has no price of its own when none is set (pet waste is priced by zone)", () => {
    expect(servicePriceCents({ ...WALK, base_price_cents: null })).toBeNull();
    expect(servicePriceLabel({ ...WALK, service_line: "pet_waste", base_price_cents: null })).toBe(
      "Priced by your zones",
    );
    expect(servicePriceLabel({ ...WALK, base_price_cents: null })).toBe("No price yet");
  });

  it("reads the way an owner would say it", () => {
    expect(servicePriceLabel(WALK)).toBe("$25.00 per visit, +$5.00 per extra pet");
    expect(servicePriceLabel({ ...WALK, price_unit: "hour", extra_pet_cents: 0 })).toBe(
      "$25.00 per hour",
    );
    expect(serviceDurationLabel(30)).toBe("30 min");
    expect(serviceDurationLabel(60)).toBe("1 hr");
    expect(serviceDurationLabel(90)).toBe("1 hr 30 min");
    expect(serviceDurationLabel(null)).toBeNull();
  });

  it("reads dollars as typed and refuses what is not an amount", () => {
    expect(parseDollarsToCents("25")).toBe(2500);
    expect(parseDollarsToCents("25.5")).toBe(2550);
    expect(parseDollarsToCents("10.00")).toBe(1000);
    expect(parseDollarsToCents(" $1,250.00 ")).toBe(125000);
    expect(parseDollarsToCents(".75")).toBe(75);
    expect(parseDollarsToCents("")).toBeNull();
    for (const bad of ["-5", "1.234", "abc", "1e3", "12.3.4"]) {
      expect(parseDollarsToCents(bad), bad).toBeNaN();
    }
    expect(centsToDollarInput(2550)).toBe("25.50");
    expect(centsToDollarInput(null)).toBe("");
  });
});

describe("what makes a service saveable", () => {
  it("accepts a priced walk, an unpriced one, and a zone-priced cleanup with no duration", () => {
    expect(serviceProblem(WALK)).toBeNull();
    expect(serviceProblem({ ...WALK, base_price_cents: null })).toBeNull();
    expect(
      serviceProblem({
        ...WALK,
        name: "Pet waste removal",
        service_line: "pet_waste",
        base_price_cents: null,
        default_duration_min: null,
      }),
    ).toBeNull();
  });

  it("refuses each thing the database would, as a sentence", () => {
    expect(serviceProblem({ ...WALK, name: "   " })).toMatch(/name/);
    expect(serviceProblem({ ...WALK, name: "x".repeat(81) })).toMatch(/80/);
    expect(serviceProblem({ ...WALK, price_unit: "night" })).toMatch(/pet sitting/);
    expect(serviceProblem({ ...WALK, base_price_cents: -1 })).toMatch(/zero or more/);
    expect(serviceProblem({ ...WALK, extra_pet_cents: 10_000_001 })).toMatch(/more than/);
    expect(serviceProblem({ ...WALK, default_duration_min: null })).toMatch(/how long/);
    expect(serviceProblem({ ...WALK, default_duration_min: 721 })).toMatch(/between/);
    expect(serviceProblem({ ...WALK, service_line: "lawn_care" as any })).toMatch(/kind/);
  });

  it("asks for a duration on every line but pet waste", () => {
    for (const line of SERVICE_LINES) expect(durationRequired(line)).toBe(line !== "pet_waste");
  });

  it("lets a per-night sitting service omit a minute length", () => {
    expect(
      serviceProblem({
        ...WALK,
        name: "Overnight stay",
        service_line: "pet_sitting",
        price_unit: "night",
        default_duration_min: null,
      }),
    ).toBeNull();
    expect(
      serviceProblem({
        ...WALK,
        name: "House sit",
        service_line: "pet_sitting",
        price_unit: "night",
        default_duration_min: null,
      }),
    ).toBeNull();
    expect(
      serviceProblem({
        ...WALK,
        name: "Drop-in (30 min)",
        service_line: "pet_sitting",
        price_unit: "visit",
        default_duration_min: null,
      }),
    ).toMatch(/how long/);
  });

  it("offers every live line, keeps an old service's line, and starts on the business's first", () => {
    // Walking and sitting are Coming soon, so only a business that already
    // runs one, or a service already on it, is offered it.
    expect(serviceLineChoices(["pet_waste"])).toEqual(["pet_waste"]);
    expect(serviceLineChoices(["pet_waste"])).not.toContain("pet_sitting");
    expect(serviceLineChoices(["pet_waste", "dog_walking"])).toEqual(["pet_waste", "dog_walking"]);
    expect(serviceLineChoices(["pet_waste"], "pet_sitting")).toEqual(["pet_waste", "pet_sitting"]);
    expect(serviceLineChoices(["pet_sitting"])).toContain("pet_sitting");
    expect(serviceLineChoices(["pet_waste"], "pet_sitting")).toContain("pet_sitting");
    expect(serviceLineChoices(["mobile_grooming"])).toContain("mobile_grooming");
    expect(serviceLineChoices(["pet_waste"], "other")).toContain("other");
    expect(defaultServiceLine(["dog_walking", "pet_waste"])).toBe("dog_walking");
    expect(defaultServiceLine([])).toBe("pet_waste");
  });

  it("seeds every selected launch line once, with blank prices", () => {
    const seeds = defaultServiceSeedsFor([
      "dog_walking",
      "pet_sitting",
      "mobile_grooming",
      "training",
    ]);
    expect(seeds.map((s) => s.name)).toEqual([
      "30-minute walk",
      "60-minute walk",
      "Drop-in visit (20 min)",
      "Drop-in (30 min)",
      "Overnight stay",
      "House sit",
      "Bath and brush (60 min)",
      "Full groom (90 min)",
      "Nail trim (15 min)",
      "Private lesson (60 min)",
      "Training package (4 sessions)",
    ]);
    expect(seeds.every((s) => s.base_price_cents === null)).toBe(true);
    expect(seeds.find((s) => s.name === "Private lesson (60 min)")).toMatchObject({
      service_line: "training",
      default_duration_min: 60,
    });
  });

  it("lists active services first, then by line, then by name", () => {
    const rows = [
      { name: "Z groom", service_line: "mobile_grooming" as const, active: true },
      { name: "Old walk", service_line: "dog_walking" as const, active: false },
      { name: "B walk", service_line: "dog_walking" as const, active: true },
      { name: "A walk", service_line: "dog_walking" as const, active: true },
      { name: "Pet waste removal", service_line: "pet_waste" as const, active: true },
    ];
    expect(sortServices(rows).map((r) => r.name)).toEqual([
      "Pet waste removal",
      "A walk",
      "B walk",
      "Z groom",
      "Old walk",
    ]);
  });
});

describe("the server functions", () => {
  beforeEach(() => {
    context = { supabase: null, userId: "user-1" };
  });

  it("lists the caller's own business, active only unless asked", async () => {
    const { listServices } = await import("@/lib/services.functions");
    const fake = fakeSupabase("tech", { data: [] });
    context.supabase = fake.client;
    await (listServices as any)({ data: {} });
    const eqs = fake.calls.filter((c) => c.table === "services" && c.op === "eq");
    expect(eqs.map((c) => c.args)).toEqual([
      ["organization_id", "org-a"],
      ["active", true],
    ]);

    const all = fakeSupabase("tech", { data: [] });
    context.supabase = all.client;
    await (listServices as any)({ data: { includeInactive: true } });
    expect(
      all.calls.filter((c) => c.table === "services" && c.op === "eq").map((c) => c.args),
    ).toEqual([["organization_id", "org-a"]]);
  });

  it.each(["tech", "dispatcher"])("refuses a %s before anything is written", async (role) => {
    const { createService, updateService, setServiceActive } =
      await import("@/lib/services.functions");
    const fake = fakeSupabase(role, { data: { id: ID } });
    context.supabase = fake.client;
    await expect((createService as any)({ data: WALK })).rejects.toThrow("Not authorized");
    await expect((updateService as any)({ data: { id: ID, ...WALK } })).rejects.toThrow(
      "Not authorized",
    );
    await expect((setServiceActive as any)({ data: { id: ID, active: false } })).rejects.toThrow(
      "Not authorized",
    );
    expect(fake.calls.filter((c) => c.table === "services")).toEqual([]);
  });

  it("writes into the caller's business, whatever business the body names", async () => {
    const { createService } = await import("@/lib/services.functions");
    const fake = fakeSupabase("office_manager", { data: { id: ID } });
    context.supabase = fake.client;
    const out = await (createService as any)({
      data: { ...WALK, name: "  30-minute walk  ", organization_id: "org-b", active: false },
    });
    expect(out).toEqual({ id: ID });
    const insert = fake.calls.find((c) => c.table === "services" && c.op === "insert");
    expect(insert?.args[0]).toEqual({
      ...WALK,
      name: "30-minute walk",
      max_dogs: null,
      holiday_surcharge_pct: 0,
      organization_id: "org-a",
      active: true,
    });
  });

  it("scopes an edit and a deactivation to the caller's business", async () => {
    const { updateService, setServiceActive } = await import("@/lib/services.functions");
    const fake = fakeSupabase("owner", { data: [{ id: ID }] });
    context.supabase = fake.client;
    await (updateService as any)({ data: { id: ID, ...WALK, price_unit: "hour" } });
    await (setServiceActive as any)({ data: { id: ID, active: false } });
    const services = fake.calls.filter((c) => c.table === "services");
    const updates = services.filter((c) => c.op === "update").map((c) => c.args[0]);
    expect(updates[0]).toMatchObject({ price_unit: "hour" });
    expect(updates[0]).not.toHaveProperty("organization_id");
    expect(updates[1]).toEqual({ active: false });
    expect(services.filter((c) => c.op === "eq").map((c) => c.args)).toEqual([
      ["id", ID],
      ["organization_id", "org-a"],
      ["id", ID],
      ["organization_id", "org-a"],
    ]);
    // There is no delete: a sold service is deactivated.
    expect(services.some((c) => c.op === "delete")).toBe(false);
  });

  it("says so when the service is not the caller's to change", async () => {
    const { setServiceActive } = await import("@/lib/services.functions");
    const fake = fakeSupabase("owner", { data: [] });
    context.supabase = fake.client;
    await expect((setServiceActive as any)({ data: { id: ID, active: false } })).rejects.toThrow(
      /not found/,
    );
  });

  it("refuses a nightly walk and a walk with no duration before asking the database", async () => {
    const { createService } = await import("@/lib/services.functions");
    const fake = fakeSupabase("owner", { data: { id: ID } });
    context.supabase = fake.client;
    await expect(
      (createService as any)({ data: { ...WALK, price_unit: "night" } }),
    ).rejects.toThrow(/pet sitting/);
    await expect(
      (createService as any)({ data: { ...WALK, default_duration_min: null } }),
    ).rejects.toThrow(/how long/);
    expect(fake.calls).toEqual([]);
  });

  it("turns a duplicate name into a sentence", async () => {
    const { createService } = await import("@/lib/services.functions");
    const fake = fakeSupabase("owner", {
      error: {
        code: "23505",
        message: 'duplicate key value violates unique constraint "services_org_name"',
      },
    });
    context.supabase = fake.client;
    await expect((createService as any)({ data: WALK })).rejects.toThrow(
      "You already have a service with that name.",
    );
  });

  it("asks for the permission the database asks for", () => {
    const src = read("src/lib/services.functions.ts");
    expect(src.match(/requirePermission\([^)]*"manage_pricing"\)/g)?.length).toBe(3);
    expect(hasPermission("owner", "manage_pricing")).toBe(true);
    expect(hasPermission("office_manager", "manage_pricing")).toBe(true);
    expect(hasPermission("dispatcher", "manage_pricing")).toBe(false);
    expect(hasPermission("tech", "manage_pricing")).toBe(false);
  });
});

describe("the wiring", () => {
  const migration = read("supabase/migrations/20261009200000_a-walk-is-not-a-cleanup.sql");

  it("gives the table two-step sign-in and a manage_pricing write gate", () => {
    expect(migration).toMatch(/SELECT public\.require_mfa_policy\('public\.services'\);/);
    expect(migration).toMatch(/'manage_pricing'::text/);
    expect(migration).not.toMatch(/GRANT[^;]*DELETE[^;]*TO authenticated/i);
  });

  it("seeds over whatever organizations exist and never counts them", () => {
    expect(migration).toMatch(
      /INSERT INTO public\.services[\s\S]*SELECT[\s\S]*FROM public\.organizations o/,
    );
    expect(migration).toMatch(/ON CONFLICT \(organization_id, lower\(name\)\) DO NOTHING/);
    // The only count compared in the check block is of organizations MISSING
    // the service, which is zero on any database, empty or not.
    expect(migration).not.toMatch(
      /count\(\*\)[^;]*FROM public\.organizations[^;]*\)\s*(<>|=|<|>)\s*[1-9]/,
    );
  });

  it("is an office page: owner and office manager, not dispatcher or tech", () => {
    expect(ROUTE_ROLES["/settings/services"]).toEqual(["owner", "office_manager"]);
    expect(canAccess("owner", "/settings/services")).toBe(true);
    expect(canAccess("office_manager", "/settings/services")).toBe(true);
    expect(canAccess("tech", "/settings/services")).toBe(false);
    expect(canAccess("dispatcher", "/settings/services")).toBe(false);
  });

  it("is in the Settings nav and the command palette", () => {
    expect(read("src/routes/_authenticated/settings.tsx")).toMatch(
      /\{ label: "Services", to: "\/settings\/services" \}/,
    );
    expect(read("src/components/CommandPalette.tsx")).toMatch(
      /label: "Services", to: "\/settings\/services"/,
    );
  });

  it("opens in the Android app, like the other settings pages", () => {
    expect(APP_LINK_PATH_PREFIXES).toContain("/settings/services");
    expect(appLinkClaims("/settings/services")).toBe(true);
    expect(read("android/app/src/main/AndroidManifest.xml")).toContain(
      '<data android:pathPrefix="/settings/services" />',
    );
  });
});
