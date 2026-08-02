import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROLE_PERMISSIONS } from "@/lib/permissions";

// franchise_royalty_invoices is the table that decides what a location owes its
// franchise — eight money columns and a status. It carried ONE policy covering
// ALL commands, gated on can_write_org, which includes DISPATCHERS. Proven live
// before this was written: a franchise dispatcher could read a settlement, zero
// a $1,000 royalty, and delete the invoice outright.
//
// Q-1 answered this: "dispatchers ops-only, no billing", and the three routing
// setters already require the parent's OWNER. This table was the exception.
//
// These read the shipped migration and the shipped permission matrix rather
// than restating either — the repo has a history of tests that agreed with
// themselves while production differed.

const ROOT = new URL("..", import.meta.url).pathname;
const MIGRATIONS = join(ROOT, "supabase", "migrations");

/** The last migration that defines policies on the table — migrations are an
 *  append-only history, so an earlier copy is not what runs. */
function latestPolicySql(table: string): string {
  const re = new RegExp(`CREATE\\s+POLICY[^;]*ON\\s+public\\.${table}`, "i");
  let found: string | null = null;
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8");
    if (re.test(sql)) found = sql;
  }
  if (!found) throw new Error(`no migration defines policies on ${table}`);
  return found;
}

function policiesFor(table: string): string[] {
  return latestPolicySql(table).match(/CREATE\s+POLICY[\s\S]*?;/gi) ?? [];
}

describe("who can change what a location owes", () => {
  const policies = policiesFor("franchise_royalty_invoices");

  it("has no policy covering ALL commands", () => {
    // `FOR ALL` is how one permissive read rule silently became a write rule.
    for (const p of policies) {
      expect(p, p.slice(0, 70)).not.toMatch(/FOR\s+ALL/i);
    }
  });

  it("lets the office READ settlements", () => {
    const read = policies.filter((p) => /FOR\s+SELECT/i.test(p));
    expect(read.length).toBe(1);
    expect(read[0]).toMatch(/can_write_org/);
  });

  it("lets only manage_franchise UPDATE them", () => {
    const upd = policies.filter((p) => /FOR\s+UPDATE/i.test(p));
    expect(upd.length).toBe(1);
    expect(upd[0]).toMatch(/manage_franchise/);
    // can_write_org here would put dispatchers back — the original defect.
    expect(upd[0]).not.toMatch(/can_write_org/);
  });

  it("lets NOBODY insert or delete through the table", () => {
    // Settlements are produced by generate_franchise_settlements (SECURITY
    // DEFINER) and are never destroyed: a statement that can be deleted after
    // it is issued is not evidence of anything.
    for (const p of policies) {
      expect(p, p.slice(0, 70)).not.toMatch(/FOR\s+(INSERT|DELETE)/i);
    }
  });

  it("checks manage_franchise really is owner-only in the matrix", () => {
    // The policy is only as strict as the permission it names. If
    // manage_franchise were ever granted to office_manager or dispatcher, the
    // rule above would silently widen without anyone editing the policy.
    expect(ROLE_PERMISSIONS.owner).toContain("manage_franchise");
    expect(ROLE_PERMISSIONS.office_manager).not.toContain("manage_franchise");
    expect(ROLE_PERMISSIONS.dispatcher).not.toContain("manage_franchise");
    expect(ROLE_PERMISSIONS.tech).not.toContain("manage_franchise");
  });
});

describe("the server function agrees with the table", () => {
  const src = readFileSync(join(ROOT, "src/lib/franchise.functions.ts"), "utf8");
  const fn = src.slice(
    src.indexOf("export const setRoyaltyInvoiceStatus"),
    src.indexOf("export const", src.indexOf("export const setRoyaltyInvoiceStatus") + 10),
  );

  it("requires manage_franchise before changing a royalty invoice's status", () => {
    // Via resolveOrgId, which in THIS file is requirePermission of
    // 'manage_franchise' plus the Enterprise entitlement — not the bare org
    // lookup the same name means elsewhere in the repo. I misread that once and
    // reported this function as ungated; it never was. The RLS policy was the
    // hole, not this.
    expect(fn).toMatch(/resolveOrgId\(context\.supabase, context\.userId\)/);
    const helper = src.slice(src.indexOf("async function resolveOrgId"));
    // To the closing brace in column 0 — the first `}` in the body belongs to
    // the `const { orgId }` destructuring, which is how this read wrong once
    // already.
    const body = helper.slice(0, helper.indexOf("\n}"));
    expect(body).toMatch(/requirePermission\([\s\S]*"manage_franchise"/);
  });

  it("fails loudly when the update matches nothing", () => {
    // RLS refusing an UPDATE matches zero rows, and PostgREST returns no error
    // for that — so without this the caller is told it saved while nothing
    // changed. BUG-30 was exactly that: a zero-row UPDATE is a successful one.
    expect(fn).toMatch(/\.select\("id"\)/);
    expect(fn).toMatch(/if\s*\(!rows\?\.length\)/);
  });
});
