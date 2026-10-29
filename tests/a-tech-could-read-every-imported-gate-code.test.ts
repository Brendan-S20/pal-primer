// #571 (F-08): the static half. The proof beside this file needs a database;
// this one runs everywhere and pins what the latest migration to touch the
// import tables leaves behind, so a later migration cannot quietly put
// is_org_member or can_write_org back on them.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dirname, "..", "supabase", "migrations");
const TABLE = /\bpublic\.(import_rows|import_batches)\b/;

// Every CREATE / ALTER POLICY statement on either import table, in replay order.
function policyStatements(): { file: string; sql: string }[] {
  const out: { file: string; sql: string }[] = [];
  for (const file of readdirSync(DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const text = readFileSync(join(DIR, file), "utf8").replace(/--[^\n]*/g, "");
    for (const stmt of text.split(";")) {
      if (/\b(create|alter)\s+policy\b/i.test(stmt) && TABLE.test(stmt)) {
        out.push({ file, sql: stmt.trim() });
      }
    }
  }
  return out;
}

describe("import rows and batches answer to manage_imports", () => {
  const stmts = policyStatements();
  const lastFile = stmts.at(-1)?.file;

  it("is decided by the #571 migration", () => {
    expect(lastFile).toBe("20261029090000_a-tech-could-read-every-imported-gate-code.sql");
  });

  it("asks manage_imports in every policy that migration creates, and nothing broader", () => {
    const latest = stmts.filter((s) => s.file === lastFile);
    expect(latest).toHaveLength(8);
    for (const s of latest) {
      expect(s.sql, s.sql).toMatch(/'manage_imports'/);
      expect(s.sql, s.sql).not.toMatch(/is_org_member|can_write_org/);
    }
  });

  it("drops every policy an earlier migration put on the two tables", () => {
    const text = readFileSync(join(DIR, lastFile!), "utf8");
    const earlier = new Set<string>();
    for (const s of stmts.filter((x) => x.file !== lastFile)) {
      const m = s.sql.match(/policy\s+"([^"]+)"/i);
      if (m) earlier.add(m[1]);
    }
    expect(earlier.size).toBeGreaterThan(0);
    for (const name of earlier) {
      expect(text, name).toContain(`DROP POLICY IF EXISTS "${name}"`);
    }
  });
});
