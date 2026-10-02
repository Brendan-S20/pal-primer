// A password was the only lock.
//
// Two-step sign-in (Supabase MFA: an authenticator app, or a text once an SMS
// provider is connected) is optional per person. Once somebody turns it on, a
// session that signed in with the password alone must be able to read, write
// and pass NOTHING -- not just see a code screen, because the browser talks to
// the database directly. This file:
//
//   * runs tests/sql/a-password-was-the-only-lock.proof.sql against the local
//     stack: a two-step owner at aal1 reads nothing, writes nothing and fails
//     every permission helper; at aal2 works as before; a user without a
//     factor and the service role are untouched; every RLS table is covered;
//   * holds every LATER migration to the same rule: a table that gets row
//     level security gets the two-step policy too (require_mfa_policy);
//   * pins the app side: the shell sends an unfinished session to /two-step
//     BEFORE it loads the business, and /two-step only ever returns to a path
//     on this site.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { safeNextPath } from "@/lib/mfa";

const ROOT = join(import.meta.dirname, "..");
const MIG_DIR = join(ROOT, "supabase/migrations");
const THIS = "20261002010000_a-password-was-the-only-lock.sql";
const MIGRATION = join(MIG_DIR, THIS);
const PROOF = join(ROOT, "tests/sql/a-password-was-the-only-lock.proof.sql");
const DB_URL =
  process.env.WEBHOOKS_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

describe("every table added after this one", () => {
  const later = readdirSync(MIG_DIR)
    .filter((f) => f.endsWith(".sql") && f > THIS)
    .sort();

  it("that gets row level security also gets the two-step policy", () => {
    const missing: string[] = [];
    for (const f of later) {
      const sql = readFileSync(join(MIG_DIR, f), "utf8").replace(/--[^\n]*/g, "");
      for (const m of sql.matchAll(
        /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(public\.)?"?(\w+)"?\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi,
      )) {
        const table = m[2];
        const named = new RegExp(`require_mfa_policy\\(\\s*'(public\\.)?${table}'`, "i");
        if (!named.test(sql)) missing.push(`${f}: ${table}`);
      }
    }
    expect(
      missing,
      "Call SELECT public.require_mfa_policy('public.<table>'); after enabling RLS, " +
        "or a two-step user signed in with the password alone can read the table.",
    ).toEqual([]);
  });
});

describe("the app", () => {
  const shell = readFileSync(join(ROOT, "src/routes/_authenticated/route.tsx"), "utf8");

  it("sends an unfinished session to /two-step before it loads the business", () => {
    const gate = shell.indexOf("needsSecondStep(");
    const org = shell.indexOf('queryKey: ["my-org"]');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(org);
    expect(shell).toMatch(/redirect\(\{\s*to: "\/two-step"/);
  });

  it("only ever returns to a path on this site", () => {
    expect(safeNextPath("/invoices?status=open")).toBe("/invoices?status=open");
    expect(safeNextPath(undefined)).toBe("/dashboard");
    expect(safeNextPath("https://evil.example/x")).toBe("/dashboard");
    expect(safeNextPath("//evil.example/x")).toBe("/dashboard");
    expect(safeNextPath("/\\evil.example")).toBe("/dashboard");
    expect(safeNextPath("/two-step")).toBe("/dashboard");
    expect(safeNextPath("javascript:alert(1)")).toBe("/dashboard");
  });
});

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
    `\n  SKIPPED: the two-step proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set WEBHOOKS_PROOF_DB_URL to run them.\n",
  );
}

/** Again only if Postgres picked this proof as a deadlock victim: it adds a
 *  policy to every table, which takes locks other proofs' migrations want. */
function runProof(args: string[]) {
  let r = spawnSync(psql!, args, { encoding: "utf8", timeout: 300_000 });
  for (let i = 0; i < 2 && /deadlock detected/.test(`${r.stdout}${r.stderr}`); i++) {
    r = spawnSync(psql!, args, { encoding: "utf8", timeout: 300_000 });
  }
  return r;
}

describe.skipIf(!reachable)("two-step sign-in, in a real database", () => {
  it("has the files it runs", () => {
    expect(existsSync(MIGRATION)).toBe(true);
    expect(existsSync(PROOF)).toBe(true);
  });

  it("refuses a password-only session of a two-step user, and changes nothing for anyone else", () => {
    const r = runProof([DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-f", PROOF]);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(5);
    expect(out).toMatch(/ALL TWO-STEP PROOFS PASSED/);
  });
});
