// A key that did not work, or an empty house, bills half by default (#410).
//
// The walker made the trip but no walk happened, and a key or code that does
// not work can be either side's fault. So key_failed and no_one_home default
// to 50 in default_skip_billable_pct and in the TS copy the skip rules screen
// reads. dog_unwell stays at 0. An owner can change any of them.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const SQL = read("supabase/migrations/20261015230000_a-walker-can-say-why-the-walk-did-not-happen.sql");
const TS = read("src/lib/skip-rules.functions.ts");

/** The number each code gets in the SQL CASE. */
function sqlPct(code: string): number | null {
  const m = SQL.match(new RegExp(`WHEN '${code}'\\s+THEN (\\d+)`));
  return m ? Number(m[1]) : null;
}

/** The number each code gets in DEFAULT_PCT. */
function tsPct(code: string): number | null {
  const block = TS.slice(TS.indexOf("const DEFAULT_PCT"), TS.indexOf("};", TS.indexOf("const DEFAULT_PCT")));
  const m = block.match(new RegExp(`\\b${code}: (\\d+),`));
  return m ? Number(m[1]) : null;
}

describe("the walker reasons' default charge", () => {
  it("bills key_failed and no_one_home at 50 and dog_unwell at 0, in SQL and in TS", () => {
    for (const [code, pct] of [
      ["key_failed", 50],
      ["no_one_home", 50],
      ["dog_unwell", 0],
    ] as const) {
      expect(sqlPct(code), `${code} in SQL`).toBe(pct);
      expect(tsPct(code), `${code} in TS`).toBe(pct);
    }
  });

  it("the function comment says why", () => {
    const comment = SQL.slice(SQL.indexOf("COMMENT ON FUNCTION"));
    expect(comment).toMatch(/key_failed and no_one_home bill 50/);
    expect(comment).toMatch(/either side''s fault/);
  });

  it("the replay check holds the 50", () => {
    expect(SQL).toMatch(/should bill key_failed and no_one_home at 50/);
  });
});
