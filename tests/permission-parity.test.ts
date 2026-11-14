import { readFileSync, readdirSync } from "node:fs";
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
// public.has_permission() in SQL guards RLS policies and RPCs, and since #863
// answers from public.permission_default() unless the business's owner stored
// something else; ROLE_PERMISSIONS in TypeScript is the same default behind
// requirePermission() in the server-fn layer. Both decide the same question,
// and the SQL is only documented as a "mirror" of the TS —
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

// The LATEST migration that defines the DEFAULT matrix, not a hard-coded one.
//
// This used to name 20260718000000 outright, and that broke quietly the moment
// a later migration replaced the function: the test kept passing while parsing
// a definition the database no longer used, so a drift introduced in the newer
// file would sail through the very check built to catch drift. A parity test
// anchored to superseded history is the failure it exists to prevent.
//
// Since 20261112010000 (#863) the matrix is public.permission_default(role,
// permission), which has_permission reads behind the business's stored
// overrides. The role clauses parsed here are that function's; has_permission
// itself no longer names a role but the owner.
const MIGRATIONS_DIR = join(__dirname, "..", "supabase", "migrations");
const DEFINES_DEFAULTS = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.permission_default\s*\(/i;

function latestDefaultsMigration(): string {
  const hits = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort() // timestamp-prefixed, so lexical order is chronological
    .filter((f) => DEFINES_DEFAULTS.test(readFileSync(join(MIGRATIONS_DIR, f), "utf8")));
  if (!hits.length) {
    throw new Error("No migration defines public.permission_default — parity cannot be checked.");
  }
  return join(MIGRATIONS_DIR, hits[hits.length - 1]);
}

const MIGRATION = latestDefaultsMigration();

/** Role clauses, as they appear inside permission_default's CASE. */
type SqlRule =
  | { role: string; kind: "all" }
  | { role: string; kind: "allExcept"; permissions: string[] }
  | { role: string; kind: "only"; permissions: string[] };

function parseDefaultsSql(sql: string): SqlRule[] {
  const start = sql.search(DEFINES_DEFAULTS);
  if (start === -1) throw new Error("permission_default is not defined in the expected migration");
  // Bound the search to this function body so a later statement in the same
  // file can never be mistaken for part of the matrix.
  const end = sql.indexOf("$function$;", start);
  const body = end === -1 ? "" : sql.slice(start, end);
  if (!body) throw new Error("Could not find the end of the permission_default body");

  const rules: SqlRule[] = [];
  const list = (raw: string) => raw.match(/'([^']+)'/g)!.map((s) => s.slice(1, -1));

  // WHEN _role = 'owner' THEN true  (every permission)
  for (const m of body.matchAll(/WHEN\s+_role\s*=\s*'(\w+)'\s+THEN\s+true\b/gi)) {
    rules.push({ role: m[1], kind: "all" });
  }
  // WHEN _role = 'x' THEN _permission NOT IN ('a','b')
  for (const m of body.matchAll(
    /WHEN\s+_role\s*=\s*'(\w+)'\s+THEN\s+_permission\s+NOT\s+IN\s*\(([^)]*)\)/gi,
  )) {
    rules.push({ role: m[1], kind: "allExcept", permissions: list(m[2]) });
  }
  // WHEN _role = 'x' THEN _permission IN ('a','b')  — NOT IN already consumed above
  for (const m of body.matchAll(
    /WHEN\s+_role\s*=\s*'(\w+)'\s+THEN\s+_permission\s+(?!NOT\s)IN\s*\(([^)]*)\)/gi,
  )) {
    rules.push({ role: m[1], kind: "only", permissions: list(m[2]) });
  }
  // WHEN _role = 'x' THEN _permission = 'a'
  for (const m of body.matchAll(
    /WHEN\s+_role\s*=\s*'(\w+)'\s+THEN\s+_permission\s*=\s*'([^']+)'/gi,
  )) {
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
const rules = parseDefaultsSql(sql);
const ROLES = Object.keys(ROLE_PERMISSIONS) as AppRole[];

describe("TS ↔ SQL permission parity (IMP-3)", () => {
  it("recognizes a rule for every role the TS matrix defines", () => {
    // Guards the parser itself: if permission_default is rewritten into a
    // shape this cannot read, the suite must go red rather than vacuously pass.
    for (const role of ROLES) {
      expect(
        rules.some((r) => r.role === role),
        `No permission_default clause found for role "${role}". Either the SQL dropped the role, or it was restructured and this parser needs updating — do not delete the assertion.`,
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
      `The SQL mirror of ROLE_PERMISSIONS has drifted:\n  ${mismatches.join("\n  ")}\n\nUpdate public.permission_default and src/lib/permissions.ts together.`,
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

// ── the primitives answer only about the caller ────────────────────────────
//
// Text assertions rather than live calls, because CI has no database. What is
// pinned is the guard's PRESENCE and its two deliberate properties, since both
// are easy to "simplify" away by someone who does not know why they are there.

describe("the authorization primitives refuse to answer about a third party", () => {
  const GUARDED = [
    "has_role",
    "is_org_member",
    "has_permission",
    "can_write_org",
    "is_platform_admin",
    "is_visit_tech",
  ];
  // The LAST migration defining these is the one that runs. This was pinned to
  // one filename, so a later CREATE OR REPLACE that removed the caller guard —
  // turning the primitives back into an oracle any signed-in account can query
  // about any user — walked straight past it with the whole suite green.
  const guardSql = (() => {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    let found = "";
    for (const f of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+public\.is_org_member\s*\(/i.test(sql))
        found = sql;
    }
    if (!found) throw new Error("no migration defines is_org_member");
    return found;
  })();

  it("guards every one of the six", () => {
    // They take the subject as an argument, so without this each is an oracle:
    // any signed-in account could ask whether any user belongs to any org.
    for (const fn of GUARDED) {
      const body = guardSql.slice(
        guardSql.indexOf(`FUNCTION public.${fn}(`),
        guardSql.indexOf("$function$;", guardSql.indexOf(`FUNCTION public.${fn}(`)),
      );
      expect(body, `${fn} must be defined here`).toContain("RETURNS boolean");
      // Bare `auth.uid()` or the `(SELECT auth.uid())` form 20261009180000
      // uses -- the same guard, the second evaluated once per call.
      expect(body, `${fn} must only answer about the caller`).toMatch(
        /\(?(?:SELECT )?auth\.uid\(\)\)? IS NULL OR _user_id IS NOT DISTINCT FROM \(?(?:SELECT )?auth\.uid\(\)\)?/,
      );
    }
  });

  it("exempts callers with no identity, which is service-role code", () => {
    // A trigger inside the nightly run has auth.uid() NULL and can read
    // user_roles directly anyway; gating it would break internal callers to
    // prevent nothing.
    expect(guardSql).toMatch(/auth\.uid\(\)\)? IS NULL OR/);
  });

  it("compares with IS NOT DISTINCT FROM, so a NULL subject is false not NULL", () => {
    // `= auth.uid()` would yield NULL for a NULL _user_id. A NULL in a policy
    // is treated as no-access today, which makes the bug invisible until some
    // caller starts relying on a real boolean.
    expect(guardSql).not.toMatch(/_user_id\s*=\s*auth\.uid\(\)/);
  });

  it("returns false rather than raising", () => {
    // These are predicates inside policy expressions. An exception would turn
    // one probe into a broken query for the legitimate caller sharing that
    // statement — and a raise is itself an oracle, since it distinguishes
    // 'not you' from 'not a member'.
    const bodies = GUARDED.map((fn) =>
      guardSql.slice(
        guardSql.indexOf(`FUNCTION public.${fn}(`),
        guardSql.indexOf("$function$;", guardSql.indexOf(`FUNCTION public.${fn}(`)),
      ),
    ).join("\n");
    expect(bodies).not.toMatch(/RAISE\s+EXCEPTION/i);
  });
});
