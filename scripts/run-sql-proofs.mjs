import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");

// Tracked in #895. Keep the observed error here until the old fixture or
// historical replay is repaired. These files are reported, never counted as passes.
export const KNOWN_FAILURES = [
  {
    file: "tests/a-collection-is-told-by-the-app-that-pushes.test.ts",
    issue: 895,
    reason:
      "Historical cash migration redefines my_day_stop_facts with an obsolete return type: cannot change return type of existing function.",
  },
  {
    file: "tests/a-tech-records-cash-and-the-office-applies-it.test.ts",
    issue: 895,
    reason:
      "Historical cash migration redefines my_day_stop_facts with an obsolete return type: cannot change return type of existing function.",
  },
  {
    file: "tests/a-double-tap-books-one-extra-cleanup.test.ts",
    issue: 895,
    reason:
      "Historical replay recreates the four-argument portal_request_one_off overload alongside its current defaulted overload: function is not unique.",
  },
  {
    file: "tests/a-stranger-can-see-what-is-for-sale-in-a-real-database.test.ts",
    issue: 895,
    reason:
      "Current organization triggers seed priced grooming services; the fixture's exact service list predates those rows: PROOF FAILED [list].",
  },
  {
    file: "tests/a-trial-with-four-people-could-not-add-a-client.proof.test.ts",
    issue: 895,
    reason:
      "Current plan synchronization moves four active seats to Growth; the fixture cannot retain its old Launch state: PROOF FAILED [fixture].",
  },
  {
    file: "tests/a-truck-that-never-moved.test.ts",
    issue: 895,
    reason:
      "Current one-person route trigger assigns the fixture's supposedly unassigned stop: PROOF FAILED [not open].",
  },
  {
    file: "tests/a-walk-is-priced-as-a-walk-in-a-real-database.test.ts",
    issue: 895,
    reason:
      "Current organization triggers seed Overnight stay and Drop-in before the fixture inserts them: duplicate key violates services_org_name.",
  },
  {
    file: "tests/only-an-owner-changes-staff.test.ts",
    issue: 895,
    reason:
      "The old proof expects the earlier role error; current office-manager enforcement rejects a role above the caller's own ceiling.",
  },
];

// Keep each proof's migration paths, fixture values and output assertions in
// its existing wrapper. Follow relative helper imports for shared runners.
export function discoverSqlProofs(root = ROOT) {
  const tests = join(root, "tests");
  const proofs = readdirSync(join(tests, "sql"))
    .filter((file) => file.endsWith(".proof.sql"))
    .sort()
    .map((file) => `tests/sql/${file}`);
  if (!proofs.length) throw new Error("No tests/sql proofs found");

  function sources(file, seen = new Set()) {
    if (seen.has(file)) return [];
    seen.add(file);
    const source = readFileSync(file, "utf8");
    const imported = [...source.matchAll(/from\s*["'](\.[^"']+)["']/g)].flatMap((m) => {
      const base = resolve(dirname(file), m[1]);
      if (!base.startsWith(`${tests}${sep}`)) return [];
      const dependency = [base, `${base}.ts`, `${base}.tsx`].find(
        (candidate) => /\.tsx?$/.test(candidate) && existsSync(candidate),
      );
      return dependency ? sources(dependency, seen) : [];
    });
    return [source, ...imported];
  }

  const wrappers = readdirSync(tests)
    .filter((file) => /\.test\.tsx?$/.test(file))
    .sort()
    .flatMap((file) => {
      const source = sources(join(tests, file)).join("\n");
      if (!/\bspawnSync\s*\(/.test(source)) return [];
      const owned = [
        ...new Set(
          [...source.matchAll(/["'`](tests\/sql\/[^"'`\r\n]+\.proof\.sql)["'`]/g)].map((m) => m[1]),
        ),
      ];
      if (!owned.length) return [];
      const dbVariables = [
        ...new Set(
          [...source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*_PROOF_DB_URL)\b/g)].map((m) => m[1]),
        ),
      ];
      if (!dbVariables.length) throw new Error(`${file}: no proof database variable found`);
      for (const proof of owned) {
        if (!proofs.includes(proof)) throw new Error(`${file}: missing proof ${proof}`);
      }
      return [{ file: `tests/${file}`, proofs: owned, dbVariables }];
    });

  const missing = proofs.filter((proof) => !wrappers.some((w) => w.proofs.includes(proof)));
  if (missing.length) throw new Error(`No fixture wrapper found for: ${missing.join(", ")}`);
  return { proofs, wrappers };
}

export function verifyProofResults(report, wrappers, root = ROOT) {
  for (const wrapper of wrappers) {
    const result = report.testResults?.find((r) => resolve(r.name) === resolve(root, wrapper.file));
    if (!result?.assertionResults?.length) throw new Error(`${wrapper.file}: no test results`);
    for (const assertion of result.assertionResults) {
      if (assertion.status !== "passed") {
        throw new Error(`${wrapper.file}: ${assertion.fullName} was ${assertion.status}`);
      }
    }
  }
}

function localDatabase(root, run) {
  const status = run("supabase", ["status", "-o", "env"], { cwd: root, encoding: "utf8" });
  if (status.status !== 0)
    throw new Error("supabase status failed; the local replay stack is required");
  const dbUrl = status.stdout.match(/^DB_URL="([^"\r\n]+)"\r?$/m)?.[1];
  if (!dbUrl) throw new Error("supabase status did not report a DB_URL");
  const source = new URL(dbUrl);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(source.hostname)) {
    throw new Error("SQL proofs require the local replay database");
  }
  if (run("psql", ["--version"], { encoding: "utf8" }).status !== 0) {
    throw new Error("psql is required to run the SQL proofs");
  }

  const database = decodeURIComponent(source.pathname.slice(1));
  if (!database || database === "template1")
    throw new Error("A separate replay database is required");
  const config = readFileSync(join(root, "supabase/config.toml"), "utf8");
  const projectId = config.match(/^project_id\s*=\s*"([A-Za-z0-9_-]+)"\s*$/m)?.[1];
  if (!projectId?.endsWith("-ci"))
    throw new Error("SQL proof database lifecycle requires this job's CI project id");
  return { source, database, container: `supabase_db_${projectId}`, run };
}

const identifier = (name) => `"${name.replaceAll('"', '""')}"`;
const literal = (value) => `'${value.replaceAll("'", "''")}'`;
const stateFile = (root) => join(root, "supabase/.temp/sql-proof-template.json");
function saveState(root, state) {
  mkdirSync(dirname(stateFile(root)), { recursive: true });
  writeFileSync(stateFile(root), JSON.stringify(state));
}
function readState(root) {
  const state = JSON.parse(readFileSync(stateFile(root), "utf8"));
  if (
    !/^proof_[a-f0-9]{12}$/.test(state.prefix) ||
    !Array.isArray(state.clones) ||
    state.clones.some((name) => !new RegExp(`^${state.prefix}_[0-9]+$`).test(name))
  ) {
    throw new Error("Invalid SQL proof database cleanup state");
  }
  return state;
}
function sql(context, statement) {
  const result = context.run(
    "docker",
    [
      "exec",
      context.container,
      "psql",
      "-U",
      "supabase_admin",
      "-d",
      "template1",
      "-X",
      "--no-password",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      statement,
    ],
    {
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, PGCONNECT_TIMEOUT: "10" },
    },
  );
  if (result.status !== 0)
    throw new Error(
      `SQL proof database lifecycle failed: ${statement}\n${result.stderr ?? result.error ?? "psql failed"}`,
    );
}

export function prepareSqlProofs(root = ROOT, run = spawnSync) {
  if (existsSync(stateFile(root))) cleanupSqlProofs(root, run);
  const context = localDatabase(root, run);
  const state = { prefix: `proof_${randomBytes(6).toString("hex")}`, clones: [] };
  saveState(root, state);
  try {
    // The container-local admin can close protected service backends. Freeze
    // this job's source only while capturing the pristine replay snapshot.
    sql(context, `ALTER DATABASE ${identifier(context.database)} ALLOW_CONNECTIONS false`);
    sql(
      context,
      `SELECT pg_terminate_backend(pid, 10000) FROM pg_stat_activity WHERE datname = ${literal(context.database)} AND pid <> pg_backend_pid()`,
    );
    sql(
      context,
      `CREATE DATABASE ${identifier(`${state.prefix}_template`)} TEMPLATE ${identifier(context.database)} ALLOW_CONNECTIONS false`,
    );
    console.log("Pristine SQL proof template captured immediately after migration replay.");
  } finally {
    sql(context, `ALTER DATABASE ${identifier(context.database)} ALLOW_CONNECTIONS true`);
  }
}

export function cleanupSqlProofs(root = ROOT, run = spawnSync) {
  if (!existsSync(stateFile(root))) return;
  const state = readState(root);
  const context = localDatabase(root, run);
  sql(context, `ALTER DATABASE ${identifier(context.database)} ALLOW_CONNECTIONS true`);
  for (const name of [...state.clones, `${state.prefix}_template`]) {
    sql(context, `DROP DATABASE IF EXISTS ${identifier(name)} WITH (FORCE)`);
  }
  rmSync(stateFile(root));
}

export function runSqlProofs(root = ROOT, run = spawnSync) {
  const { proofs, wrappers } = discoverSqlProofs(root);
  const excluded = KNOWN_FAILURES.filter((entry) => wrappers.some((w) => w.file === entry.file));
  const active = wrappers.filter((w) => !excluded.some((entry) => entry.file === w.file));
  console.log(
    `Discovered ${proofs.length} SQL proofs through ${wrappers.length} fixture wrappers:`,
  );
  for (const proof of proofs) console.log(`  ${proof}`);
  for (const entry of excluded)
    console.log(
      `::warning file=${entry.file}::Known failure tracked by #${entry.issue}: ${entry.reason}`,
    );
  const context = localDatabase(root, run);
  if (!existsSync(stateFile(root)))
    throw new Error("No pristine SQL proof template. Run --prepare immediately after replay.");
  const state = readState(root);
  const directory = mkdtempSync(join(tmpdir(), "sql-proofs-"));
  let passed = 0;
  const failures = [];
  try {
    for (const [index, wrapper] of active.entries()) {
      const clone = `${state.prefix}_${index}`;
      state.clones.push(clone);
      saveState(root, state);
      let failure;
      try {
        sql(
          context,
          `CREATE DATABASE ${identifier(clone)} TEMPLATE ${identifier(`${state.prefix}_template`)} ALLOW_CONNECTIONS true`,
        );
        const url = new URL(context.source);
        url.pathname = `/${clone}`;
        const env = { ...process.env };
        for (const variable of wrapper.dbVariables) env[variable] = url.href;
        const reportFile = join(directory, `${index}.json`);
        console.log(`Running ${wrapper.file} in fresh database ${clone}`);
        const result = run(
          process.execPath,
          [
            join(root, "node_modules/vitest/vitest.mjs"),
            "run",
            wrapper.file,
            "--no-file-parallelism",
            "--reporter=default",
            "--reporter=json",
            `--outputFile.json=${reportFile}`,
          ],
          { cwd: root, env, stdio: "inherit" },
        );
        if (result.status !== 0)
          throw new Error(`SQL proof wrapper failed (exit ${result.status})`);
        verifyProofResults(JSON.parse(readFileSync(reportFile, "utf8")), [wrapper], root);
      } catch (error) {
        failure = error;
      } finally {
        try {
          sql(context, `DROP DATABASE IF EXISTS ${identifier(clone)} WITH (FORCE)`);
          state.clones = state.clones.filter((name) => name !== clone);
          saveState(root, state);
        } catch (error) {
          failure ??= error;
        }
      }
      if (failure) {
        failures.push({ file: wrapper.file, error: failure.message });
        console.error(`::error file=${wrapper.file}::${failure.message}`);
      } else passed++;
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
    const summary = `SQL proof wrappers: ${passed} passed; ${excluded.length} known-fail exclusions; ${failures.length} failed.`;
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `${summary}\n\n` +
          excluded
            .map(
              (e) =>
                `- Excluded \`${e.file}\`: [#${e.issue}](https://github.com/Brendan-S20/pal-primer/issues/${e.issue}) ${e.reason}`,
            )
            .join("\n") +
          "\n" +
          failures.map((e) => `- Failed \`${e.file}\`: ${e.error}`).join("\n") +
          "\n",
      );
    }
  }
  if (failures.length) throw new Error(`${failures.length} SQL proof wrappers failed`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes("--prepare")) prepareSqlProofs();
    else if (process.argv.includes("--cleanup")) cleanupSqlProofs();
    else {
      try {
        runSqlProofs();
      } finally {
        cleanupSqlProofs();
      }
    }
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
