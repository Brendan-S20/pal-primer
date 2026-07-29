import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALL_PERMISSIONS,
  ROLE_PERMISSIONS,
  hasPermission,
  type Permission,
} from "@/lib/permissions";
import type { AppRole } from "@/hooks/useMyRole";

// IMP-3 — authorization has two implementations and they must not drift.
//
// public.has_permission() in SQL guards RLS policies and RPCs; ROLE_PERMISSIONS
// in TypeScript guards requirePermission() in the server-fn layer. Both decide
// the same question, and the SQL is only documented as a "mirror" of the TS —
// documentation that nothing enforced. A permission granted on one side and not
// the other is either a hole or a phantom failure, and neither shows up until
// someone hits it in production.
//
// This parses the role clauses out of the authoritative migration and replays
// every (role, permission) pair against both implementations.
//
// Why parse rather than generate: has_permission is a section 3
// regression-protected object. Generating it from TS would mean rewriting a
// live authorization function to satisfy a test, which is a worse trade than
// reading what is actually deployed. The parser is deliberately strict — if the
// SQL is restructured into a shape it does not recognize it FAILS rather than
// silently passing, because a parity test that quietly stops checking is worse
// than no test at all.

const MIGRATION = join(
  __dirname,
  "..",
  "supabase",
  "migrations",
  "20260718000000_phase8-impersonation-exit-and-perms.sql",
);

/** Role clauses, as they appear inside the EXISTS predicate. */
type SqlRule =
  | { role: string; kind: "all" }
  | { role: string; kind: "allExcept"; permissions: string[] }
  | { role: string; kind: "only"; permissions: string[] };

function parseHasPermissionSql(sql: string): SqlRule[] {
  const start = sql.indexOf("CREATE OR REPLACE FUNCTION public.has_permission");
  if (start === -1) throw new Error("has_permission is not defined in the expected migration");
  // Bound the search to this function body so a later statement in the same
  // file can never be mistaken for part of the matrix.
  const body = sql.slice(start, sql.indexOf("$$;", start));
  if (!body) throw new Error("Could not find the end of the has_permission body");

  const rules: SqlRule[] = [];
  const list = (raw: string) => raw.match(/'([^']+)'/g)!.map((s) => s.slice(1, -1));

  // ur.role = 'owner'  (no permission predicate → every permission)
  for (const m of body.matchAll(/ur\.role\s*=\s*'(\w+)'\s*(?=\n|\r|\s*OR\b|\s*\))/g)) {
    const after = body.slice(m.index! + m[0].length, m.index! + m[0].length + 12);
    if (!/AND/i.test(after)) rules.push({ role: m[1], kind: "all" });
  }
  // (ur.role = 'x' AND _permission NOT IN ('a','b'))
  for (const m of body.matchAll(
    /ur\.role\s*=\s*'(\w+)'\s+AND\s+_permission\s+NOT\s+IN\s*\(([^)]*)\)/gi,
  )) {
    rules.push({ role: m[1], kind: "allExcept", permissions: list(m[2]) });
  }
  // (ur.role = 'x' AND _permission IN ('a','b'))  — NOT IN already consumed above
  for (const m of body.matchAll(
    /ur\.role\s*=\s*'(\w+)'\s+AND\s+_permission\s+(?!NOT\s)IN\s*\(([^)]*)\)/gi,
  )) {
    rules.push({ role: m[1], kind: "only", permissions: list(m[2]) });
  }
  // (ur.role = 'x' AND _permission = 'a')
  for (const m of body.matchAll(/ur\.role\s*=\s*'(\w+)'\s+AND\s+_permission\s*=\s*'([^']+)'/gi)) {
    rules.push({ role: m[1], kind: "only", permissions: [m[2]] });
  }
  return rules;
}

/** What the SQL grants a role, for a given permission. */
function sqlGrants(rules: SqlRule[], role: string, permission: string): boolean {
  return rules.some((r) => {
    if (r.role !== role) return false;
    if (r.kind === "all") return true;
    if (r.kind === "allExcept") return !r.permissions.includes(permission);
    return r.permissions.includes(permission);
  });
}

const sql = readFileSync(MIGRATION, "utf8");
const rules = parseHasPermissionSql(sql);
const ROLES = Object.keys(ROLE_PERMISSIONS) as AppRole[];

describe("TS ↔ SQL permission parity (IMP-3)", () => {
  it("recognizes a rule for every role the TS matrix defines", () => {
    // Guards the parser itself: if has_permission is rewritten into a shape
    // this cannot read, the suite must go red rather than vacuously pass.
    for (const role of ROLES) {
      expect(
        rules.some((r) => r.role === role),
        `No has_permission clause found for role "${role}". Either the SQL dropped the role, or it was restructured and this parser needs updating — do not delete the assertion.`,
      ).toBe(true);
    }
  });

  it("grants exactly the same permissions on both sides, for every role", () => {
    const mismatches: string[] = [];
    for (const role of ROLES) {
      for (const permission of ALL_PERMISSIONS as Permission[]) {
        const ts = hasPermission(role, permission);
        const db = sqlGrants(rules, role, permission);
        if (ts !== db) {
          mismatches.push(
            `${role} / ${permission}: TypeScript says ${ts ? "ALLOW" : "DENY"}, SQL says ${db ? "ALLOW" : "DENY"}`,
          );
        }
      }
    }
    expect(
      mismatches,
      `The SQL mirror of ROLE_PERMISSIONS has drifted:\n  ${mismatches.join("\n  ")}\n\nUpdate public.has_permission and src/lib/permissions.ts together.`,
    ).toEqual([]);
  });

  it("never grants a role something the TS matrix does not define at all", () => {
    // A permission that exists only in SQL is a hole nothing in the app knows
    // to check.
    const known = new Set<string>(ALL_PERMISSIONS);
    const unknown = rules
      .flatMap((r) => ("permissions" in r ? r.permissions : []))
      .filter((p) => !known.has(p));
    expect(
      unknown,
      `SQL references permissions absent from permissions.ts: ${unknown.join(", ")}`,
    ).toEqual([]);
  });

  it("keeps the money-and-ownership capabilities off dispatcher and tech", () => {
    // Belt-and-braces on the specific grants that would matter most if the
    // matrix were edited carelessly — dispatchers are ops-only (Q-1).
    for (const role of ["dispatcher", "tech"] as AppRole[]) {
      for (const permission of [
        "manage_org_billing",
        "manage_client_billing",
        "manage_pricing",
        "view_financials",
        "manage_users",
        "reveal_signin_code",
      ] as Permission[]) {
        expect(hasPermission(role, permission), `${role} must not hold ${permission}`).toBe(false);
        expect(sqlGrants(rules, role, permission), `SQL: ${role} must not hold ${permission}`).toBe(
          false,
        );
      }
    }
  });
});
