import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { repoRelative } from "./support/repo-paths";

// #767, acceptance criterion 4: "A test fails if any seed/fixture inserts
// auth.users with NULL token columns."
//
// Six rows inserted with raw SQL on 2026-08-04 left confirmation_token,
// recovery_token, email_change_token_new and email_change NULL. GoTrue cannot
// scan NULL into those columns, so `auth.admin.listUsers` answered 500 for
// three months and Platform → Users could not find an orphaned owner.
//
// The rule: a file that INSERTs into auth.users and leaves the rows behind
// must give every one of those columns a value. A file whose transaction ends
// in ROLLBACK (every SQL proof, the routing-trials harness) leaves nothing
// behind and is exempt. The better answer for a persistent seed is
// `auth.admin.createUser`, which tests/e2e/seed.mjs already uses.

const TOKEN_COLUMNS = [
  "confirmation_token",
  "recovery_token",
  "email_change_token_new",
  "email_change",
] as const;

const ROOT = join(__dirname, "..");
const SCAN_DIRS = ["supabase", "scripts", "tests"];
const EXT = /\.(sql|ts|tsx|mjs|js|cjs)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXT.test(name)) out.push(p);
  }
  return out;
}

/** Does this file's last transaction-control statement roll back? */
export function rollsBack(src: string): boolean {
  // `ON COMMIT DROP` is not a transaction end, so require the `;`.
  const ends = [...src.matchAll(/\b(ROLLBACK|COMMIT)\s*;/gi)];
  return ends.length > 0 && ends[ends.length - 1][1].toUpperCase() === "ROLLBACK";
}

/** Every `INSERT INTO auth.users (...)` whose column list misses a token column. */
export function nullTokenInserts(src: string): Array<{ line: number; missing: string[] }> {
  const out: Array<{ line: number; missing: string[] }> = [];
  for (const m of src.matchAll(/INSERT\s+INTO\s+"?auth"?\s*\.\s*"?users"?\s*(\(([^)]*)\))?/gi)) {
    const cols = (m[2] ?? "").toLowerCase();
    // No column list = positional over every column; can't tell, so flag it.
    const missing = m[2]
      ? TOKEN_COLUMNS.filter((c) => !new RegExp(`\\b${c}\\b`).test(cols))
      : [...TOKEN_COLUMNS];
    if (missing.length) out.push({ line: src.slice(0, m.index).split("\n").length, missing });
  }
  return out;
}

export function violations(src: string) {
  return rollsBack(src) ? [] : nullTokenInserts(src);
}

describe("no seed or fixture leaves an auth.users row with NULL token columns (#767)", () => {
  it("every persistent INSERT INTO auth.users sets all four token columns", () => {
    const self = repoRelative(__filename, ROOT);
    const bad: string[] = [];
    let inserting = 0;
    for (const dir of SCAN_DIRS) {
      for (const file of walk(join(ROOT, dir))) {
        const rel = repoRelative(file, ROOT);
        if (rel === self) continue;
        const src = readFileSync(file, "utf8");
        if (!/INSERT\s+INTO\s+"?auth"?\s*\.\s*"?users"?/i.test(src)) continue;
        inserting += 1;
        for (const v of violations(src))
          bad.push(`${rel}:${v.line} leaves ${v.missing.join(", ")} NULL`);
      }
    }
    // The scan is looking at something: the proofs insert auth.users today.
    expect(inserting).toBeGreaterThan(0);
    expect(
      bad,
      "GoTrue cannot read these rows and auth.admin.listUsers will 500 (#767). " +
        "Use auth.admin.createUser, set the columns to '', or end the transaction in ROLLBACK.",
    ).toEqual([]);
  });

  describe("the rule itself", () => {
    it("fails the insert that broke prod", () => {
      const seed = `BEGIN;\nINSERT INTO auth.users (id, email, encrypted_password) VALUES ('x', 'a@b.c', 'h');\nCOMMIT;`;
      expect(violations(seed)).toEqual([{ line: 2, missing: [...TOKEN_COLUMNS] }]);
    });

    it("fails a seed with no transaction at all, and one with no column list", () => {
      expect(violations(`insert into auth.users (id, email) values ('x','y');`)).toHaveLength(1);
      expect(violations(`insert into auth.users values ('x','y');`)).toHaveLength(1);
    });

    it("passes a seed that sets every token column", () => {
      const seed = `INSERT INTO auth.users (id, email, confirmation_token, recovery_token, email_change_token_new, email_change)\nVALUES ('x', 'a@b.c', '', '', '', '');`;
      expect(violations(seed)).toEqual([]);
    });

    it("passes a proof that rolls back, and is not fooled by ON COMMIT DROP", () => {
      expect(
        violations(`BEGIN;\nINSERT INTO auth.users (id, email) VALUES ('x','y');\nROLLBACK;`),
      ).toEqual([]);
      expect(
        violations(
          `CREATE TEMP TABLE t (a int) ON COMMIT DROP;\nINSERT INTO auth.users (id, email) VALUES ('x','y');`,
        ),
      ).toHaveLength(1);
    });
  });
});
