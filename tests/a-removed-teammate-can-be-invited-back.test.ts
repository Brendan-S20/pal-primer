// A removed teammate can be invited back (#765).
//
// The SQL half runs tests/sql/a-removed-teammate-can-be-invited-back.proof.sql
// against the local stack when one answers; the static half pins the
// migration so a later redefinition cannot quietly drop either fix.
import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { migrationFiles, readMigration, stripLineComments } from "./support/sql-migrations";

vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
const MIGRATION = join(
  ROOT,
  "supabase/migrations/20261109180000_a-removed-teammate-can-be-invited-back.sql",
);
const PROOF = join(ROOT, "tests/sql/a-removed-teammate-can-be-invited-back.proof.sql");

/** The newest migration that (re)defines the accept function. */
function newest() {
  const files = migrationFiles().filter((f) =>
    /CREATE OR REPLACE FUNCTION public\.accept_org_invite_for_current_user/i.test(readMigration(f)),
  );
  const file = files[files.length - 1];
  const sql = stripLineComments(readMigration(file));
  const at = sql.search(/CREATE OR REPLACE FUNCTION public\.accept_org_invite_for_current_user/i);
  return { file, body: sql.slice(at, sql.indexOf("$$;", at)) };
}

describe("accept_org_invite_for_current_user lets a former member back in", () => {
  it("the email path accepts an older account that is already on the inviting staff", () => {
    const { file, body } = newest();
    expect(body, file).toMatch(
      /i\.created_at < _created\s*OR EXISTS \(SELECT 1 FROM public\.staff s\s*WHERE s\.user_id = _uid\s*AND s\.organization_id = i\.organization_id\)/,
    );
  });

  it("reuses the former member's staff row instead of adding a second person", () => {
    const { file, body } = newest();
    expect(body, file).toMatch(/SELECT id INTO _staff_id FROM public\.staff/);
    expect(body, file).toMatch(/IF _staff_id IS NOT NULL THEN\s*UPDATE public\.staff/);
    expect(body, file).toMatch(/active = true/);
  });

  it("still refuses a second business, and still never writes auth.users", () => {
    const { file, body } = newest();
    expect(body, file).toMatch(/already belongs to another organization/);
    expect(body, file).not.toMatch(/UPDATE\s+auth\.users/i);
  });
});

const DB_URL =
  process.env.WEBHOOKS_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

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
    `\n  SKIPPED: the invited-back proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set WEBHOOKS_PROOF_DB_URL to run them.\n",
  );
}

describe.skipIf(!reachable)("a removed teammate can be invited back, in a real database", () => {
  it("has the files it runs", () => {
    expect(existsSync(MIGRATION)).toBe(true);
    expect(existsSync(PROOF)).toBe(true);
  });

  it("a former member rejoins as themselves; a stranger still needs the link", () => {
    const r = spawnSync(psql!, [DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-f", PROOF], {
      encoding: "utf8",
      timeout: 300_000,
    });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(4);
    expect(out).toMatch(/ALL INVITED-BACK PROOFS PASSED/);
  });
});
