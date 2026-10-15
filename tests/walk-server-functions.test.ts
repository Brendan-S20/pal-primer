import { beforeEach, describe, expect, it, vi } from "vitest";

let context: { supabase: unknown; userId: string } = { supabase: null, userId: "walker-user" };
const mocks = vi.hoisted(() => ({
  permission: vi.fn(async () => ({ orgId: "org-a", role: "owner" })),
  caller: vi.fn(async () => ({ orgId: "org-a", role: "dispatcher" })),
  estimate: vi.fn(async () => {}),
  generate: vi.fn(async () => 2),
  activity: vi.fn(async () => {}),
}));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (data: unknown) => unknown = (data) => data;
    const builder = {
      middleware: () => builder,
      inputValidator: (fn: (data: unknown) => unknown) => {
        validate = fn;
        return builder;
      },
      handler:
        (fn: (args: { data: unknown; context: unknown }) => unknown) =>
        async (args: { data: unknown }) =>
          fn({ data: validate(args.data), context }),
    };
    return builder;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/lib/authz.server", () => ({
  requirePermission: mocks.permission,
  resolveCaller: mocks.caller,
}));
vi.mock("@/lib/estimate.server", () => ({ recomputePropertyEstimate: mocks.estimate }));
vi.mock("@/lib/visit-generation.server", () => ({ generateVisitHorizon: mocks.generate }));
vi.mock("@/lib/activity.server", () => ({ logActivity: mocks.activity }));

const ID = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const base = {
  clientId: ID,
  propertyId: ID2,
  serviceId: ID,
  accountType: "residential",
  frequency: "weekly",
  weekdays: [1, 3, 5],
  dogCount: 1,
  priceCents: 2500,
  earliestTime: "11:00",
  latestTime: "13:00",
  startedOn: "2026-10-19",
};
const windows = [
  { earliestTime: "11:00", latestTime: "13:00" },
  { earliestTime: "16:00", latestTime: "18:00" },
];
type Call = { table: string; op: string; args: unknown[] };

function fake(options: { line?: string; canWrite?: boolean; error?: { message: string } } = {}) {
  const calls: Call[] = [];
  let planCount = 0;
  const client = {
    from(table: string) {
      const answer = () => ({
        data:
          table === "clients"
            ? { organization_id: "org-a" }
            : table === "services"
              ? { id: ID, active: true, service_line: options.line ?? "dog_walking" }
              : table === "subscriptions"
                ? Array.from({ length: planCount }, (_, index) => ({ id: index === 0 ? ID : ID2 }))
                : [{ id: ID }],
        error: table === "clients" || table === "services" ? null : (options.error ?? null),
      });
      const query: Record<string, unknown> = {};
      for (const op of ["select", "insert", "update", "delete", "eq"])
        query[op] = (...args: unknown[]) => {
          calls.push({ table, op, args });
          if (table === "subscriptions" && op === "insert")
            planCount = Array.isArray(args[0]) ? args[0].length : 1;
          return query;
        };
      query.single = async () => answer();
      query.maybeSingle = async () => answer();
      query.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve(answer()).then(resolve);
      return query;
    },
    async rpc(name: string, args: unknown) {
      calls.push({ table: name, op: "rpc", args: [args] });
      return { data: options.canWrite !== false, error: null };
    },
  };
  context.supabase = client;
  return { calls, client };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.permission.mockResolvedValue({ orgId: "org-a", role: "owner" });
});

describe("walk plan creation", () => {
  it("keeps one pet-waste plan on its existing generation and zone-pricing path", async () => {
    const { createSubscription } = await import("@/lib/subscriptions.functions");
    const db = fake({ line: "pet_waste" });
    expect(await createSubscription({ data: { ...base, zoneId: ID2 } })).toEqual({ id: ID });
    const insert = db.calls.find((call) => call.table === "subscriptions" && call.op === "insert");
    const rows = insert!.args[0] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      earliest_time: "11:00",
      latest_time: "13:00",
      priced_from_zone_id: ID2,
      zone_id: ID2,
    });
    expect(mocks.generate).toHaveBeenCalledWith(db.client, "org-a");
    expect(mocks.activity).toHaveBeenCalledOnce();
  });

  it("validates all windows and uses one insert with the existing plan fields and generation", async () => {
    const { createWalkPlans } = await import("@/lib/walk-plans.functions");
    const db = fake();
    const result = await createWalkPlans({ data: { ...base, windows } });
    expect(result).toEqual({ ids: [ID, ID2] });
    expect(mocks.permission).toHaveBeenCalledWith(db.client, "walker-user", "manage_pricing");
    const inserts = db.calls.filter(
      (call) => call.table === "subscriptions" && call.op === "insert",
    );
    expect(inserts).toHaveLength(1);
    const rows = inserts[0].args[0] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    for (const [index, row] of rows.entries())
      expect(row).toMatchObject({
        organization_id: "org-a",
        client_id: ID,
        property_id: ID2,
        service_id: ID,
        frequency: "weekly",
        weekdays: [1, 3, 5],
        price_cents: 2500,
        dog_count: 1,
        earliest_time: windows[index].earliestTime,
        latest_time: windows[index].latestTime,
        billing_cadence: "postpaid",
        priced_from_zone_id: null,
      });
    expect(mocks.estimate).toHaveBeenCalledOnce();
    expect(mocks.generate).toHaveBeenCalledWith(db.client, "org-a");
    expect(mocks.activity).toHaveBeenCalledTimes(2);
  });

  it("rejects an invalid second window before permissions or database writes", async () => {
    const { createWalkPlans } = await import("@/lib/walk-plans.functions");
    const db = fake();
    await expect(
      createWalkPlans({ data: { ...base, windows: [windows[0], windows[0]] } }),
    ).rejects.toThrow(/different arrival window/);
    await expect(
      createWalkPlans({
        data: { ...base, windows: [windows[0], { earliestTime: "18:00", latestTime: "16:00" }] },
      }),
    ).rejects.toThrow(/before/);
    expect(mocks.permission).not.toHaveBeenCalled();
    expect(db.calls).toEqual([]);
  });

  it("refuses missing pricing permission, a non-walk service and an insert failure", async () => {
    const { createWalkPlans } = await import("@/lib/walk-plans.functions");
    let db = fake();
    mocks.permission.mockRejectedValueOnce(new Error("Not authorized"));
    await expect(createWalkPlans({ data: { ...base, windows } })).rejects.toThrow("Not authorized");
    expect(db.calls).toEqual([]);
    db = fake({ line: "pet_waste" });
    await expect(createWalkPlans({ data: { ...base, windows } })).rejects.toThrow(
      "Choose a dog walking service.",
    );
    expect(db.calls.some((call) => call.op === "insert")).toBe(false);
    fake({ error: { message: "insert failed" } });
    await expect(createWalkPlans({ data: { ...base, windows } })).rejects.toThrow("insert failed");
    expect(mocks.generate).not.toHaveBeenCalled();
  });
});

describe("group server writes", () => {
  it("uses can_write_org for every group action before writes", async () => {
    const { createWalkGroup, setWalkGroupMember, setWalkGroupWalker, deleteWalkGroup } =
      await import("@/lib/walk-groups.functions");
    const db = fake({ canWrite: false });
    const actions = [
      () =>
        createWalkGroup({
          data: {
            day: "2026-10-19",
            serviceId: ID,
            walkerId: null,
            earliestTime: null,
            latestTime: null,
          },
        }),
      () => setWalkGroupMember({ data: { visitId: ID, groupId: ID2 } }),
      () => setWalkGroupWalker({ data: { groupId: ID2, walkerId: ID } }),
      () => deleteWalkGroup({ data: { groupId: ID2 } }),
    ];
    for (const action of actions) await expect(action()).rejects.toThrow("Not authorized");
    expect(db.calls).toHaveLength(4);
    expect(db.calls.every((call) => call.table === "can_write_org" && call.op === "rpc")).toBe(
      true,
    );
    expect(db.calls[0].args).toEqual([{ _user_id: "walker-user", _org_id: "org-a" }]);
  });

  it("passes capacity and compatibility sentences through unchanged", async () => {
    const { setWalkGroupMember } = await import("@/lib/walk-groups.functions");
    for (const message of [
      "This group walk is full: 3 of 2 dogs.",
      "A dog marked aggressive walks alone. Book a solo walk instead.",
    ]) {
      const db = fake({ error: { message } });
      await expect(setWalkGroupMember({ data: { visitId: ID, groupId: ID2 } })).rejects.toThrow(
        message,
      );
      expect(db.calls).toContainEqual({
        table: "visits",
        op: "eq",
        args: ["organization_id", "org-a"],
      });
      expect(db.calls).toContainEqual({ table: "visits", op: "eq", args: ["status", "scheduled"] });
    }
  });

  it("saves a group capacity and clears it on non-walk services", async () => {
    const { parseServiceDraft } = await import("@/lib/services.functions");
    const draft = {
      name: "Walk",
      service_line: "dog_walking",
      price_unit: "visit",
      base_price_cents: 2000,
      extra_pet_cents: 0,
      default_duration_min: 30,
      max_dogs: 4,
    };
    expect(parseServiceDraft(draft).max_dogs).toBe(4);
    expect(parseServiceDraft({ ...draft, service_line: "pet_waste" }).max_dogs).toBeNull();
  });
});
