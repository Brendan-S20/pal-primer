// The walker proofs run where a database does (#731, #733 review).
//
// The first two walker proofs lived in tests/sql behind vitest wrappers that
// connect to 127.0.0.1:54422, the developer's own stack. The database job in
// sandboxes.yml builds its stack on 54521-54527 and executes two things:
// `npm run test:db` (tests/integration/*.db.test.ts) and psql over
// supabase/proofs/*.sql. So on CI the wrappers skipped and the proofs step
// never saw the files: a green database job said nothing about them.
//
// This file does not run them. It pins that they are where that job runs
// them, in the shape that step requires, so a skip cannot be mistaken for a
// pass again.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const PROOFS = [
  "supabase/proofs/20261108170000-a-walker-has-a-dog-cap.sql",
  "supabase/proofs/20261108170100-a-walk-plan-has-a-walker.sql",
  "supabase/proofs/20261108170200-walker-assignment-is-narrow-and-atomic.sql",
];
const RACE = "tests/integration/walker-assignment-is-narrow-and-atomic.db.test.ts";

describe("the walker proofs run in the database job", () => {
  const workflow = read(".github/workflows/sandboxes.yml");
  const db = workflow.slice(workflow.indexOf("\n  database:"), workflow.indexOf("\n  viewports:"));

  it("is the job that executes supabase/proofs and the integration suite", () => {
    expect(db).toContain("for f in supabase/proofs/*.sql; do");
    expect(db).toMatch(/psql "\$DB_URL" -v ON_ERROR_STOP=1 -q -f "\$f"/);
    expect(db).toContain("run: npm run test:db");
    expect(read("tests/run-db-tests.sh")).toContain("run tests/integration/*.db.test.ts");
  });

  it("holds each proof in supabase/proofs, self-contained, rolled back, with a mutation", () => {
    for (const f of PROOFS) {
      expect(existsSync(join(root, f)), f).toBe(true);
      const sql = read(f);
      expect(sql, f).toContain("\\set ON_ERROR_STOP on");
      expect(sql, f).toMatch(/^BEGIN;$/m);
      expect(sql, f).toMatch(/^ROLLBACK;$/m);
      // The job has already replayed every migration; a proof that applied
      // one again would be testing a second copy.
      expect(sql, f).not.toContain("\\i :");
      // supabase/proofs/README.md: every file ends with a mutation test that
      // must reproduce the fault, or the file raises INCONCLUSIVE.
      expect(sql, f).toContain("PROOF INCONCLUSIVE [mutation]");
      expect(sql, f).toMatch(/ok: mutation reproduces/);
    }
  });

  it("leaves no copy in tests/sql for a wrapper to skip", () => {
    for (const f of [
      "tests/sql/a-walker-has-a-dog-cap.proof.sql",
      "tests/sql/a-walk-plan-has-a-walker.proof.sql",
      "tests/a-walker-has-a-dog-cap-in-a-real-database.test.ts",
      "tests/a-walk-plan-has-a-walker-in-a-real-database.test.ts",
    ])
      expect(existsSync(join(root, f)), f).toBe(false);
  });

  it("gives the race test its two sessions, and fails rather than skip without them", () => {
    expect(read("tests/run-db-tests.sh")).toContain(
      'export TEST_SUPABASE_DB_URL="${DB_URL:?supabase status did not report a DB_URL}"',
    );
    const race = read(RACE);
    expect(race).toContain("describe.skipIf(!dbEnabled)");
    expect(race).toContain(
      'expect(PG_URL, "TEST_SUPABASE_DB_URL (tests/run-db-tests.sh exports it)").toBeTruthy()',
    );
    // It checks psql is there and fails if not (this file runs no proof itself).
    expect(race).toContain('["--version"]).status, "psql").toBe(0)');
    // Interleaving is forced through pg_stat_activity, not slept into.
    expect(race).toContain("wait_event_type = 'Lock'");
    expect(race).not.toMatch(/setTimeout\(r, [1-9]\d{3,}\)/);
  });
});
