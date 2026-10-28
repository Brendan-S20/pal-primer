// A walk is not asked about waste (#565).
//
// organizations.visit_checklist was one list for every visit, and
// complete_visit refused while a required item on it was unchecked. A
// business that scoops and walks, and kept the pet-waste suggestions, could
// not finish a walk without ticking "Waste bagged and disposed". Now an item
// may name a line, and only the visit's own line's items (plus the ones with
// no line) are asked: in the database, on My Day, and in the editor's groups.
//
// Three kinds of proof, as in a-required-item-left-unchecked-refuses-the-visit:
// the pure rules, the wiring, and a real Postgres run inside a rolled-back
// transaction. When no database answers, the proof says so and skips.

import { describe, expect, it, vi } from "vitest";
import * as React from "react";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.setConfig({ testTimeout: 300_000 });

const lines = vi.hoisted(() => ({ current: ["pet_waste"] as string[] }));

vi.mock("@tanstack/react-start", () => ({
  useServerFn: (f: unknown) => f,
  createMiddleware: () => ({ server: () => ({}) }),
  createServerOnlyFn: (fn: unknown) => fn,
  createServerFn: () => {
    const chain: any = {
      middleware: () => chain,
      inputValidator: () => chain,
      handler: () => vi.fn(),
    };
    return chain;
  },
}));
vi.mock("@/components/CommercialOnly", () => ({
  useServiceLines: () => ({
    lines: lines.current,
    petWaste: lines.current.includes("pet_waste"),
    known: true,
  }),
}));
vi.mock("@/lib/org-features.functions", () => ({
  setVisitChecklist: vi.fn(),
  setEmailVisitChecklist: vi.fn(),
}));

import {
  answersFor,
  checklistForLine,
  checklistLineOf,
  checklistProblem,
  checklistRoom,
  missingRequired,
  parseChecklist,
  type ChecklistItem,
} from "@/lib/visit-checklist";
import {
  LINE_SEEDS,
  checklistGroupsFor,
  checklistSuggestionsFor,
  suggestedChecklistFor,
} from "@/lib/service-lines";
import { VisitChecklistEditor } from "@/components/VisitChecklistEditor";

const ROOT = join(import.meta.dirname, "..");
const MIGRATION_REL = "supabase/migrations/20261028100000_a-walk-is-not-asked-about-waste.sql";
const MIGRATION = join(ROOT, MIGRATION_REL);
const PROOF = join(ROOT, "tests/sql/a-walk-is-not-asked-about-waste.proof.sql");
const DB_URL =
  process.env.CHECKLIST_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const codeOnly = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\*[\s\S]*?\*\//gm, "")
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("--"));
    })
    .join("\n");

// A business that scoops and walks, with a list from before lines existed
// (no `line` on the shared items) and a waste item saved for pet waste.
const LIST: ChecklistItem[] = [
  { id: "all", label: "All areas walked", required: true },
  { id: "waste", label: "Waste bagged and disposed", required: true, line: "pet_waste" },
  { id: "dog", label: "Dog collected and returned", required: true, line: "dog_walking" },
  { id: "bowl", label: "Water bowl checked", required: false },
];

describe("a visit is asked only its own line's items", () => {
  it("a walk is not asked the waste item; a scoop still is", () => {
    const walk = checklistForLine(LIST, "dog_walking");
    expect(walk.map((i) => i.id)).toEqual(["all", "dog", "bowl"]);
    expect(missingRequired(walk, ["all", "dog"])).toEqual([]);

    const scoop = checklistForLine(LIST, "pet_waste");
    expect(scoop.map((i) => i.id)).toEqual(["all", "waste", "bowl"]);
    expect(missingRequired(scoop, ["all"]).map((i) => i.label)).toEqual([
      "Waste bagged and disposed",
    ]);
  });

  it("a visit with no service is pet waste, as complete_visit decides it", () => {
    expect(checklistLineOf(null)).toBe("pet_waste");
    expect(checklistLineOf(undefined)).toBe("pet_waste");
    expect(checklistLineOf("")).toBe("pet_waste");
    expect(checklistLineOf("dog_walking")).toBe("dog_walking");
  });

  it("a list saved before lines existed applies to every line, unchanged", () => {
    const old = parseChecklist([
      { id: "a", label: "Gate latched", required: true },
      { id: "b", label: "Waste bagged and disposed", required: true },
    ]);
    expect(old).toEqual([
      { id: "a", label: "Gate latched", required: true },
      { id: "b", label: "Waste bagged and disposed", required: true },
    ]);
    for (const line of ["pet_waste", "dog_walking", "training"]) {
      expect(checklistForLine(old, line)).toEqual(old);
    }
  });

  it("parseChecklist keeps a line, and drops one that is not a line's shape", () => {
    expect(
      parseChecklist([
        { id: "a", label: "x", required: true, line: "dog_walking" },
        { id: "b", label: "y", required: true, line: 7 },
      ]),
    ).toEqual([
      { id: "a", label: "x", required: true, line: "dog_walking" },
      { id: "b", label: "y", required: true },
    ]);
  });

  it("the answers recorded for a visit carry no line", () => {
    expect(answersFor(checklistForLine(LIST, "dog_walking"), ["dog"])[1]).toEqual({
      id: "dog",
      label: "Dog collected and returned",
      required: true,
      checked: true,
    });
  });

  it("twelve is the limit per visit, not per list", () => {
    const perLine = (line: "pet_waste" | "dog_walking", n: number): ChecklistItem[] =>
      Array.from({ length: n }, (_, k) => ({
        id: `${line}-${k}`,
        label: "x",
        required: false,
        line,
      }));
    const two = [...perLine("pet_waste", 12), ...perLine("dog_walking", 12)];
    expect(checklistProblem(two)).toBeNull();
    expect(checklistRoom(two, "dog_walking")).toBe(0);
    // One for every visit on top would make a walk ask thirteen.
    expect(checklistProblem([{ id: "e", label: "x", required: false }, ...two])).toMatch(
      /up to 12 items/,
    );
    // A list with no lines is held to twelve, as before.
    const flat = Array.from({ length: 13 }, (_, k) => ({
      id: String(k),
      label: "x",
      required: false,
    }));
    expect(checklistProblem(flat)).toBe("A checklist can have up to 12 items.");
  });
});

describe("the editor groups the list by line when the business runs more than one", () => {
  it("one line: one list, and the suggestions are that line's, saved with it", () => {
    expect(checklistGroupsFor(LIST, ["pet_waste"])).toBeNull();
    expect(
      checklistSuggestionsFor(["pet_waste"]).map(({ label, required }) => ({ label, required })),
    ).toEqual(suggestedChecklistFor(["pet_waste"]));
    expect(new Set(checklistSuggestionsFor(["pet_waste"]).map((s) => s.line))).toEqual(
      new Set(["pet_waste"]),
    );
  });

  it("two lines: every-visit items first, then each line's", () => {
    const groups = checklistGroupsFor(LIST, ["pet_waste", "dog_walking"])!;
    expect(groups.map((g) => [g.line, g.items.map((i) => i.id)])).toEqual([
      [null, ["all", "bowl"]],
      ["pet_waste", ["waste"]],
      ["dog_walking", ["dog"]],
    ]);
  });

  it("an item for a line the business stopped running still has a group", () => {
    const groups = checklistGroupsFor(LIST, ["dog_walking", "training"])!;
    expect(groups.map((g) => g.line)).toEqual([null, "pet_waste", "dog_walking", "training"]);
  });

  it("seeds each line from its own LINE_SEEDS list", () => {
    const s = checklistSuggestionsFor(["pet_waste", "dog_walking"]);
    expect(s.filter((x) => x.line === "pet_waste").map((x) => x.label)).toEqual(
      LINE_SEEDS.pet_waste.checklist.map((x) => x.label),
    );
    expect(s.filter((x) => x.line === "dog_walking").map((x) => x.label)).toEqual(
      LINE_SEEDS.dog_walking.checklist.map((x) => x.label),
    );
  });

  function render(saved: ChecklistItem[]) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
    return renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <VisitChecklistEditor saved={saved} emailOn={false} canEdit loading={false} />
      </QueryClientProvider>,
    );
  }

  it("an empty list says each service gets its own suggestions only when there are several", () => {
    lines.current = ["pet_waste"];
    expect(render([])).toMatch(/Suggested: All areas walked, Waste bagged and disposed/);
    lines.current = ["pet_waste", "dog_walking"];
    const html = render([]);
    expect(html).toMatch(/Each service gets its own suggested items\./);
    expect(html).not.toMatch(/Waste bagged/);
    lines.current = ["pet_waste"];
  });

  it("the editor draws the groups and a line picker per row", () => {
    const editor = codeOnly(read("src/components/VisitChecklistEditor.tsx"));
    expect(editor).toMatch(/checklistGroupsFor\(draft, lines\)/);
    expect(editor).toMatch(/groups\.map\(\(\{ line, items \}\)/);
    expect(editor).toMatch(/<SelectItem value=\{EVERY\}>Every visit<\/SelectItem>/);
  });
});

describe("My Day draws only the visit's line's items", () => {
  it("filters the owner's list by the stop's service line before anything reads it", () => {
    const page = codeOnly(read("src/routes/_authenticated/my-day.tsx"));
    expect(page).toMatch(/checklist: orgChecklist \} = useOrgFieldRules\(\)/);
    expect(page).toMatch(/const visitLine = checklistLineOf\(visit\.services\?\.service_line\)/);
    expect(page).toMatch(/checklistForLine\(orgChecklist, visitLine\)/);
    // Nothing else in the card reads the unfiltered list.
    expect(page.match(/orgChecklist/g)?.length).toBe(3);
  });

  it("the server takes an item's line, and only a known one", () => {
    const fn = codeOnly(read("src/lib/org-features.functions.ts"));
    expect(fn).toMatch(/line: z\.enum\(SERVICE_LINES[^)]*\)\.optional\(\)/);
    expect(fn).toMatch(/\.max\(MAX_CHECKLIST_TOTAL\)/);
  });
});

describe("complete_visit asks only the visit's line (the migration)", () => {
  it("reads the visit's line, with pet waste for no service, and filters before refusing", () => {
    const sql = codeOnly(read(MIGRATION_REL));
    const fn = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.complete_visit"));
    expect(fn).toMatch(/COALESCE\(s\.service_line, 'pet_waste'\)/);
    expect(fn).toMatch(/LEFT JOIN public\.services s ON s\.id = v\.service_id/);
    const filter = fn.indexOf("WHERE NOT (item ? 'line') OR item ->> 'line' = _line");
    const refusal = fn.indexOf("RAISE EXCEPTION 'Check off every required item");
    expect(filter).toBeGreaterThan(-1);
    expect(filter).toBeLessThan(refusal);
    expect(refusal).toBeLessThan(fn.indexOf("UPDATE public.visits"));
  });

  it("keeps one signature and its grants", () => {
    const sql = codeOnly(read(MIGRATION_REL));
    expect(sql).not.toMatch(/DROP FUNCTION/);
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.complete_visit\(uuid, timestamptz, text, text, text\[\]\)\s+TO authenticated, service_role;/,
    );
    expect(sql).toMatch(/proname = 'complete_visit'\) <> 1/);
  });
});

function findPsql(): string | null {
  for (const p of ["psql", "/opt/homebrew/opt/libpq/bin/psql", "/usr/local/opt/libpq/bin/psql"]) {
    const r = spawnSync(p, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return p;
  }
  return null;
}
const psql = findPsql();
const reachable =
  !!psql &&
  spawnSync(psql, [DB_URL, "-XAtc", "select 1"], {
    encoding: "utf8",
    timeout: 5_000,
  }).stdout?.trim() === "1";
if (!reachable) {
  console.warn(
    `\n  SKIPPED: the per-line checklist proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set CHECKLIST_PROOF_DB_URL to run them.\n",
  );
}

describe.skipIf(!reachable)("complete_visit asks only the visit's line (a real database)", () => {
  it("has the files it runs", () => {
    expect(existsSync(MIGRATION)).toBe(true);
    expect(existsSync(PROOF)).toBe(true);
  });

  it("proves every rule, and leaves nothing behind", () => {
    const r = spawnSync(psql!, [DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-f", PROOF], {
      encoding: "utf8",
      timeout: 300_000,
    });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(5);
    expect(out).toMatch(/ok: a walk completes without the waste item/);
    expect(out).toMatch(/ok: a scoop is still refused without the waste item/);
    expect(out).toMatch(/ALL PER-LINE CHECKLIST PROOFS PASSED/);

    const left = spawnSync(
      psql!,
      [
        DB_URL,
        "-XAtc",
        "select count(*) from public.organizations where name = 'Per-line Checklist Proof'",
      ],
      { encoding: "utf8" },
    );
    expect(left.stdout.trim()).toBe("0");
  });
});
