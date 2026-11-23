// #1001: platform_addons shows a signed-in user only active rows;
// platform_referral_settings and platform_feature_flags show them nothing.
//
// Two halves. The database half runs
// tests/sql/a-signed-in-business-cannot-read-the-platforms-own-tables.proof.sql
// against a real Postgres (rolled back; skips loudly when none answers; set
// PLATFORM_TABLES_PROOF_DB_URL for a stack of your own). The code half proves
// that every read a page makes of those tables goes through the admin client,
// so no page loses data when the browser-facing policy closed.

import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
const MIGRATION = join(
  ROOT,
  "supabase/migrations/20261123200000_a-signed-in-business-cannot-read-the-platforms-own-tables.sql",
);
const PROOF = join(ROOT, "tests/sql/a-signed-in-business-cannot-read-the-platforms-own-tables.proof.sql");
const DB_URL =
  process.env.PLATFORM_TABLES_PROOF_DB_URL ??
  process.env.PUBLIC_SERVICES_PROOF_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

function findPsql(): string | null {
  for (const p of [
    "psql",
    "/opt/homebrew/opt/libpq/bin/psql",
    "/opt/homebrew/opt/postgresql@18/bin/psql",
    "/opt/homebrew/opt/postgresql@17/bin/psql",
    "/usr/local/opt/libpq/bin/psql",
  ]) {
    if (spawnSync(p, ["--version"], { encoding: "utf8" }).status === 0) return p;
  }
  return null;
}
const psql = findPsql();
const reachable =
  !!psql &&
  spawnSync(psql, [DB_URL, "-XAtc", "select 1"], { encoding: "utf8", timeout: 30_000 }).stdout?.trim() === "1";
if (!reachable) {
  console.warn("\n  SKIPPED: the platform-tables proof did NOT run (no database / psql). Set PLATFORM_TABLES_PROOF_DB_URL.\n");
}

const strip = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

describe("the platform's own tables are closed to a signed-in business (#1001)", () => {
  it("the migration drops all three open SELECT policies and adds no USING (true)", () => {
    const sql = strip(readFileSync(MIGRATION, "utf8"));
    for (const [name, table] of [
      ["authenticated read active platform addons", "platform_addons"],
      ["authenticated read referral settings", "platform_referral_settings"],
      ["Any auth user reads flag catalog", "platform_feature_flags"],
    ])
      expect(sql).toContain(`DROP POLICY IF EXISTS "${name}" ON public.${table};`);
    expect(sql).not.toMatch(/USING\s*\(\s*true\s*\)/i);
  });

  it("every tenant page read of the three tables uses the admin client", () => {
    const files = [
      "src/lib/platform-addons.functions.ts",
      "src/lib/referrals.functions.ts",
      "src/lib/platform-tenant.functions.ts",
      "src/lib/platform-referrals.functions.ts",
      "src/lib/billing.functions.ts",
      "src/lib/weather.functions.ts",
    ];
    for (const f of files) {
      const src = readFileSync(join(ROOT, f), "utf8");
      for (const m of src.matchAll(/(\w+(?: as any\))?)\s*\n?\s*\.from\("(platform_addons|platform_referral_settings|platform_feature_flags)"\)/g)) {
        // `catalogDb` and `supabaseAdmin` are both the service-role client.
        expect(m[1], `${f} reads ${m[2]} with ${m[1]}`).toMatch(/supabaseAdmin|catalogDb/);
      }
    }
    expect(readFileSync(join(ROOT, "src/lib/platform-addons.functions.ts"), "utf8")).toMatch(
      /supabaseAdmin: catalogDb\s*\}\s*=\s*await import\("@\/integrations\/supabase\/client\.server"\)/,
    );
  });

  describe.skipIf(!reachable)("in a real database", () => {
    it("has the files it runs", () => {
      expect(existsSync(MIGRATION)).toBe(true);
      expect(existsSync(PROOF)).toBe(true);
    });

    it("a signed-in non-admin reads no flags or referral settings and only active add-ons; the server and admins still read all", () => {
      let r = spawnSync(psql!, [DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-f", PROOF], { encoding: "utf8", timeout: 300_000 });
      for (let i = 0; i < 2 && /deadlock detected/.test(`${r.stdout}${r.stderr}`); i++)
        r = spawnSync(psql!, [DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-f", PROOF], { encoding: "utf8", timeout: 300_000 });
      const out = `${r.stdout}\n${r.stderr}`;
      expect(r.status, out).toBe(0);
      expect(out).not.toMatch(/PROOF FAILED/);
      expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(6);
      expect(out).toMatch(/ALL PLATFORM TABLE PROOFS PASSED/);
      const left = spawnSync(psql!, [DB_URL, "-XAtc", "select count(*) from public.platform_addons where slug like 'proof-%'"], { encoding: "utf8" });
      expect(left.stdout.trim()).toBe("0");
    });
  });
});
