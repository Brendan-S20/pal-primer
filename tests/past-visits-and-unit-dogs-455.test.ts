// Two of the three residual bugs in #455, found on the Riverbend demo.
//
// 1. Past visits stuck Missed. The seed writes about 91% of history
//    completed, but every day after seeding, visits nobody worked roll past
//    and the nightly job marks them missed, which is the right rule for a
//    real business. The office could not recover one: office_complete_visit
//    has accepted 'missed' since B6, and the client Visits tab offered the
//    button, but completeVisitFromOffice refused anything not scheduled or in
//    progress, and the dispatch drawer hid Complete. The dashboard digest
//    also divided by every row scheduled, so today's half-run route and
//    canceled visits read as failed work.
//
// 2. DNA unit dogs. A dog put on the wrong unit could not be moved from the
//    unit's list, or deleted at all. Moving reuses updateDog (which checks
//    the unit is on the dog's property). Deleting goes through removeDog,
//    which deletes only a dog nothing points at and marks any other one
//    inactive, so no visit, plan, stay or DNA match is left naming a row
//    that is gone.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;
const h = vi.hoisted(() => ({
  visit: null as Row | null,
  rpcs: [] as Array<{ fn: string; args: Row }>,
  counts: {} as Record<string, number>,
  countFilters: [] as Array<{ table: string; op: string; col: string; val: unknown }>,
  dog: null as Row | null,
  deleted: [] as string[],
  updated: [] as Array<{ table: string; patch: Row }>,
  activity: [] as Row[],
  rowColumns: {} as Record<string, Set<string>>,
  headSelects: [] as Array<{ table: string; columns: string }>,
  blankCountError: null as string | null,
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
vi.mock("@/lib/field-notify.server", () => ({
  startRouteWatch: async () => ({ finish: async () => {} }),
}));
vi.mock("@/lib/push-liveactivity.server", () => ({
  watchRouteLiveActivities: async () => async () => {},
}));
vi.mock("@/lib/activity.server", () => ({
  logActivity: async (_s: unknown, entry: Row) => void h.activity.push(entry),
}));
vi.mock("@/lib/training-portal.server", () => ({ afterLessonSessionChange: async () => {} }));
vi.mock("@/lib/estimate.server", () => ({ recomputePropertyEstimate: async () => {} }));

/** As much of supabase-js as the two server functions use. */
function fakeSupabase() {
  return {
    rpc: async (fn: string, args: Row) => {
      h.rpcs.push({ fn, args });
      return { data: null, error: null };
    },
    from(table: string) {
      let op: "select" | "delete" | "update" = "select";
      let head = false;
      let headFails = false;
      let patch: Row = {};
      const q: any = {
        select: (c = "*", o?: { head?: boolean }) => {
          head = !!o?.head;
          if (head) {
            h.headSelects.push({ table, columns: c });
            // PostgREST answers a HEAD for a column the table lacks with a 400
            // and no body, so supabase-js reports error.message === "".
            const cols = h.rowColumns[table];
            const missing = c !== "*" && cols && c.split(",").some((col) => !cols.has(col.trim()));
            if (missing || h.blankCountError === table) headFails = true;
          }
          return q;
        },
        eq: (col: string, val: unknown) => {
          if (head) h.countFilters.push({ table, op: "eq", col, val });
          return q;
        },
        contains: (col: string, val: unknown) => {
          h.countFilters.push({ table, op: "contains", col, val });
          return q;
        },
        delete: () => ((op = "delete"), q),
        update: (p: Row) => ((op = "update"), (patch = p), q),
        single: () => q,
        maybeSingle: () => q,
        then(res: any, rej: any) {
          let out: any;
          if (op === "delete") {
            h.deleted.push(table);
            out = { error: null };
          } else if (op === "update") {
            h.updated.push({ table, patch });
            out = { error: null };
          } else if (head && headFails) out = { count: null, error: { message: "" } };
          else if (head) out = { count: h.counts[table] ?? 0, error: null };
          else if (table === "visits") out = { data: h.visit, error: null };
          else if (table === "dogs") out = { data: h.dog, error: null };
          else if (table === "properties")
            out = { data: { organization_id: "org-1", client_id: "c-1" }, error: null };
          else out = { data: null, error: null };
          return Promise.resolve(out).then(res, rej);
        },
      };
      return q;
    },
  };
}

import { completeVisitFromOffice } from "@/lib/visits.functions";
import { removeDog } from "@/lib/dogs.functions";
import { canOfficeComplete, completionRate } from "@/lib/visit-lifecycle";
import { dogDeleteOutcome, type DogLinks } from "@/lib/dna-linkage";

const VISIT = "11111111-1111-4111-8111-111111111111";
const DOG = "22222222-2222-4222-8222-222222222222";
const ctx = () => ({ supabase: fakeSupabase(), userId: "u-owner" });
const read = (p: string) => readFileSync(join(import.meta.dirname, "..", p), "utf8");

/** Each public table's Row columns, read from the generated types, so the
 *  fake fails a head count the way PostgREST does when a column is missing. */
function rowColumnsFromTypes(): Record<string, Set<string>> {
  const src = read("src/integrations/supabase/types.ts");
  const out: Record<string, Set<string>> = {};
  const re = /^ {6}(\w+): \{\n {8}Row: \{\n([\s\S]*?)\n {8}\}/gm;
  for (const m of src.matchAll(re)) {
    if (out[m[1]]) continue;
    out[m[1]] = new Set([...m[2].matchAll(/^ {10}(\w+)\??:/gm)].map((c) => c[1]));
  }
  return out;
}
const ROW_COLUMNS = rowColumnsFromTypes();

beforeEach(() => {
  h.rowColumns = ROW_COLUMNS;
  h.headSelects = [];
  h.blankCountError = null;
  h.visit = null;
  h.rpcs = [];
  h.counts = {};
  h.countFilters = [];
  h.dog = null;
  h.deleted = [];
  h.updated = [];
  h.activity = [];
});

// ── 1. Past visits stuck Missed ─────────────────────────────────────────────

describe("a past visit the nightly job marked missed (#455)", () => {
  const visit = (status: string) => ({
    id: VISIT,
    organization_id: "org-1",
    client_id: "c-1",
    property_id: "p-1",
    scheduled_on: "2026-10-20",
    status,
  });

  it("can be completed from the office", async () => {
    h.visit = visit("missed");
    await expect(
      completeVisitFromOffice({ data: { visitId: VISIT }, context: ctx() } as any),
    ).resolves.toEqual({ ok: true });
    expect(h.rpcs).toEqual([{ fn: "office_complete_visit", args: { _visit_id: VISIT } }]);
  });

  it("a completed, skipped or canceled visit still cannot", async () => {
    for (const status of ["completed", "skipped", "canceled"]) {
      h.visit = visit(status);
      await expect(
        completeVisitFromOffice({ data: { visitId: VISIT }, context: ctx() } as any),
        status,
      ).rejects.toThrow(/scheduled, in-progress, or missed/);
    }
    expect(h.rpcs).toEqual([]);
  });

  it("the server, the dispatch drawer and the Visits tab ask the same rule as the SQL", () => {
    expect(["scheduled", "in_progress", "missed"].every(canOfficeComplete)).toBe(true);
    expect(["completed", "skipped", "canceled", null, undefined].some(canOfficeComplete)).toBe(
      false,
    );
    for (const f of [
      "src/lib/visits.functions.ts",
      "src/components/VisitDetailDrawer.tsx",
      "src/components/client-detail/VisitsTab.tsx",
    ]) {
      expect(read(f), f).toMatch(/canOfficeComplete\(/);
    }
    const sql = read("supabase/migrations/20260729100000_visit-close-out-and-provenance.sql");
    expect(sql).toMatch(/IF _status NOT IN \('scheduled','in_progress','missed'\)/);
  });
});

describe("the completion rate (#455)", () => {
  const rows = (...s: string[]) => s.map((status) => ({ status }));

  it("counts missed and skipped against it: missed is not done", () => {
    expect(completionRate(rows("completed", "completed", "completed", "missed"))).toBe(0.75);
    expect(completionRate(rows("completed", "skipped"))).toBe(0.5);
  });

  it("ignores canceled visits and ones still open today", () => {
    expect(
      completionRate(rows("completed", "completed", "scheduled", "in_progress", "canceled")),
    ).toBe(1);
    expect(completionRate(rows("scheduled", "canceled"))).toBeNull();
  });

  it("a missed visit completed later raises it", () => {
    const before = completionRate(rows("completed", "missed", "missed", "missed"))!;
    const after = completionRate(rows("completed", "completed", "completed", "missed"))!;
    expect(after).toBeGreaterThan(before);
  });

  it("reports and the dashboard digest both use it", () => {
    expect(read("src/lib/reports.functions.ts")).toMatch(/completionRate: completionRate\(/);
    const digest = read("src/lib/ai-tools.functions.ts");
    expect(digest).toMatch(/completion_rate: Math\.round\(\(completionRate\(/);
    expect(digest).not.toMatch(/completed \/ scheduled/);
  });
});

// ── 2. DNA unit dogs ────────────────────────────────────────────────────────

const NO_LINKS: DogLinks = {
  visits: 0,
  plans: 0,
  stays: 0,
  packages: 0,
  careLogs: 0,
  homework: 0,
  groomNotes: 0,
  incidents: 0,
  dnaMatches: 0,
  qcTickets: 0,
  vaccinations: 0,
  careInstructions: 0,
};

describe("deleting a dog from a unit (#455)", () => {
  beforeEach(() => {
    h.dog = { id: DOG, name: "Biscuit", property_id: "p-1" };
  });

  it("deletes a dog nothing points at", async () => {
    const r = await removeDog({ data: { id: DOG }, context: ctx() } as any);
    expect(r).toEqual({ outcome: "deleted", reasons: [] });
    expect(h.deleted).toEqual(["dogs"]);
    expect(h.activity[0]).toMatchObject({ kind: "dog.deleted" });
  });

  it("marks a dog with a vaccine record inactive, so the record and its document are not cascaded away", async () => {
    h.counts = { pet_vaccinations: 1 };
    const r = await removeDog({ data: { id: DOG }, context: ctx() } as any);
    expect(r).toEqual({ outcome: "deactivated", reasons: ["vaccine records"] });
    expect(h.deleted).toEqual([]);
    expect(h.updated).toEqual([{ table: "dogs", patch: { active: false } }]);
  });

  it("marks a dog with care instructions inactive too", async () => {
    h.counts = { pet_care_instructions: 2 };
    const r = await removeDog({ data: { id: DOG }, context: ctx() } as any);
    expect(r).toEqual({ outcome: "deactivated", reasons: ["care instructions"] });
    expect(h.deleted).toEqual([]);
  });

  it("marks a dog with history inactive instead, so nothing is left naming a missing row", async () => {
    h.counts = { visits: 2, dna_matches: 1 };
    const r = await removeDog({ data: { id: DOG }, context: ctx() } as any);
    expect(r).toEqual({ outcome: "deactivated", reasons: ["visits", "DNA matches"] });
    expect(h.deleted).toEqual([]);
    expect(h.updated).toEqual([{ table: "dogs", patch: { active: false } }]);
  });

  it("looks in every place a dog is named, including the uuid arrays no foreign key cleans", async () => {
    await removeDog({ data: { id: DOG }, context: ctx() } as any);
    const looked = h.countFilters
      .filter((f) => f.col !== "organization_id")
      .map((f) => `${f.table}.${f.col}`)
      .sort();
    expect(looked).toEqual(
      [
        "visits.groom_dog_ids",
        "subscriptions.groom_dog_ids",
        "stays.pet_ids",
        "client_packages.dog_id",
        "care_log.pet_id",
        "homework.dog_id",
        "pet_groom_notes.dog_id",
        "unit_incidents.dog_id",
        "dna_matches.matched_dog_id",
        "qc_tickets.dog_id",
        "pet_vaccinations.dog_id",
        "pet_care_instructions.pet_id",
      ].sort(),
    );
    // Every count is scoped to the caller's organization.
    expect(h.countFilters.filter((f) => f.col === "organization_id")).toHaveLength(12);
  });

  it("head-counts only columns each table has: homework and pet_care_instructions have no id", async () => {
    expect(ROW_COLUMNS.homework?.has("visit_id")).toBe(true);
    expect(ROW_COLUMNS.homework?.has("id")).toBe(false);
    expect(ROW_COLUMNS.pet_care_instructions?.has("pet_id")).toBe(true);
    expect(ROW_COLUMNS.pet_care_instructions?.has("id")).toBe(false);

    const r = await removeDog({ data: { id: DOG }, context: ctx() } as any);
    expect(r).toEqual({ outcome: "deleted", reasons: [] });
    expect(h.headSelects).toHaveLength(12);
    for (const { table, columns } of h.headSelects) {
      expect(ROW_COLUMNS[table], `${table} is in the generated types`).toBeDefined();
      if (columns === "*") continue;
      for (const col of columns.split(",")) {
        expect(ROW_COLUMNS[table].has(col.trim()), `${table}.${col.trim()}`).toBe(true);
      }
    }
  });

  it("a count that fails with a blank message says which table, and deletes nothing", async () => {
    h.blankCountError = "homework";
    await expect(removeDog({ data: { id: DOG }, context: ctx() } as any)).rejects.toThrow(
      "Could not check homework",
    );
    expect(h.deleted).toEqual([]);
    expect(h.updated).toEqual([]);
  });

  it("the Units tab never shows a blank delete toast", () => {
    expect(read("src/components/client-detail/UnitsTab.tsx")).toMatch(
      /toast\.error\(\(e as Error\)\.message \|\| "Could not delete dog"\)/,
    );
  });

  it("refuses a dog in another organization", async () => {
    h.dog = null;
    await expect(removeDog({ data: { id: DOG }, context: ctx() } as any)).rejects.toThrow(
      "Dog not found",
    );
    expect(h.deleted).toEqual([]);
  });

  it("the rule, without a database", () => {
    expect(dogDeleteOutcome(NO_LINKS)).toEqual({ mode: "delete" });
    expect(dogDeleteOutcome({ ...NO_LINKS, plans: 1, incidents: 3 })).toEqual({
      mode: "deactivate",
      reasons: ["service plans", "unit incidents"],
    });
  });
});

describe("the unit's dog list (#455)", () => {
  const src = read("src/components/client-detail/UnitsTab.tsx");

  it("moves a dog to another unit on the same property", () => {
    expect(src).toMatch(/aria-label=\{`Move \$\{d\.name\} to another unit`\}/);
    expect(src).toMatch(/updateFn\(\{ data: \{ id: v\.id, unitId: v\.unitId \} \}\)/);
    expect(src).toMatch(/const otherUnits = units\.filter\(\(x\) => x\.id !== unit\.id\)/);
  });

  it("deletes a dog only after a confirm", () => {
    expect(src).toMatch(/const ok = await confirm\(\{/);
    expect(src).toMatch(/if \(ok\) deleteMut\.mutate\(d\.id\)/);
  });
});
