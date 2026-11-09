/**
 * The browser sweep never ran on a change to the browser sweep.
 *
 * ── THE BUG ───────────────────────────────────────────────────────────────
 *
 * `sandboxes.yml` gained a `pull_request` trigger so a migration could not
 * reach main before anything replayed it. The path filter listed
 * `supabase/migrations/**`, `supabase/proofs/**` and the workflow file, and
 * the `viewports` job carried `if: github.event_name != 'pull_request'` so a
 * browser would not be spent on a .sql file.
 *
 * Both halves were reasonable and together they left the browser sweep
 * unable to run on a pull request at all -- including a pull request that
 * edits the specs it runs. Found on 2026-09-10, when #194 fixed a viewport
 * spec that had gone red on main: `ci.yml` went green without running a
 * browser, `sandboxes.yml` did not start, and the fix had to be dispatched by
 * hand to be tested by anything.
 *
 * ── WHY THIS IS NOT COVERED BY THE SPEC-COVERAGE TEST ─────────────────────
 *
 * `the-sweeps-are-not-the-whole-suite.test.ts` asserts every spec under
 * tests/viewports is NAMED by some step in this workflow. That is necessary
 * and it is not sufficient: being named by a step means nothing on a pull
 * request the workflow never runs on. This asserts the other half -- that a
 * change to those files starts the workflow, and reaches the job.
 *
 * ── AND WHY THE GATE MUST BE ABLE TO FAIL ─────────────────────────────────
 *
 * Both jobs are now `if: needs.changes.outputs.<name> == 'true'`. An output
 * that is empty, misspelled or unwritten does not read as "false" loudly --
 * it skips the job and reports the workflow GREEN, which is the exact shape
 * of every fault this file's neighbours were written for. So the gate script
 * is asserted to fail closed on each way it can fail to answer.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const workflow = () => read(".github/workflows/sandboxes.yml");

/**
 * The workflow with its comment lines removed.
 *
 * Written because the first version of the guard below matched the comment
 * that EXPLAINS the removed `if: github.event_name != 'pull_request'`, and
 * failed on a file where the guard was correctly gone. That is the same false
 * match `codeOnly()` exists for in the TypeScript tests, and the one
 * `post_credit_entry`'s $post$ block hit against prosrc. A rule about
 * configuration must not be satisfiable by prose about configuration.
 */
const workflowCode = () =>
  workflow()
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

/** The `paths:` list under the `pull_request:` trigger, in order. */
function pullRequestPaths(): string[] {
  const yml = workflow();
  const block = yml.match(/\n {2}pull_request:\n {4}paths:\n((?: {6}- .*\n)+)/);
  if (!block) throw new Error("sandboxes.yml has no pull_request paths block");
  return [...block[1].matchAll(/ {6}- "(.+)"/g)].map((m) => m[1]);
}

/** The body of the gate step, read out of the workflow rather than retyped. */
function gateScript(): string {
  const yml = workflow();
  const m = yml.match(/\n {6}- id: decide\n[\s\S]*?\n {8}run: \|\n([\s\S]*?)\n\n {2}database:/);
  if (!m) throw new Error("sandboxes.yml has no `decide` step with a run block");
  return m[1];
}

describe("the workflow runs on the files it tests", () => {
  it("finds the workflow and its filter at all, so a green run means checked", () => {
    // The tripwire. Every assertion below is of the form "the list contains
    // X", and all of them pass on a list this parser failed to find.
    expect(pullRequestPaths().length).toBeGreaterThanOrEqual(4);
    expect(gateScript().length).toBeGreaterThan(200);
    // And that stripping comments left the configuration behind, rather than
    // producing an empty string every "not present" assertion would pass on.
    expect(workflowCode()).toMatch(/\n {2}viewports:\n/);
    expect(workflowCode()).toMatch(/\n {2}database:\n/);
    expect(workflowCode().length).toBeGreaterThan(2000);
  });

  it("admits a change to any viewport spec", () => {
    // The property, not the filename: every spec in the directory has to be
    // matched by some entry, so a spec added tomorrow is covered by the same
    // rule rather than by somebody remembering this test.
    const paths = pullRequestPaths();
    const covers = (file: string) =>
      paths.some((p) => (p.endsWith("/**") ? file.startsWith(p.slice(0, -2)) : p === file));

    const uncovered = readdirSync(join(root, "tests/viewports"))
      .filter((f) => f.endsWith(".spec.ts"))
      .map((f) => `tests/viewports/${f}`)
      .filter((f) => !covers(f))
      .map((f) => `${f} can be changed without starting sandboxes.yml`);

    expect(uncovered).toEqual([]);
  });

  it("admits the config that decides what every spec does", () => {
    // playwright.config.ts carries the timeouts, retries: 0 and the dev
    // server. Changing it changes the outcome of every spec while touching
    // none of them.
    expect(pullRequestPaths()).toContain("playwright.config.ts");
  });

  it("still admits the migration paths the trigger was added for", () => {
    expect(pullRequestPaths()).toEqual(
      expect.arrayContaining(["supabase/migrations/**", "supabase/proofs/**"]),
    );
  });

  it("admits every integration DB test and the script that runs them", () => {
    const paths = pullRequestPaths();
    expect(paths).toEqual(
      expect.arrayContaining(["tests/integration/*.db.test.ts", "tests/run-db-tests.sh"]),
    );

    const script = read("tests/run-db-tests.sh");
    const uncovered = readdirSync(join(root, "tests/integration"))
      .filter((f) => f.endsWith(".db.test.ts"))
      .map((f) => `tests/integration/${f}`)
      .filter((f) => !script.includes(f) && !script.includes("tests/integration/*.db.test.ts"));

    expect(uncovered).toEqual([]);
  });

  it("admits and routes every support module a DB test imports (#683)", () => {
    // A DB test's outcome is decided by what it imports as much as by its
    // own file: every-select-embed-resolves sends whatever select-embeds.ts
    // collects. A change to one of these has to start the database job.
    const paths = pullRequestPaths();
    const gate = gateScript();
    const imported = new Set<string>();
    for (const f of readdirSync(join(root, "tests/integration"))) {
      if (!f.endsWith(".db.test.ts")) continue;
      for (const m of read(`tests/integration/${f}`).matchAll(/from "\.\.\/support\/([\w-]+)"/g))
        imported.add(`tests/support/${m[1]}.ts`);
    }
    expect(imported.size).toBeGreaterThanOrEqual(4);
    expect(imported).toContain("tests/support/select-embeds.ts");
    const missing = [...imported].filter(
      (f) =>
        !paths.includes(f) ||
        !new RegExp(`(^|[\\s|])${f.replace(/[.]/g, "\\.")}[|)]`, "m").test(gate),
    );
    expect(
      missing,
      `${missing.join(", ")}: not admitted by the trigger or not routed to the database job`,
    ).toEqual([]);
  });

  it("lets the browser sweep reach a pull request", () => {
    const yml = workflowCode();
    const viewports = yml.slice(yml.indexOf("\n  viewports:"));
    // The old guard. Nothing may reinstate a blanket refusal of pull
    // requests on this job -- that is the bug, not a safety net.
    expect(viewports).not.toMatch(/if:\s*github\.event_name\s*!=\s*'pull_request'/);
    expect(viewports).toMatch(/if:\s*needs\.changes\.outputs\.viewports\s*==\s*'true'/);
    expect(viewports).toMatch(/needs:\s*changes/);
  });

  it("gates the database job on its own inputs too", () => {
    const yml = workflowCode();
    const database = yml.slice(yml.indexOf("\n  database:"), yml.indexOf("\n  viewports:"));
    expect(database).toMatch(/if:\s*needs\.changes\.outputs\.database\s*==\s*'true'/);
    expect(database).toMatch(/needs:\s*changes/);
  });

  it("declares both outputs the two jobs read", () => {
    // A job reading `needs.changes.outputs.viewports` when the gate declares
    // only `database` gets an empty string, which is not 'true', which skips
    // the job silently and passes the workflow.
    const yml = workflowCode();
    const changes = yml.slice(yml.indexOf("\n  changes:"), yml.indexOf("\n  database:"));
    expect(changes).toMatch(/database:\s*\$\{\{\s*steps\.decide\.outputs\.database\s*\}\}/);
    expect(changes).toMatch(/viewports:\s*\$\{\{\s*steps\.decide\.outputs\.viewports\s*\}\}/);
  });
});

describe("the gate fails rather than answering no", () => {
  it("refuses to continue on a shell error", () => {
    // Without this, any failing command mid-script leaves the two echoes
    // unreached and both jobs skipped on a green workflow.
    expect(gateScript()).toMatch(/set -euo pipefail/);
  });

  it("fails when the payload carries no shas to compare", () => {
    expect(gateScript()).toMatch(/-z "\$BASE"\s*\]\s*\|\|\s*\[\s*-z "\$HEAD"/);
  });

  it("fails when the diff command itself fails", () => {
    expect(gateScript()).toMatch(/if ! changed=\$\(git diff --name-only/);
  });

  it("fails on an empty diff instead of reporting nothing changed", () => {
    // An empty diff on a pull request that started this workflow is not a
    // pull request with no changes -- it is a comparison that did not work.
    // Reading it as "false, false" skips both jobs and reports green.
    expect(gateScript()).toMatch(/-z "\$changed"/);
  });

  it("rejects an answer that is neither true nor false", () => {
    expect(gateScript()).toMatch(/neither true nor false/);
  });

  it("runs both jobs when the trigger is not a pull request", () => {
    // push-to-main and workflow_dispatch never had a path filter, and must
    // not acquire one by way of the gate.
    const s = gateScript();
    expect(s).toMatch(/\$EVENT" != "pull_request"/);
    const branch = s.slice(s.indexOf('!= "pull_request"'), s.indexOf("exit 0"));
    expect(branch).toMatch(/database=true/);
    expect(branch).toMatch(/viewports=true/);
  });
});
