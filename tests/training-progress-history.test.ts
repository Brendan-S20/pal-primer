import { beforeEach, describe, expect, it, vi } from "vitest";

// A lesson's record is one dog's (R2-26): the trainer picks the dog at a
// house of several, every write names it, and the history and the skills over
// time are that dog's alone. Against a fake database that records each call.

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
  CHOOSE_LESSON_DOG,
  getSessionProgress,
  saveSessionProgress,
  saveTrainingSkill,
} from "@/lib/training-progress.functions";
import { skillTrends } from "@/lib/training-progress";

const VISIT = "11111111-1111-4111-8111-111111111111";
const EARLIER = "22222222-2222-4222-8222-222222222222";
const OLDEST = "44444444-4444-4444-8444-444444444444";
const PACK = "33333333-3333-4333-8333-333333333333";
const DOG_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DOG_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
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
    { id: DOG_1, name: "Biscuit" },
    { id: DOG_2, name: "Pepper" },
  ];
  context.supabase = {
    from(table: string) {
      let op = "select";
      let columns = "";
      const answer = () => {
        if (table === "visits")
          return {
            data: {
              id: VISIT,
              organization_id: "org-a",
              scheduled_on: "2090-02-10",
              property_id: "prop-1",
              client_package_id: PACK,
              services: { service_line: "training" },
              client_packages: {
                dog_id: options.packageDog === undefined ? DOG_2 : options.packageDog,
              },
            },
            error: null,
          };
        if (table === "dogs") return { data: dogs, error: null };
        if (table === "training_skills") return { data: [], error: null };
        if (table === "organizations")
          return { data: { training_share_progress: options.share ?? true }, error: null };
        if (table === "session_progress" && columns.includes("visits!inner"))
          return {
            data: [
              {
                visit_id: EARLIER,
                score: 2,
                training_skills: { name: "Heel", sort_order: 2 },
                visits: { scheduled_on: "2090-02-03" },
              },
              {
                visit_id: EARLIER,
                score: 4,
                training_skills: { name: "Sit", sort_order: 1 },
                visits: { scheduled_on: "2090-02-03" },
              },
              {
                visit_id: OLDEST,
                score: 1,
                training_skills: { name: "Sit", sort_order: 1 },
                visits: { scheduled_on: "2090-01-27" },
              },
            ],
            error: null,
          };
        if (table === "training_session_notes" && columns.includes("visits!inner"))
          return {
            data: [
              {
                visit_id: EARLIER,
                note: "Pulled on the leash",
                trainer_note: "Owner skips practice",
                visits: { scheduled_on: "2090-02-03" },
              },
            ],
            error: null,
          };
        if (table === "homework" && columns.includes("visits!inner"))
          return {
            data: [
              {
                visit_id: EARLIER,
                body: "Five minutes of loose-leash walking",
                visits: { scheduled_on: "2090-02-03" },
              },
            ],
            error: null,
          };
        if (op === "select" && columns === "skill_id, score") return { data: [], error: null };
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
        "is",
        "not",
        "lte",
        "order",
        "limit",
      ])
        query[method] = (...args: unknown[]) => {
          calls.push({ table, op: method, args });
          if (["insert", "upsert", "update", "delete"].includes(method)) op = method;
          if (method === "select" && op === "select") columns = String(args[0]);
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

describe("a lesson is recorded for one dog", () => {
  it("writes every score, note and homework with the dog the trainer chose", async () => {
    const db = fake();
    const SKILL = "55555555-5555-4555-8555-555555555555";
    const r = await saveSessionProgress({
      data: {
        visitId: VISIT,
        dogId: DOG_1,
        scores: [{ skillId: SKILL, score: 3 }],
        note: "Calm at the door",
        homework: "Practice sit",
      },
    });
    expect(r.dogId).toBe(DOG_1);
    expect(db.writes("session_progress", "upsert")[0].args).toEqual([
      expect.objectContaining({ dog_id: DOG_1, skill_id: SKILL, score: 3 }),
      { onConflict: "visit_id,dog_id,skill_id" },
    ]);
    expect(db.writes("training_session_notes", "upsert")[0].args).toEqual([
      expect.objectContaining({ dog_id: DOG_1, note: "Calm at the door" }),
      { onConflict: "visit_id,dog_id" },
    ]);
    expect(db.writes("homework", "upsert")[0].args).toEqual([
      expect.objectContaining({ dog_id: DOG_1, body: "Practice sit" }),
      { onConflict: "visit_id,dog_id" },
    ]);
    // Clearing a skill removes this dog's score, never the other dog's.
    expect(db.calls).toContainEqual({
      table: "session_progress",
      op: "eq",
      args: ["dog_id", DOG_1],
    });
  });

  it("refuses a dog that is not at the lesson", async () => {
    fake();
    await expect(
      saveSessionProgress({
        data: {
          visitId: VISIT,
          dogId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          scores: [],
          homework: "x",
        },
      }),
    ).rejects.toThrow("Choose a dog at this lesson.");
  });

  it("with no dog named, uses the package's dog, then the only dog, and asks when it cannot tell", async () => {
    let db = fake();
    await saveSessionProgress({ data: { visitId: VISIT, scores: [], homework: "Practice sit" } });
    expect(db.writes("homework", "upsert")[0].args[0]).toMatchObject({ dog_id: DOG_2 });

    db = fake({ packageDog: null, dogs: [{ id: DOG_1, name: "Biscuit" }] });
    await saveSessionProgress({ data: { visitId: VISIT, scores: [], homework: "Practice sit" } });
    expect(db.writes("homework", "upsert")[0].args[0]).toMatchObject({ dog_id: DOG_1 });

    db = fake({ packageDog: null });
    await expect(
      saveSessionProgress({ data: { visitId: VISIT, scores: [], homework: "Practice sit" } }),
    ).rejects.toThrow(CHOOSE_LESSON_DOG);
    expect(db.writes("homework", "upsert")).toEqual([]);
  });

  it("keeps a whole-lesson record where no dog is on file", async () => {
    const db = fake({ packageDog: null, dogs: [] });
    await saveSessionProgress({ data: { visitId: VISIT, scores: [], homework: "Practice sit" } });
    expect(db.writes("homework", "upsert")[0].args[0]).toMatchObject({ dog_id: null });
    expect(db.calls).toContainEqual({
      table: "training_session_notes",
      op: "is",
      args: ["dog_id", null],
    });
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

describe("the dog's earlier lessons and skills over time", () => {
  it("opens on the package's dog and lists every dog at the lesson", async () => {
    fake();
    const result = await getSessionProgress({ data: { visitId: VISIT } });
    expect(result.dog).toEqual({ id: DOG_2, name: "Pepper" });
    expect(result.dogs.map((d) => d.name)).toEqual(["Biscuit", "Pepper"]);
    expect(result.dogGuessed).toBe(false);
  });

  it("opens on the first dog and says nobody chose it when the house has several and no package dog", async () => {
    fake({ packageDog: null });
    const result = await getSessionProgress({ data: { visitId: VISIT } });
    expect(result.dog?.name).toBe("Biscuit");
    expect(result.dogGuessed).toBe(true);
  });

  it("returns the chosen dog's last lessons and each skill's scores, oldest first", async () => {
    const db = fake();
    const result = await getSessionProgress({ data: { visitId: VISIT, dogId: DOG_1 } });
    expect(result.dog).toEqual({ id: DOG_1, name: "Biscuit" });
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
      {
        visitId: OLDEST,
        scheduledOn: "2090-01-27",
        scores: [{ skill: "Sit", score: 1 }],
        note: "",
        trainerNote: "",
        homework: "",
      },
    ]);
    expect(result.trends).toEqual([
      { skill: "Sit", scores: [1, 4], first: 1, latest: 4, lessons: 2 },
      { skill: "Heel", scores: [2], first: 2, latest: 2, lessons: 1 },
    ]);
    // Keyed by the dog, completed only, before this lesson, never this lesson.
    for (const table of ["session_progress", "training_session_notes", "homework"]) {
      expect(db.calls).toContainEqual({ table, op: "eq", args: ["dog_id", DOG_1] });
      expect(db.calls).toContainEqual({ table, op: "eq", args: ["visits.status", "completed"] });
      expect(db.calls).toContainEqual({
        table,
        op: "lte",
        args: ["visits.scheduled_on", "2090-02-10"],
      });
      expect(db.calls).toContainEqual({ table, op: "neq", args: ["visit_id", VISIT] });
    }
  });

  it("reads the whole-lesson records at this property when no dog is on file", async () => {
    const db = fake({ packageDog: null, dogs: [] });
    const result = await getSessionProgress({ data: { visitId: VISIT } });
    expect(result.dog).toBeNull();
    expect(db.calls).toContainEqual({
      table: "session_progress",
      op: "is",
      args: ["dog_id", null],
    });
    expect(db.calls).toContainEqual({
      table: "session_progress",
      op: "eq",
      args: ["visits.property_id", "prop-1"],
    });
  });
});

describe("skillTrends", () => {
  it("orders skills by the business's order and keeps the last few scores", () => {
    const rows = [1, 2, 3, 4, 5, 5, 4].map((score, i) => ({
      visitId: `v${i}`,
      scheduledOn: `2090-01-0${i + 1}`,
      skill: "Come",
      sortOrder: 5,
      score,
    }));
    rows.push({ visitId: "v0", scheduledOn: "2090-01-01", skill: "Sit", sortOrder: 1, score: 3 });
    expect(skillTrends(rows)).toEqual([
      { skill: "Sit", scores: [3], first: 3, latest: 3, lessons: 1 },
      { skill: "Come", scores: [2, 3, 4, 5, 5, 4], first: 1, latest: 4, lessons: 7 },
    ]);
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
