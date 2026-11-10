#!/usr/bin/env node
// Can a visitor or a signed-in user empty a table in production?
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
//
// Supabase's default privileges give `anon` and `authenticated` ALL on every
// table `postgres` creates in public. Four of those privileges -- SELECT,
// INSERT, UPDATE, DELETE -- are what RLS scopes. The other three are not:
//
//   TRUNCATE    RLS has no TRUNCATE policy. A holder empties the table,
//               every tenant's rows at once, with one statement.
//   TRIGGER     lets the holder create triggers on the table.
//   REFERENCES  lets the holder create foreign keys pointing at it.
//
// No client of this app needs any of them. 20261109030541 took them off the
// three portal_change_* tables; after #760, a census of production found 106
// more public tables, 575 grant rows, still holding them (#842), and
// 20261110130000 takes those off too.
//
// The proof beside that migration asserts the same thing on the schema the
// migrations BUILD. This asks production, because production is where a table
// created from a console, or by a migration that forgot its REVOKE, actually
// lives, and every new table gets the default grants back automatically.
//
// ── THE RULE ──────────────────────────────────────────────────────────────
//
// No public base table (relkind r or p) lets anon or authenticated TRUNCATE,
// TRIGGER or REFERENCES it -- directly, through PUBLIC, or through a role
// either belongs to. That is has_table_privilege(), not a read of the ACL, so
// an inherited grant counts. Every table is checked, not a list: the point is
// that the next table cannot quietly regain them.
//
// It also reads the DEFAULT privileges, which are what put the grants back on
// the next table. postgres creates this repo's tables and 20261110130000
// takes the three out of its defaults in public, so a postgres default that
// still hands them out FAILS. supabase_admin's defaults may only be changed
// by a member of supabase_admin, which postgres is not on a hosted project,
// so those are a WARNING: true, printed, and not something a migration here
// can fix. The per-table check above still names any table either role makes.
//
// ── WHAT IT DOES NOT ANSWER ───────────────────────────────────────────────
//
// Whether SELECT/INSERT/UPDATE/DELETE are right. RLS and the policy tests own
// that. Views are not checked: TRUNCATE does not apply to one.
//
// Unlike check-rpc-grants, a missing SUPABASE_DB_URL or an unreachable
// database is a FAILURE here, not a skip. This is a security property; a check
// that passes without having looked is the failure mode this job exists to
// remove.
import { execFileSync } from "node:child_process";

export const PRIVILEGES = ["TRUNCATE", "TRIGGER", "REFERENCES"];
export const ROLES = ["anon", "authenticated"];
// Default privileges that must not hand the three out: a finding.
export const MUST_HOLD = ["postgres"];
// Default privileges this repo may not be permitted to change: a warning.
export const WARN_ONLY = ["supabase_admin"];
const DEFAULT_ROLES = [...MUST_HOLD, ...WARN_ONLY];

export const SQL = `
SELECT 'checked', count(*)::text, ''
  FROM pg_class c
 WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
UNION ALL
SELECT 'held', c.relname, r.role || ' ' || p.priv
  FROM pg_class c
  CROSS JOIN (VALUES ${ROLES.map((r) => `('${r}')`).join(", ")}) AS r(role)
  CROSS JOIN (VALUES ${PRIVILEGES.map((p) => `('${p}')`).join(", ")}) AS p(priv)
 WHERE c.relnamespace = 'public'::regnamespace
   AND c.relkind IN ('r', 'p')
   AND has_table_privilege(r.role, c.oid, p.priv)
UNION ALL
SELECT 'default', d.defaclrole::regrole::text,
       x.grantee::regrole::text || ' ' || x.privilege_type ||
       CASE WHEN d.defaclnamespace = 0 THEN ' (every schema)' ELSE '' END
  FROM pg_default_acl d
  CROSS JOIN LATERAL aclexplode(d.defaclacl) x
 WHERE d.defaclobjtype = 'r'
   AND d.defaclrole::regrole::text IN (${DEFAULT_ROLES.map((r) => `'${r}'`).join(", ")})
   AND (d.defaclnamespace = 0 OR d.defaclnamespace = 'public'::regnamespace)
   AND x.grantee::regrole::text IN (${ROLES.map((r) => `'${r}'`).join(", ")})
   AND x.privilege_type IN (${PRIVILEGES.map((p) => `'${p}'`).join(", ")});`;

function main() {
  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) {
    console.error(
      "✗ SUPABASE_DB_URL is not set, so this check cannot ask the database.\n" +
        "  It is a security check and does not pass without having looked.",
    );
    process.exit(1);
  }

  let lines;
  try {
    lines = execFileSync("psql", [dbUrl, "-At", "-F", "\t", "-v", "ON_ERROR_STOP=1", "-c", SQL], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split("\t"));
  } catch (e) {
    const stderr = String(e.stderr ?? "");
    console.error(`✗ could not ask the database:\n${stderr || e.message}`);
    process.exit(1);
  }

  const checked = Number(lines.find((l) => l[0] === "checked")?.[1] ?? 0);
  if (!checked) {
    console.error(
      "✗ found no public base tables. The query is broken, or this is the wrong database.",
    );
    process.exit(1);
  }

  const held = lines.filter((l) => l[0] === "held");
  const byTable = new Map();
  for (const [, table, grant] of held) {
    if (!byTable.has(table)) byTable.set(table, []);
    byTable.get(table).push(grant);
  }

  console.log(
    `\nchecked ${checked} public base table(s) for ${PRIVILEGES.join(", ")} held by ${ROLES.join(" or ")}`,
  );

  const defaults = lines.filter((l) => l[0] === "default");
  const failingDefaults = defaults.filter(([, role]) => MUST_HOLD.includes(role));
  const warnDefaults = defaults.filter(([, role]) => WARN_ONLY.includes(role));
  if (warnDefaults.length) {
    console.log(
      `\n! ${WARN_ONLY.join(", ")} default privileges in public still grant, on every table that role creates:\n` +
        warnDefaults.map(([, role, g]) => `    ${role}: ${g}`).join("\n") +
        "\n  Not a failure: postgres may not alter another role's defaults on a hosted project.\n" +
        "  Any table that role creates is still named by the per-table check.",
    );
  }

  let failed = false;
  if (failingDefaults.length) {
    failed = true;
    console.error(
      `\n✗ postgres default privileges still hand out, on every new public table:\n` +
        failingDefaults.map(([, role, g]) => `    ${role}: ${g}`).join("\n") +
        "\n  Fix it in a migration:\n" +
        "    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public\n" +
        "      REVOKE TRUNCATE, TRIGGER, REFERENCES ON TABLES FROM anon, authenticated;",
    );
  }

  if (byTable.size) {
    failed = true;
    console.error(
      `\n✗ ${byTable.size} public table(s), ${held.length} grant(s), still let a client role\n` +
        "  TRUNCATE, TRIGGER or REFERENCES them. RLS does not protect TRUNCATE.\n",
    );
    for (const [table, grants] of [...byTable].sort(([a], [b]) => a.localeCompare(b))) {
      console.error(`  - public.${table}: ${grants.join(", ")}`);
    }
    console.error(
      "\n  Fix it in a migration:\n" +
        "    REVOKE TRUNCATE, TRIGGER, REFERENCES ON TABLE public.<table> FROM anon, authenticated;\n" +
        "  A table gets these from its creating role's default privileges, so check\n" +
        "  those too (above).",
    );
  }
  if (failed) process.exit(1);

  console.log(
    "✓ no public table lets anon or authenticated TRUNCATE, TRIGGER or REFERENCES it,\n" +
      "  and postgres's default privileges no longer hand them to the next one\n",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
