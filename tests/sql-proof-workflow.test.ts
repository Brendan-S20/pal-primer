import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverSqlProofs, runSqlProofs, verifyProofResults } from "../scripts/run-sql-proofs.mjs";

vi.setConfig({ testTimeout: 300_000 });

const root = join(import.meta.dirname, "..");
const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "sql-proof-runner-test-"));
  temporary.push(directory);
  mkdirSync(join(directory, "tests/sql"), { recursive: true });
  const proof = ["tests", "sql", "fixture.proof.sql"].join("/");
  const file = "tests/fixture.test.ts";
  writeFileSync(join(directory, proof), "\\set ON_ERROR_STOP on\n");
  writeFileSync(
    join(directory, file),
    [
      `const PROOF = ${JSON.stringify(proof)};`,
      "const DB_URL = process.env.FIXTURE_PROOF_DB_URL;",
      'spawnSync("psql", [DB_URL, "-f", PROOF]);',
    ].join("\n"),
  );
  return { directory, proof, file };
}

function report(directory: string, file: string, status = "passed") {
  return {
    testResults: [
      {
        name: join(directory, file),
        assertionResults: [{ fullName: "executes the SQL proof", status }],
      },
    ],
  };
}

describe("SQL proof discovery", () => {
  it("accounts for every proof on disk, including TSX and shared helpers", () => {
    const inventory = discoverSqlProofs(root);
    expect(inventory.proofs).toEqual(
      readdirSync(join(root, "tests/sql"))
        .filter((file) => file.endsWith(".proof.sql"))
        .sort()
        .map((file) => `tests/sql/${file}`),
    );
    expect(inventory.proofs.length).toBeGreaterThan(0);
    expect(
      inventory.wrappers.some((w) => w.file === "tests/visit-checklist-per-line.test.tsx"),
    ).toBe(true);
    const shared = inventory.wrappers.filter((w) =>
      w.dbVariables.includes("FIRST_CLEANUP_PROOF_DB_URL"),
    );
    expect(shared.map((w) => w.file)).toEqual([
      "tests/a-first-cleanup-is-priced-by-how-long-the-yard-has-waited.test.ts",
      "tests/first-cleanup-pricing-starts-off-and-changes-nothing.test.ts",
      "tests/the-signup-charges-the-databases-price-not-the-browsers.test.ts",
    ]);
    expect(
      inventory.wrappers.some(
        (w) => w.file === "tests/a-walker-proof-runs-where-a-database-does.test.ts",
      ),
    ).toBe(false);
    for (const proof of inventory.proofs) {
      expect(
        inventory.wrappers.some((w) => w.proofs.includes(proof)),
        proof,
      ).toBe(true);
    }
  });

  it("fails when a proof has no wrapper", () => {
    const { directory, proof } = fixture();
    rmSync(join(directory, "tests/fixture.test.ts"));
    expect(() => discoverSqlProofs(directory)).toThrow(`No fixture wrapper found for: ${proof}`);
  });

  it("fails when a wrapper cannot be pointed at the replay database", () => {
    const { directory, file } = fixture();
    writeFileSync(
      join(directory, file),
      readFileSync(join(directory, file), "utf8").replace(
        "process.env.FIXTURE_PROOF_DB_URL",
        '"hardcoded"',
      ),
    );
    expect(() => discoverSqlProofs(directory)).toThrow("no proof database variable");
  });
});

describe("SQL proof results", () => {
  it.each(["pending", "skipped", "todo", "failed"])("rejects a %s assertion", (status) => {
    const { directory, file } = fixture();
    const { wrappers } = discoverSqlProofs(directory);
    expect(() => verifyProofResults(report(directory, file, status), wrappers, directory)).toThrow(
      status,
    );
  });

  it("rejects missing wrappers and empty assertion lists", () => {
    const { directory, file } = fixture();
    const { wrappers } = discoverSqlProofs(directory);
    expect(() => verifyProofResults({ testResults: [] }, wrappers, directory)).toThrow(
      "no test results",
    );
    const empty = report(directory, file);
    empty.testResults[0].assertionResults = [];
    expect(() => verifyProofResults(empty, wrappers, directory)).toThrow("no test results");
  });

  it.each([0, 1])("uses the replay URL and propagates Vitest exit %i", (exitCode) => {
    const { directory, file } = fixture();
    const run = vi.fn((command, args, options) => {
      if (command === "supabase") {
        expect(args).toEqual(["status", "-o", "env"]);
        return {
          status: 0,
          stdout: 'DB_URL="postgresql://postgres:postgres@127.0.0.1:54522/postgres"\n',
        };
      }
      if (command === "psql") return { status: 0 };
      expect(command).toBe(process.execPath);
      expect(args).toContain(file);
      expect(args).toContain("--no-file-parallelism");
      expect(options.env.FIXTURE_PROOF_DB_URL).toBe(
        "postgresql://postgres:postgres@127.0.0.1:54522/postgres",
      );
      const output = args.find((arg) => arg.startsWith("--outputFile.json=")).split("=")[1];
      writeFileSync(output, JSON.stringify(report(directory, file)));
      return { status: exitCode };
    });
    if (exitCode) expect(() => runSqlProofs(directory, run)).toThrow("exit 1");
    else expect(() => runSqlProofs(directory, run)).not.toThrow();
    expect(run).toHaveBeenCalledTimes(3);
  });

  it.each([
    [{ status: 1, stdout: "" }, "supabase status failed"],
    [{ status: 0, stdout: "" }, "did not report a DB_URL"],
    [
      { status: 0, stdout: 'DB_URL="postgresql://postgres@example.invalid/postgres"\n' },
      "local replay database",
    ],
  ])("fails before Vitest when the stack cannot supply a local URL", (status, message) => {
    const { directory } = fixture();
    const run = vi.fn(() => status);
    expect(() => runSqlProofs(directory, run)).toThrow(message);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("the SQL proofs run in the migrations-alone job", () => {
  const workflow = readFileSync(join(root, ".github/workflows/sandboxes.yml"), "utf8");

  it("runs after replay, before the behavioural seed, without allowing failure", () => {
    const db = workflow.slice(
      workflow.indexOf("\n  database:"),
      workflow.indexOf("\n  viewports:"),
    );
    const command = db.indexOf("run: node scripts/run-sql-proofs.mjs");
    expect(command).toBeGreaterThan(db.indexOf("- name: Replay every migration"));
    expect(command).toBeLessThan(db.indexOf("\n          npm run test:e2e"));
    expect(db).toContain("name: A database built from the migrations alone");
    expect(db.slice(db.lastIndexOf("      - name:", command), command)).not.toMatch(
      /continue-on-error|if:/,
    );
  });

  it.each([["tests", "sql", "example.proof.sql"].join("/"), "scripts/run-sql-proofs.mjs"])(
    "routes %s to the database job",
    (file) => {
      const paths = workflow.slice(
        workflow.indexOf("  pull_request:"),
        workflow.indexOf("    types:"),
      );
      expect(paths).toContain(
        file.startsWith("tests/sql/") ? '"tests/sql/**"' : JSON.stringify(file),
      );
      const loop = workflow.match(
        / {10}database=false\n {10}viewports=false\n([\s\S]*?) {10}done <<< "\$changed"/,
      )?.[1];
      expect(loop).toBeTruthy();
      const script = `database=false\nviewports=false\nchanged=$1\n${loop}done <<< "$changed"\nprintf '%s %s' "$database" "$viewports"`;
      const result = spawnSync("bash", ["-c", script, "gate-test", file], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("true false");
    },
  );
});
