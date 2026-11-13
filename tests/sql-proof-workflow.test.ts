import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KNOWN_FAILURES,
  cleanupSqlProofs,
  discoverSqlProofs,
  prepareSqlProofs,
  runSqlProofs,
  verifyProofResults,
} from "../scripts/run-sql-proofs.mjs";

vi.setConfig({ testTimeout: 300_000 });

const root = join(import.meta.dirname, "..");
const temporary: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "sql-proof-runner-test-"));
  temporary.push(directory);
  mkdirSync(join(directory, "tests/sql"), { recursive: true });
  mkdirSync(join(directory, "supabase"), { recursive: true });
  writeFileSync(join(directory, "supabase/config.toml"), 'project_id = "fixture-ci"\n');
  return { directory, ...addWrapper(directory, "fixture") };
}

function addWrapper(directory: string, name: string, file = `tests/${name}.test.ts`) {
  const proof = ["tests", "sql", `${name}.proof.sql`].join("/");
  writeFileSync(join(directory, proof), "\\set ON_ERROR_STOP on\n");
  writeFileSync(
    join(directory, file),
    [
      `const PROOF = ${JSON.stringify(proof)};`,
      "const DB_URL = process.env.FIXTURE_PROOF_DB_URL;",
      'spawnSync("psql", [DB_URL, "-f", PROOF]);',
    ].join("\n"),
  );
  return { proof, file };
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

const originalUrl = "postgresql://postgres:postgres@127.0.0.1:54522/postgres";
const stateFile = (directory: string) => join(directory, "supabase/.temp/sql-proof-template.json");

function runtime(
  directory: string,
  failure: "vitest" | "report" | "skip" | "template" | "auth" | undefined = undefined,
) {
  const statements: string[] = [];
  const wrappers: Array<{ file: string; url: string; output: string }> = [];
  const run = vi.fn((command, args, options) => {
    if (command === "supabase") return { status: 0, stdout: `DB_URL="${originalUrl}"\n` };
    if (command === "psql") {
      expect(args).toEqual(["--version"]);
      return { status: 0, stdout: "psql 17" };
    }
    if (command === "docker") {
      if (args[0] === "restart") {
        expect(args).toEqual(["restart", "--time", "10", "supabase_auth_fixture-ci"]);
        return { status: 0, stdout: "supabase_auth_fixture-ci\n" };
      }
      if (args[0] === "inspect") {
        expect(args).toEqual([
          "inspect",
          "--format",
          "{{.State.Health.Status}}",
          "supabase_auth_fixture-ci",
        ]);
        return { status: 0, stdout: failure === "auth" ? "unhealthy\n" : "healthy\n" };
      }
      expect(args.slice(0, 7)).toEqual([
        "exec",
        "supabase_db_fixture-ci",
        "psql",
        "-U",
        "supabase_admin",
        "-d",
        "template1",
      ]);
      expect(args).toContain("--no-password");
      const sql = args[args.indexOf("-c") + 1];
      expect(sql).toBeTypeOf("string");
      expect(args).toContain("ON_ERROR_STOP=1");
      statements.push(sql);
      return {
        status: failure === "template" && /CREATE DATABASE/.test(sql) ? 1 : 0,
        stdout: "",
        stderr: "mock database command",
      };
    }
    expect(command).toBe(process.execPath);
    const file = args.find((arg) => /\.test\.tsx?$/.test(arg));
    const output = args.find((arg) => arg.startsWith("--outputFile.json=")).split("=")[1];
    wrappers.push({ file, url: options.env.FIXTURE_PROOF_DB_URL, output });
    expect(args).toContain("--no-file-parallelism");
    const first = wrappers.length === 1;
    if (!(failure === "report" && first)) {
      writeFileSync(
        output,
        JSON.stringify(report(directory, file, failure === "skip" && first ? "pending" : "passed")),
      );
    }
    return { status: failure === "vitest" && first ? 1 : 0 };
  });
  return { run, statements, wrappers };
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
});

describe("SQL proof database lifecycle", () => {
  it("refuses a non-CI project before mutating a database", () => {
    const { directory } = fixture();
    writeFileSync(join(directory, "supabase/config.toml"), 'project_id = "fixture"\n');
    const { run, statements, wrappers } = runtime(directory);
    expect(() => prepareSqlProofs(directory, run)).toThrow();
    expect(run.mock.calls.some(([command]) => command === "docker")).toBe(false);
    expect(statements).toEqual([]);
    expect(wrappers).toEqual([]);
    expect(existsSync(stateFile(directory))).toBe(false);
  });

  it("captures a replay snapshot while connections are blocked, then restores the source", () => {
    const { directory } = fixture();
    const { run, statements } = runtime(directory);
    prepareSqlProofs(directory, run);
    const state = JSON.parse(readFileSync(stateFile(directory), "utf8"));
    expect(state.prefix).toMatch(/^proof_[a-f0-9]{12}$/);
    expect(state.clones).toEqual([]);
    expect(statements[0]).toMatch(/ALTER DATABASE\s+"?postgres"?\s+ALLOW_CONNECTIONS false/i);
    expect(statements[1]).toMatch(/pg_terminate_backend/);
    expect(statements[2]).toContain(`${state.prefix}_template`);
    expect(statements[2]).toMatch(
      /CREATE DATABASE.*TEMPLATE\s+"?postgres"?.*ALLOW_CONNECTIONS false/i,
    );
    expect(statements.at(-1)).toMatch(/ALTER DATABASE\s+"?postgres"?\s+ALLOW_CONNECTIONS true/i);
  });

  it("restarts Auth after source connections are restored and checks its health", () => {
    const { directory } = fixture();
    const { run } = runtime(directory);
    prepareSqlProofs(directory, run);
    const restored = run.mock.calls.findIndex(
      ([command, args]) =>
        command === "docker" &&
        args[0] === "exec" &&
        args.some((arg) => /ALTER DATABASE.*ALLOW_CONNECTIONS true/i.test(arg)),
    );
    const restarted = run.mock.calls.findIndex(
      ([command, args]) => command === "docker" && args[0] === "restart",
    );
    const inspected = run.mock.calls.findIndex(
      ([command, args]) => command === "docker" && args[0] === "inspect",
    );
    expect(restored).toBeGreaterThanOrEqual(0);
    expect(restarted).toBeGreaterThan(restored);
    expect(inspected).toBeGreaterThan(restarted);
  });

  it("fails preparation when restarted Auth is unhealthy", () => {
    const { directory } = fixture();
    const { run, statements } = runtime(directory, "auth");
    expect(() => prepareSqlProofs(directory, run)).toThrow();
    expect(statements.at(-1)).toMatch(/ALLOW_CONNECTIONS true/i);
    expect(
      run.mock.calls.filter(([command, args]) => command === "docker" && args[0] === "inspect"),
    ).toHaveLength(1);
  });

  it("restores source connections if creating the snapshot fails", () => {
    const { directory } = fixture();
    const { run, statements } = runtime(directory, "template");
    expect(() => prepareSqlProofs(directory, run)).toThrow();
    expect(statements.at(-1)).toMatch(/ALLOW_CONNECTIONS true/i);
    expect(
      run.mock.calls.some(([command, args]) => command === "docker" && args[0] === "restart"),
    ).toBe(false);
  });

  it("gives each wrapper a distinct clone and drops it after the test", () => {
    const { directory, file } = fixture();
    const other = addWrapper(directory, "second");
    const { run, wrappers, statements } = runtime(directory);
    prepareSqlProofs(directory, run);
    const prefix = JSON.parse(readFileSync(stateFile(directory), "utf8")).prefix;
    runSqlProofs(directory, run);
    expect(wrappers.map((wrapper) => wrapper.file)).toEqual([file, other.file]);
    expect(new Set(wrappers.map((wrapper) => wrapper.url)).size).toBe(2);
    for (const wrapper of wrappers) {
      expect(wrapper.url).not.toBe(originalUrl);
      const clone = new URL(wrapper.url).pathname.slice(1);
      expect(clone).toMatch(new RegExp(`^${prefix}_[0-9]+$`));
      expect(statements.some((sql) => sql.includes(clone) && /CREATE DATABASE/.test(sql))).toBe(
        true,
      );
      expect(
        statements.some((sql) => sql.includes(clone) && /DROP DATABASE.*FORCE/.test(sql)),
      ).toBe(true);
      expect(existsSync(wrapper.output)).toBe(false);
    }
    expect(JSON.parse(readFileSync(stateFile(directory), "utf8")).clones).toEqual([]);
  });

  it.each(["vitest", "report", "skip"] as const)(
    "drops failed clones, continues other wrappers, and fails the job after a %s failure",
    (failure) => {
      const { directory } = fixture();
      addWrapper(directory, "second");
      const { run, wrappers, statements } = runtime(directory, failure);
      prepareSqlProofs(directory, run);
      expect(() => runSqlProofs(directory, run)).toThrow();
      expect(wrappers).toHaveLength(2);
      for (const wrapper of wrappers) {
        const clone = new URL(wrapper.url).pathname.slice(1);
        expect(
          statements.some((sql) => sql.includes(clone) && /DROP DATABASE.*FORCE/.test(sql)),
        ).toBe(true);
        expect(existsSync(wrapper.output)).toBe(false);
      }
    },
  );

  it("refuses to run wrappers without the replay snapshot", () => {
    const { directory } = fixture();
    const { run, wrappers } = runtime(directory);
    expect(() => runSqlProofs(directory, run)).toThrow();
    expect(wrappers).toEqual([]);
  });

  it("drops outstanding clones and the snapshot during cleanup", () => {
    const { directory } = fixture();
    const { run, statements } = runtime(directory);
    prepareSqlProofs(directory, run);
    const state = JSON.parse(readFileSync(stateFile(directory), "utf8"));
    const clone = `${state.prefix}_0`;
    writeFileSync(stateFile(directory), JSON.stringify({ ...state, clones: [clone] }));
    cleanupSqlProofs(directory, run);
    for (const name of [clone, `${state.prefix}_template`]) {
      expect(statements.some((sql) => sql.includes(name) && /DROP DATABASE.*FORCE/.test(sql))).toBe(
        true,
      );
    }
    expect(
      statements.some((sql) => /ALTER DATABASE\s+"?postgres"?\s+ALLOW_CONNECTIONS true/i.test(sql)),
    ).toBe(true);
    expect(existsSync(stateFile(directory))).toBe(false);
  });

  it("names every exclusion with an issue and reason in the job summary", () => {
    const inventory = discoverSqlProofs(root);
    const filenames = inventory.wrappers.map((wrapper) => wrapper.file);
    expect(KNOWN_FAILURES.length).toBeGreaterThan(0);
    for (const exclusion of KNOWN_FAILURES) {
      expect(filenames).toContain(exclusion.file);
      expect(exclusion.issue).toBe(895);
      expect(exclusion.reason.trim().length).toBeGreaterThan(20);
    }
    const { directory } = fixture();
    const exclusion = KNOWN_FAILURES[0];
    addWrapper(directory, "excluded", exclusion.file);
    const summary = join(directory, "summary.md");
    vi.stubEnv("GITHUB_STEP_SUMMARY", summary);
    const { run, wrappers } = runtime(directory);
    prepareSqlProofs(directory, run);
    runSqlProofs(directory, run);
    expect(wrappers.some((wrapper) => wrapper.file === exclusion.file)).toBe(false);
    const written = readFileSync(summary, "utf8");
    expect(written).toContain(exclusion.file);
    expect(written).toContain("895");
    expect(written).toContain(exclusion.reason);
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
    expect(() => prepareSqlProofs(directory, run)).toThrow(message);
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
    const snapshot = db.indexOf("node scripts/run-sql-proofs.mjs --prepare");
    expect(snapshot).toBeGreaterThan(db.indexOf("- name: Replay every migration"));
    expect(snapshot).toBeLessThan(db.indexOf("run: npm run test:db"));
    expect(command).toBeGreaterThan(db.indexOf("- name: Replay every migration"));
    expect(command).toBeLessThan(db.indexOf("\n          npm run test:e2e"));
    expect(db).toContain("name: A database built from the migrations alone");
    const proofStep = db.slice(db.lastIndexOf("      - name:", command), command);
    expect(proofStep).not.toMatch(/continue-on-error/);
    expect(proofStep).toContain("if: ${{ !cancelled() && steps.replay.outcome == 'success' }}");
    const cleanup = db.indexOf("run: node scripts/run-sql-proofs.mjs --cleanup");
    expect(cleanup).toBeGreaterThan(command);
    expect(db.slice(db.lastIndexOf("      - name:", cleanup), cleanup)).toMatch(/if: always\(\)/);
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
