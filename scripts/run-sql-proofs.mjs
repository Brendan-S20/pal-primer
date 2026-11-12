import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");

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

export function runSqlProofs(root = ROOT, run = spawnSync) {
  const { proofs, wrappers } = discoverSqlProofs(root);
  console.log(`Running ${proofs.length} SQL proofs through ${wrappers.length} fixture wrappers:`);
  for (const proof of proofs) console.log(`  ${proof}`);

  const status = run("supabase", ["status", "-o", "env"], { cwd: root, encoding: "utf8" });
  if (status.status !== 0)
    throw new Error("supabase status failed; the local replay stack is required");
  const dbUrl = status.stdout.match(/^DB_URL="([^"\r\n]+)"\r?$/m)?.[1];
  if (!dbUrl) throw new Error("supabase status did not report a DB_URL");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(dbUrl).hostname)) {
    throw new Error("SQL proofs require the local replay database");
  }
  if (run("psql", ["--version"], { encoding: "utf8" }).status !== 0) {
    throw new Error("psql is required to run the SQL proofs");
  }

  const env = { ...process.env };
  for (const wrapper of wrappers) {
    for (const variable of wrapper.dbVariables) env[variable] = dbUrl;
  }
  const directory = mkdtempSync(join(tmpdir(), "sql-proofs-"));
  const reportFile = join(directory, "results.json");
  try {
    // One file at a time avoids lock waits while the wrappers check reachability.
    const result = run(
      process.execPath,
      [
        join(root, "node_modules/vitest/vitest.mjs"),
        "run",
        ...wrappers.map((w) => w.file),
        "--no-file-parallelism",
        "--reporter=default",
        "--reporter=json",
        `--outputFile.json=${reportFile}`,
      ],
      { cwd: root, env, stdio: "inherit" },
    );
    if (result.status !== 0) throw new Error(`SQL proof wrappers failed (exit ${result.status})`);
    verifyProofResults(JSON.parse(readFileSync(reportFile, "utf8")), wrappers, root);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runSqlProofs();
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
