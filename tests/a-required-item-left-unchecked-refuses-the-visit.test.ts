// A visit had no checklist, and now one refuses to be skipped past.
//
// The owner writes a list in Settings -> Preferences -> Finishing a visit
// ("All areas walked", "Gate latched", ...), each item required or not. A
// tech on an in-progress visit ticks them in My Day, and Complete stays grey
// until every required one is ticked. complete_visit refuses the same
// completion in the database, the way it refuses a missing completion photo,
// because the button is a courtesy and an offline replay, an old build or a
// hand-rolled RPC call never sees it.
//
// Three layers, three kinds of proof:
//
//   * the migration's text, for the things a reader of the file must be able
//     to find (the signature, the grants, the refusal sits before the UPDATE);
//   * a real Postgres, via tests/sql/a-visit-had-no-checklist.proof.sql,
//     applied inside a transaction and ROLLED BACK — because text can describe
//     a refusal that never fires;
//   * the pure rule My Day draws from, driven, plus the wiring that puts it on
//     the button.
//
// When no database answers, the proof says so loudly and skips: "no
// experiment was run" must not read like "the experiment passed".

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { missingRequired, type ChecklistItem } from "@/lib/visit-checklist";

const ROOT = join(import.meta.dirname, "..");
const MIGRATION_REL = "supabase/migrations/20260929040000_a-visit-had-no-checklist.sql";
const MIGRATION = join(ROOT, MIGRATION_REL);
const PROOF = join(ROOT, "tests/sql/a-visit-had-no-checklist.proof.sql");
const DB_URL =
  process.env.CHECKLIST_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

// Lazy: a throw during collection reads as "no tests", which reads as a pass.
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
// Block comments are stripped only where one STARTS a line: my-day.tsx has
// `accept="image/*"`, and a bare `/\*…*\/` pattern eats from there to the next
// comment's close, taking the code under test with it.
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

function findPsql(): string | null {
  for (const p of [
    "psql",
    "/opt/homebrew/opt/libpq/bin/psql",
    "/opt/homebrew/opt/postgresql@18/bin/psql",
    "/opt/homebrew/opt/postgresql@17/bin/psql",
    "/usr/local/opt/libpq/bin/psql",
  ]) {
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
    `\n  SKIPPED: the checklist proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set CHECKLIST_PROOF_DB_URL to run them.\n",
  );
}

/** Run the proof once per file: it is a few seconds on a loaded machine. */
let proofRun: { status: number | null; out: string } | null = null;
function runChecklistProof() {
  if (!proofRun) {
    const r = spawnSync(psql!, [DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-f", PROOF], {
      encoding: "utf8",
      timeout: 300_000,
    });
    proofRun = { status: r.status, out: `${r.stdout}\n${r.stderr}` };
  }
  return proofRun;
}

describe("complete_visit refuses an unchecked required item (the migration)", () => {
  it("takes the checked ids as a fifth argument, and only one signature survives", () => {
    const sql = codeOnly(read(MIGRATION_REL));
    expect(sql).toMatch(
      /DROP FUNCTION IF EXISTS public\.complete_visit\(uuid, timestamptz, text, text\);/,
    );
    expect(sql).toMatch(/_checked_items text\[\] DEFAULT NULL/);
    // The DO block asserts the overload is gone, so a replay cannot leave two.
    expect(sql).toMatch(/proname = 'complete_visit'\) <> 1/);
  });

  it("restates the grants the DROP took with it, and locks out anon", () => {
    const sql = codeOnly(read(MIGRATION_REL));
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.complete_visit\(uuid, timestamptz, text, text, text\[\]\) FROM PUBLIC, anon;/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.complete_visit\(uuid, timestamptz, text, text, text\[\]\)\s+TO authenticated, service_role;/,
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.visit_checklist_is_valid\(jsonb\) FROM PUBLIC, anon;/,
    );
  });

  it("refuses BEFORE the visit is written, not after", () => {
    const sql = codeOnly(read(MIGRATION_REL));
    const fn = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.complete_visit"));
    const refusal = fn.indexOf("RAISE EXCEPTION 'Check off every required item");
    const write = fn.indexOf("UPDATE public.visits");
    expect(refusal, "no refusal for an unchecked required item").toBeGreaterThan(-1);
    expect(refusal, "the refusal comes after the visit is completed").toBeLessThan(write);
    // Still the photo rule too: the checklist is added to it, not swapped in.
    expect(fn).toMatch(/A completion photo is required before completing this visit/);
  });

  it("starts every existing organization with an empty list, so nothing changes for them", () => {
    const sql = codeOnly(read(MIGRATION_REL));
    expect(sql).toMatch(
      /ADD COLUMN IF NOT EXISTS visit_checklist jsonb NOT NULL DEFAULT '\[\]'::jsonb/,
    );
    expect(sql).toMatch(
      /ADD COLUMN IF NOT EXISTS email_visit_checklist boolean NOT NULL DEFAULT false/,
    );
  });
});

describe.skipIf(!reachable)(
  "complete_visit refuses an unchecked required item (a real database)",
  () => {
    it("has the files it runs", () => {
      expect(existsSync(MIGRATION)).toBe(true);
      expect(existsSync(PROOF)).toBe(true);
    });

    it("proves every rule, and leaves nothing behind", () => {
      const { status, out } = runChecklistProof();
      expect(status, out).toBe(0);
      expect(out).not.toMatch(/PROOF FAILED/);
      // Eight groups, each announcing itself only when it passed.
      expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(8);
      expect(out).toMatch(
        /ok: completing is refused while a required item is unchecked, and names it/,
      );
      expect(out).toMatch(/ok: a replayed completion is held to the checklist/);
      expect(out).toMatch(/ALL CHECKLIST PROOFS PASSED/);

      const left = spawnSync(
        psql!,
        [
          DB_URL,
          "-XAtc",
          "select count(*) from public.organizations where name = 'Checklist Proof'",
        ],
        { encoding: "utf8" },
      );
      expect(left.stdout.trim()).toBe("0");
    });
  },
);

describe("My Day holds Complete until the required items are checked", () => {
  const list: ChecklistItem[] = [
    { id: "walk", label: "All areas walked", required: true },
    { id: "gate", label: "Gate latched", required: true },
    { id: "bowl", label: "Water bowl checked", required: false },
  ];

  it("names what is missing, in the owner's order", () => {
    expect(missingRequired(list, []).map((i) => i.id)).toEqual(["walk", "gate"]);
    expect(missingRequired(list, ["gate", "bowl"]).map((i) => i.id)).toEqual(["walk"]);
  });

  it("lets the visit finish once every required item is ticked, optional or not", () => {
    expect(missingRequired(list, ["gate", "walk"])).toEqual([]);
    // An org with no checklist is never held up by one.
    expect(missingRequired([], [])).toEqual([]);
  });

  it("does not count a tick on an item the owner has since removed", () => {
    expect(missingRequired(list, ["gone", "walk"]).map((i) => i.id)).toEqual(["gate"]);
  });

  it("puts that rule on the Complete button and sends the ticks with the completion", () => {
    const page = codeOnly(read("src/routes/_authenticated/my-day.tsx"));
    expect(page).toMatch(/const uncheckedRequired = missingRequired\(checklist, checkedItems\)/);
    expect(page).toMatch(/const checklistRuleMet = uncheckedRequired\.length === 0/);
    const button = page.slice(page.indexOf("!photoRuleMet ||"), page.indexOf("Complete\n"));
    expect(button, "Complete is not held by the checklist").toMatch(/!checklistRuleMet \|\|/);
    expect(page).toMatch(/actions\.complete\(\{[\s\S]{0,600}checkedItems:/);
    // A phone has no hover: why the button is grey is written under it.
    expect(page).toMatch(
      /!checklistRuleMet && \(\s*<p[\s\S]{0,200}uncheckedRequired\.length === 1/,
    );
  });

  it("draws each item as a 44px row, box and label together", () => {
    const page = codeOnly(read("src/routes/_authenticated/my-day.tsx"));
    const block = page.slice(page.indexOf("checklist.map((item)"));
    expect(block).toMatch(/<label[\s\S]{0,120}htmlFor=\{id\}[\s\S]{0,40}className="flex min-h-11/);
    // Wraps rather than widening the card at 320px.
    expect(block).toMatch(/min-w-0 flex-1[^"]*\[overflow-wrap:anywhere\]/);
  });
});
