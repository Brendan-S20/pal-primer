// Deleting an account removes its push tokens (#487).
//
// delete_my_account keeps the auth row, so the ON DELETE CASCADE from
// auth.users never fires. The push tokens have to be deleted by the function
// itself. This reads the migration that does it and fails if either delete
// is gone, from the function body or from the self-check that guards it.
//
// The behavior is proven against a real database in
// tests/integration/account-deletion.db.test.ts.
import { describe, expect, it } from "vitest";
import { migrationFiles, readMigration, stripLineComments } from "./support/sql-migrations";

const FILE = "20261018060000_deleting-an-account-removes-its-push-tokens.sql";
const PUSH = "DELETE FROM public.push_subscriptions WHERE user_id = _uid;";
const LIVE = "DELETE FROM public.live_activity_tokens WHERE user_id = _uid;";

/** The function body, between its dollar quotes, with comments stripped. */
function body(sql: string): string {
  const code = stripLineComments(sql);
  const start = code.indexOf("AS $$");
  const end = code.indexOf("$$;", start + 5);
  expect(start, "no function body in the migration").toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return code.slice(start, end);
}

describe("deleting an account removes its push tokens", () => {
  it("the migration exists", () => {
    expect(migrationFiles()).toContain(FILE);
  });

  it("is the last definition of delete_my_account", () => {
    // A later file that redefines the function without the deletes would
    // undo this one, and this test would still pass on the older file.
    const defining = migrationFiles().filter((f) =>
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.delete_my_account\b/i.test(
        stripLineComments(readMigration(f)),
      ),
    );
    expect(defining.at(-1)).toBe(FILE);
  });

  it("deletes the push subscriptions in the function body", () => {
    expect(body(readMigration(FILE))).toContain(PUSH);
  });

  it("deletes the Live Activity tokens in the function body", () => {
    expect(body(readMigration(FILE))).toContain(LIVE);
  });

  it("deletes them after the staff update, not before", () => {
    const b = body(readMigration(FILE));
    const staff = b.indexOf("UPDATE public.staff\n     SET active = false");
    expect(staff).toBeGreaterThan(-1);
    expect(b.indexOf(PUSH)).toBeGreaterThan(staff);
    expect(b.indexOf(LIVE)).toBeGreaterThan(staff);
  });

  it("the self-check asserts both deletes", () => {
    const code = stripLineComments(readMigration(FILE));
    const verify = code.slice(code.indexOf("DO $verify$"));
    expect(verify).toMatch(
      /NOT LIKE '%DELETE FROM public\.push_subscriptions WHERE user_id = _uid%'/,
    );
    expect(verify).toMatch(
      /NOT LIKE '%DELETE FROM public\.live_activity_tokens WHERE user_id = _uid%'/,
    );
  });

  it("keeps SECURITY DEFINER, the search_path and the grants", () => {
    const code = stripLineComments(readMigration(FILE));
    expect(code).toMatch(/SECURITY DEFINER/);
    expect(code).toMatch(/SET search_path TO 'public', 'pg_temp'/);
    expect(code).toMatch(
      /REVOKE ALL ON FUNCTION public\.delete_my_account\(uuid, boolean\) FROM PUBLIC, anon;/,
    );
    expect(code).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.delete_my_account\(uuid, boolean\) TO authenticated, service_role;/,
    );
  });

  it("still never deletes financial or service records", () => {
    expect(body(readMigration(FILE))).not.toMatch(
      /DELETE\s+FROM\s+public\.(invoices|payments|visits|credit_ledger|activity)\b/i,
    );
  });
});
