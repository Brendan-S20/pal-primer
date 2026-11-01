import { beforeEach, describe, expect, it, vi } from "vitest";

let context: { supabase: unknown; userId: string };
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate = (data: unknown): unknown => data;
    const builder: any = {
      middleware: () => builder,
      inputValidator: (v: typeof validate) => {
        validate = v;
        return builder;
      },
      handler:
        (handler: any) =>
        async ({ data }: { data: unknown }) =>
          handler({ data: validate(data), context }),
    };
    return builder;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/lib/impersonation-session.server", () => ({
  assertImpersonationSessionActive: async () => {},
}));

import {
  deleteServiceSizeRule,
  listServiceSizeRules,
  sizeRuleSchema,
  upsertServiceSizeRule,
} from "@/lib/groom.functions";
import { upsertAddonService } from "@/lib/addons.functions";
import { COAT_TYPES, PET_SIZES } from "@/lib/groom";

const serviceId = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const draft = {
  serviceId,
  size: "small" as const,
  coatType: null,
  durationMin: 60,
  priceCents: 6000,
};

function fake(role = "owner", line = "mobile_grooming", found = true) {
  const calls: { table: string; op: string; args: unknown[] }[] = [];
  const supabase = {
    from(table: string) {
      const q: any = {};
      for (const op of ["select", "eq", "upsert", "insert", "update", "delete"])
        q[op] = (...args: unknown[]) => {
          calls.push({ table, op, args });
          return q;
        };
      q.maybeSingle = async () => ({
        data:
          table === "user_roles"
            ? { organization_id: "org-a", role }
            : found
              ? { id: serviceId, service_line: line }
              : null,
        error: null,
      });
      q.single = async () => ({ data: { id }, error: null });
      q.then = (resolve: any, reject: any) =>
        Promise.resolve({ data: [], error: null }).then(resolve, reject);
      return q;
    },
    rpc: async () => ({ data: [], error: null }),
  };
  context = { supabase, userId: "owner-a" };
  return calls;
}
beforeEach(() => fake());

describe("size rule validation", () => {
  it("accepts every size and coat including the any-coat rule", () => {
    for (const size of PET_SIZES)
      for (const coatType of [null, ...COAT_TYPES])
        expect(sizeRuleSchema.safeParse({ ...draft, size, coatType }).success).toBe(true);
    expect(
      sizeRuleSchema.safeParse({ ...draft, durationMin: 720, priceCents: 10_000_000 }).success,
    ).toBe(true);
    expect(sizeRuleSchema.safeParse({ ...draft, durationMin: 1, priceCents: 0 }).success).toBe(
      true,
    );
  });
  it.each([
    { durationMin: 0 },
    { durationMin: 721 },
    { durationMin: 1.5 },
    { priceCents: -1 },
    { priceCents: 10_000_001 },
    { priceCents: 1.5 },
    { size: "giant" },
    { coatType: "silky" },
    { serviceId: "bad" },
  ])("refuses values outside the database checks: %j", (patch) => {
    expect(sizeRuleSchema.safeParse({ ...draft, ...patch }).success).toBe(false);
  });
});

describe("size rule server functions", () => {
  it("uses the service editor's permission for each write", async () => {
    for (const role of ["tech", "dispatcher"]) {
      const calls = fake(role);
      await expect(upsertServiceSizeRule({ data: draft })).rejects.toThrow("Not authorized");
      await expect(deleteServiceSizeRule({ data: { id, serviceId } })).rejects.toThrow(
        "Not authorized",
      );
      expect(calls.some((c) => c.table === "service_size_rules")).toBe(false);
    }
  });
  it("allows member reads and scopes them to the org and service", async () => {
    const calls = fake("tech");
    expect(await listServiceSizeRules({ data: { serviceId } })).toEqual({ rules: [] });
    expect(calls).toContainEqual({
      table: "services",
      op: "eq",
      args: ["organization_id", "org-a"],
    });
    expect(calls).toContainEqual({
      table: "service_size_rules",
      op: "eq",
      args: ["organization_id", "org-a"],
    });
    expect(calls).toContainEqual({
      table: "service_size_rules",
      op: "eq",
      args: ["service_id", serviceId],
    });
  });
  it("refuses a missing service and a non-grooming service before writing", async () => {
    for (const [found, line, message] of [
      [false, "mobile_grooming", "Service not found"],
      [true, "pet_waste", "only for mobile grooming"],
    ] as const) {
      const calls = fake("owner", line, found);
      await expect(upsertServiceSizeRule({ data: draft })).rejects.toThrow(message);
      expect(calls.some((c) => c.table === "service_size_rules")).toBe(false);
    }
  });
  it("upserts by size and coat without trusting a caller tenant", async () => {
    const calls = fake();
    await upsertServiceSizeRule({ data: { ...draft, organization_id: "org-b" } } as any);
    expect(calls).toContainEqual({
      table: "service_size_rules",
      op: "upsert",
      args: [
        {
          service_id: serviceId,
          size: "small",
          coat_type: null,
          duration_min: 60,
          price_cents: 6000,
        },
        { onConflict: "service_id,size,coat_type" },
      ],
    });
  });
  it("scopes edits and deletes by id, service and tenant", async () => {
    const calls = fake();
    await upsertServiceSizeRule({ data: { ...draft, id } });
    await deleteServiceSizeRule({ data: { id, serviceId } });
    for (const args of [
      ["id", id],
      ["service_id", serviceId],
      ["organization_id", "org-a"],
    ])
      expect(
        calls.filter(
          (c) =>
            c.table === "service_size_rules" &&
            c.op === "eq" &&
            JSON.stringify(c.args) === JSON.stringify(args),
        ),
      ).toHaveLength(2);
  });
});

describe("add-on appointment facts", () => {
  const addon = { code: "teeth", name: "Teeth brushing", unit_price_cents: 1500 };
  it("writes zero and a line explicitly and leaves omitted fields alone on existing rows", async () => {
    let calls = fake();
    await upsertAddonService({
      data: { ...addon, id, durationMin: 10, serviceLine: "mobile_grooming" },
    });
    expect(
      calls.find((c) => c.table === "addon_services" && c.op === "update")?.args[0],
    ).toMatchObject({ duration_min: 10, service_line: "mobile_grooming" });
    calls = fake();
    await upsertAddonService({ data: { ...addon, id, durationMin: 0, serviceLine: "pet_waste" } });
    expect(
      calls.find((c) => c.table === "addon_services" && c.op === "update")?.args[0],
    ).toMatchObject({ duration_min: 0, service_line: "pet_waste" });
    calls = fake();
    await upsertAddonService({ data: { ...addon, id } });
    const row = calls.find((c) => c.table === "addon_services" && c.op === "update")?.args[0];
    expect(row).not.toHaveProperty("duration_min");
    expect(row).not.toHaveProperty("service_line");
  });
  it.each([
    { durationMin: -1 },
    { durationMin: 481 },
    { durationMin: 1.5 },
    { serviceLine: "groom" },
    // No line is not "any service" (#640).
    { serviceLine: null },
  ])("refuses invalid appointment facts: %j", async (patch) => {
    await expect(upsertAddonService({ data: { ...addon, ...patch } } as any)).rejects.toThrow();
  });
});
