// A renamed checklist item does not rewrite a finished visit.
//
// In September a tech confirmed "Gate latched". In October the owner renames
// the item to "Gate latched and chained". If the visit pointed at the item,
// September's record would now say the tech confirmed a chain nobody asked
// them about — and the office reading the drawer after a dog got out would be
// reading October's words about September's visit.
//
// So complete_visit COPIES each item onto the visit — id, label, whether it
// was required, whether it was checked — and it copies the label from the
// owner's list itself: the phone sends only ids, so the words on the record
// are the owner's, not whatever a client chose to send. Every reader then
// reads the copy: the office drawer, the tech's completed card, the email.
//
// The rename itself is proved in a real Postgres by
// tests/sql/a-visit-had-no-checklist.proof.sql; this file runs it for that one
// notice and pins the readers to the copy.

import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkedLabels, parseAnswers } from "@/lib/visit-checklist";

// A proof waits its turn for the shared lock (the-proofs-take-turns.test.ts),
// so on a loaded runner one can take minutes without being hung.
vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const MIGRATION_REL = "supabase/migrations/20260929040000_a-visit-had-no-checklist.sql";
const DB_URL =
  process.env.CHECKLIST_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

const psql = ["psql", "/opt/homebrew/opt/libpq/bin/psql", "/usr/local/opt/libpq/bin/psql"].find(
  (p) => spawnSync(p, ["--version"], { encoding: "utf8" }).status === 0,
);
const reachable =
  !!psql &&
  spawnSync(psql, [DB_URL, "-XAtc", "select 1"], {
    encoding: "utf8",
    timeout: 5_000,
  }).stdout?.trim() === "1";
if (!reachable) {
  console.warn(
    `\n  SKIPPED: the label-snapshot proof did NOT run. No database answered at ${DB_URL}.\n`,
  );
}

describe("the visit keeps its own copy of the list", () => {
  it("builds the copy from the organization's list, not from the caller", () => {
    const sql = read(MIGRATION_REL);
    const fn = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.complete_visit"));
    // The caller's only say is which ids were checked.
    expect(fn).toMatch(/_checked_items text\[\] DEFAULT NULL/);
    expect(fn).toMatch(
      /COALESCE\(o\.visit_checklist, '\[\]'::jsonb\)\s+INTO _required, _checklist/,
    );
    expect(fn).toMatch(/'label', item ->> 'label'/);
    expect(fn).toMatch(/'checked', \(item ->> 'id'\) = ANY \(_checked\)/);
    expect(fn).toMatch(/visit_checklist = COALESCE\(_answers, visit_checklist\)/);
  });

  it.skipIf(!reachable)("and a rename afterwards leaves it as it was (a real database)", () => {
    const r = spawnSync(
      psql!,
      [
        DB_URL,
        "-X",
        "-v",
        `migration=${join(ROOT, MIGRATION_REL)}`,
        "-f",
        join(ROOT, "tests/sql/a-visit-had-no-checklist.proof.sql"),
      ],
      { encoding: "utf8", timeout: 300_000 },
    );
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).toMatch(/ok: the label on a completed visit is the one it had that day/);
    expect(out).not.toMatch(/PROOF FAILED \[snapshot\]/);
  });
});

describe("every reader reads the copy", () => {
  const recorded = [
    { id: "gate", label: "Gate latched", required: true, checked: true },
    { id: "bowl", label: "Water bowl checked", required: false, checked: false },
  ];

  it("parses the answers with their own labels and ticks", () => {
    expect(parseAnswers(recorded)).toEqual(recorded);
    // Nothing recorded is not an empty checklist: it is "nothing was asked".
    expect(parseAnswers(null)).toBeNull();
  });

  it("emails only what was checked, in the recorded words", () => {
    expect(checkedLabels(parseAnswers(recorded))).toEqual(["Gate latched"]);
  });

  it("draws the office drawer from the visit's column, not the org's list", () => {
    const drawer = read("src/components/VisitDetailDrawer.tsx");
    expect(drawer).toMatch(
      /<VisitChecklistAnswers answers=\{parseAnswers\(v\.visit_checklist\) \?\? \[\]\} \/>/,
    );
    expect(read("src/lib/visits.functions.ts")).toMatch(
      /completion_photo_waived_reason, visit_checklist,/,
    );
  });

  it("emails from the visit's column too, and only when the owner turned it on", () => {
    const fn = read("src/lib/my-day.functions.ts");
    expect(fn).toMatch(/scheduled_on, visit_checklist, properties\(/);
    expect(fn).toMatch(
      /org\?\.email_visit_checklist\s+\? checkedLabels\(parseAnswers\(\(v as any\)\.visit_checklist\)\)\s+: \[\]/,
    );
  });
});
