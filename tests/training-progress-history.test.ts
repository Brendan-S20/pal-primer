import { beforeEach, describe, expect, it, vi } from "vitest";

const context: { supabase: unknown; userId: string } = { supabase: null, userId: "trainer-user" };
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
          fn({ data: validate(args?.data), context }),
    };
    return builder;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
const permission = vi.hoisted(() => vi.fn());
vi.mock("@/lib/authz.server", () => ({
  resolveCaller: async () => ({ orgId: "org-a", role: "technician" }),
  requirePermission: permission,
}));

import {
  getSessionProgress,
  saveSessionProgress,
  saveTrainingSkill,
} from "@/lib/training-progress.functions";

const VISIT = "11111111-1111-4111-8111-111111111111";
const EARLIER = "22222222-2222-4222-8222-222222222222";
const PACK = "33333333-3333-4333-8333-333333333333";
type Call = { table: string; op: string; args: unknown[] };

function fake(
  options: {
    packageDog?: string | null;
    dogs?: { id: string; name: string }[];
    share?: boolean;
  } = {},
) {
  const calls: Call[] = [];
  const dogs = options.dogs ?? [
    { id: "dog-1", name: "Biscuit" },
    { id: "dog-2", name: "Pepper" },
  ];
  context.supabase = {
    from(table: string) {
      let op = "select";
      let columns = "";
      const answer = () => {
        if (table === "visits" && columns.startsWith("id, organization_id"))
          return {
            data: {
              id: VISIT,
              organization_id: "org-a",
              scheduled_on: "2090-02-10",
              property_id: "prop-1",
              client_package_id: PACK,
              services: { service_line: "training" },
              client_packages: {
                dog_id: options.packageDog === undefined ? "dog-2" : options.packageDog,
              },
            },
            error: null,
          };
        if (table === "visits")
          return { data: [{ id: EARLIER, scheduled_on: "2090-02-03" }], error: null };
        if (table === "dogs") return { data: dogs, error: null };
        if (table === "client_packages")
          return { data: [{ id: PACK }, { id: "old-pack" }], error: null };
        if (table === "training_skills") return { data: [], error: null };
        if (table === "session_progress" && columns.includes("training_skills(name"))
          return {
            data: [
              { visit_id: EARLIER, score: 2, training_skills: { name: "Heel", sort_order: 2 } },
              { visit_id: EARLIER, score: 4, training_skills: { name: "Sit", sort_order: 1 } },
            ],
            error: null,
          };
        if (table === "training_session_notes" && columns === "visit_id, note, trainer_note")
          return {
            data: [
              {
                visit_id: EARLIER,
                note: "Pulled on the leash",
                trainer_note: "Owner skips practice",
              },
            ],
            error: null,
          };
        if (table === "organizations")
          return { data: { training_share_progress: options.share ?? true }, error: null };
        if (table === "homework" && columns === "visit_id, body")
          return {
            data: [{ visit_id: EARLIER, body: "Five minutes of loose-leash walking" }],
            error: null,
          };
        return { data: op === "select" ? null : { ok: true }, error: null };
      };
      const query: Record<string, unknown> = {};
      for (const method of [
        "select",
        "insert",
        "upsert",
        "update",
        "delete",
        "eq",
        "neq",
        "in",
        "not",
        "lte",
        "order",
        "limit",
      ])
        query[method] = (...args: unknown[]) => {
          calls.push({ table, op: method, args });
          if (["insert", "upsert", "update", "delete"].includes(method)) op = method;
          if (method === "select") columns = String(args[0]);
          return query;
        };
      query.single = async () => answer();
      query.maybeSingle = async () => answer();
      query.then = (resolve: (v: unknown) => unknown) => Promise.resolve(answer()).then(resolve);
      return query;
    },
  };
  return {
    calls,
    writes: (table: string, op: string) => calls.filter((c) => c.table === table && c.op === op),
  };
}

beforeEach(() => vi.clearAllMocks());

describe("a lesson knows its dog", () => {
  it("records the package's dog on the homework when it lives at the lesson's property", async () => {
    const db = fake();
    await saveSessionProgress({
      data: { visitId: VISIT, scores: [], note: "", homework: "Practice sit" },
    });
    expect(db.writes("homework", "upsert")[0].args[0]).toMatchObject({
      dog_id: "dog-2",
      body: "Practice sit",
    });
  });
  it("uses the only dog at the property when the package names none, and no dog when it cannot tell", async () => {
    let db = fake({ packageDog: null, dogs: [{ id: "dog-1", name: "Biscuit" }] });
    await saveSessionProgress({
      data: { visitId: VISIT, scores: [], note: "", homework: "Practice sit" },
    });
    expect(db.writes("homework", "upsert")[0].args[0]).toMatchObject({ dog_id: "dog-1" });
    db = fake({ packageDog: null });
    await saveSessionProgress({
      data: { visitId: VISIT, scores: [], note: "", homework: "Practice sit" },
    });
    expect(db.writes("homework", "upsert")[0].args[0]).toMatchObject({ dog_id: null });
  });
});

describe("the shared note and the trainer-only note", () => {
  it("saves both notes on one row, and a trainer note alone leaves the shared note empty", async () => {
    let db = fake();
    await saveSessionProgress({
      data: { visitId: VISIT, scores: [], note: "Good focus", trainerNote: "Lunged once" },
    });
    expect(db.writes("training_session_notes", "upsert")[0].args[0]).toMatchObject({
      note: "Good focus",
      trainer_note: "Lunged once",
    });
    db = fake();
    await saveSessionProgress({
      data: { visitId: VISIT, scores: [], note: "  ", trainerNote: "Owner is not practicing" },
    });
    expect(db.writes("training_session_notes", "upsert")[0].args[0]).toMatchObject({
      note: null,
      trainer_note: "Owner is not practicing",
    });
    db = fake();
    await saveSessionProgress({ data: { visitId: VISIT, scores: [], note: "", trainerNote: "" } });
    expect(db.writes("training_session_notes", "upsert")).toEqual([]);
    expect(db.writes("training_session_notes", "delete")).toHaveLength(1);
  });
  it("tells the panel whether the client sees the shared note", async () => {
    fake({ share: false });
    expect((await getSessionProgress({ data: { visitId: VISIT } })).shared).toBe(false);
    fake();
    expect((await getSessionProgress({ data: { visitId: VISIT } })).shared).toBe(true);
  });
});

describe("the dog's earlier lessons", () => {
  it("returns scores in skill order, the note and the homework from the dog's last completed lessons", async () => {
    const db = fake();
    const result = await getSessionProgress({ data: { visitId: VISIT } });
    expect(result.dog).toEqual({ id: "dog-2", name: "Pepper" });
    expect(result.history).toEqual([
      {
        visitId: EARLIER,
        scheduledOn: "2090-02-03",
        scores: [
          { skill: "Sit", score: 4 },
          { skill: "Heel", score: 2 },
        ],
        note: "Pulled on the leash",
        trainerNote: "Owner skips practice",
        homework: "Five minutes of loose-leash walking",
      },
    ]);
    // Across every package for this dog, completed only, before this lesson, newest first, three at most.
    expect(db.calls).toContainEqual({
      table: "client_packages",
      op: "eq",
      args: ["dog_id", "dog-2"],
    });
    expect(db.calls).toContainEqual({
      table: "visits",
      op: "in",
      args: ["client_package_id", [PACK, "old-pack"]],
    });
    expect(db.calls).toContainEqual({ table: "visits", op: "eq", args: ["status", "completed"] });
    expect(db.calls).toContainEqual({ table: "visits", op: "neq", args: ["id", VISIT] });
    expect(db.calls).toContainEqual({
      table: "visits",
      op: "lte",
      args: ["scheduled_on", "2090-02-10"],
    });
    expect(db.calls).toContainEqual({ table: "visits", op: "limit", args: [3] });
  });
  it("falls back to this package's lessons when the dog is unknown", async () => {
    const db = fake({ packageDog: null });
    const result = await getSessionProgress({ data: { visitId: VISIT } });
    expect(result.dog).toBeNull();
    expect(db.writes("client_packages", "eq")).toEqual([]);
    expect(db.calls).toContainEqual({
      table: "visits",
      op: "in",
      args: ["client_package_id", [PACK]],
    });
  });
});

describe("the skill list", () => {
  it("is edited only by someone who can set prices, before anything is written", async () => {
    const { calls } = fake();
    permission.mockRejectedValueOnce(new Error("Not authorized"));
    await expect(saveTrainingSkill({ data: { name: "Place" } })).rejects.toThrow("Not authorized");
    expect(permission).toHaveBeenCalledWith(context.supabase, "trainer-user", "manage_pricing");
    expect(calls.filter((c) => c.table === "training_skills")).toEqual([]);
  });
});
