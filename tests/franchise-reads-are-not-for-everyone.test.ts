import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROLE_PERMISSIONS } from "@/lib/permissions";

// franchise_adjustments and franchise_link_codes both gated SELECT on
// `is_org_member`, which is the one membership helper that includes techs.
// Proven live before this was written, by building a franchise inside a
// transaction that rolled itself back:
//
//   before   TECH adj=1 codes=1
//   after    TECH adj=0 codes=0 || OFFICE_MGR adj=1 codes=0
//            || OWNER adj=1 codes=1 ledger_rpc=1
//
// The adjustments table is every refund and chargeback moving between a
// franchise and its locations. The link codes table holds bearer credentials:
// an unused, unexpired code attaches an organization to this franchise.
//
// Both are read through SECURITY DEFINER routines that authorize properly —
// and both tables underneath were open, so the routine could simply be skipped.
// That shape has now appeared five times in this codebase, which is why the
// last test here checks the helper itself rather than these two tables.

const ROOT = new URL("..", import.meta.url).pathname;
const MIGRATIONS = join(ROOT, "supabase", "migrations");

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/** The LAST migration creating policies on the table is the one in force. */
function policiesFor(table: string): string[] {
  const re = new RegExp(`CREATE\\s+POLICY[^;]*ON\\s+public\\.${table}\\b`, "i");
  let found = "";
  for (const f of migrationFiles()) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8");
    if (re.test(sql)) found = sql;
  }
  if (!found) throw new Error(`no migration defines policies on ${table}`);
  return (found.match(/CREATE\s+POLICY[\s\S]*?;/gi) ?? []).filter((p) =>
    new RegExp(`ON\\s+public\\.${table}\\b`, "i").test(p),
  );
}

describe("the franchise adjustment ledger", () => {
  const policies = policiesFor("franchise_adjustments");

  it("is read-only through the table", () => {
    // Every write is record_franchise_adjustment, which is SECURITY DEFINER and
    // — checked live — is not granted to `authenticated` at all: a tech calling
    // it got `tech_calls_record_adjustment=DENIED`. The EXECUTE grant is the
    // gate there, which is why the function itself carries no role check.
    expect(policies.length).toBe(1);
    expect(policies[0]).toMatch(/FOR\s+SELECT/i);
  });

  it("no longer admits every member of the org", () => {
    expect(policies[0]).not.toMatch(/is_org_member/);
  });

  it("names the same permission the ledger routine authorizes", () => {
    // franchise_adjustment_ledger() checks view_financials. If the policy said
    // anything else, one of the two would be the real rule and the other would
    // be decoration — and it would not be obvious which.
    expect(policies[0]).toMatch(/view_financials/);
  });

  it("still lets both sides of the relationship read their own rows", () => {
    // A location has to be able to see what it was charged back for; a
    // franchise has to see what it deducted. Dropping either turns a settlement
    // dispute into a phone call.
    expect(policies[0]).toMatch(/parent_organization_id/);
    expect(policies[0]).toMatch(/child_organization_id/);
  });
});

describe("franchise invite codes", () => {
  const policies = policiesFor("franchise_link_codes");

  it("are readable only by whoever may manage the franchise", () => {
    expect(policies.length).toBe(1);
    expect(policies[0]).toMatch(/FOR\s+SELECT/i);
    expect(policies[0]).toMatch(/manage_franchise/);
    expect(policies[0]).not.toMatch(/is_org_member/);
  });

  it("is a permission only the owner holds", () => {
    // The policy is exactly as strict as the permission it names.
    expect(ROLE_PERMISSIONS.owner).toContain("manage_franchise");
    for (const role of ["office_manager", "dispatcher", "tech"] as const) {
      expect(ROLE_PERMISSIONS[role], role).not.toContain("manage_franchise");
    }
  });
});

describe("is_org_member on a money table", () => {
  it("is not used to gate any franchise money table", () => {
    // The named lesson, kept as a check rather than a comment: is_org_member
    // answers "are you in this organization", which includes the tech driving
    // the truck. It is the right helper for a schedule and the wrong one for a
    // ledger. Five bugs this cycle were some version of this.
    const MONEY_TABLES = [
      "franchise_adjustments",
      "franchise_link_codes",
      "franchise_royalty_invoices",
    ];
    const offenders: string[] = [];
    for (const t of MONEY_TABLES) {
      for (const p of policiesFor(t)) {
        if (/is_org_member/.test(p)) offenders.push(`${t}: ${p.slice(0, 60)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
