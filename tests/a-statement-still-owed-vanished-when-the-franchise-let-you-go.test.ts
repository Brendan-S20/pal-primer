// A statement you still owed vanished from your own settings page the moment
// the franchise let you go.
//
// Found while building the removal screen (Owner QA, 2026-08-19,
// "Enterprise/Franchise doesn't fully function correctly"). It is the same
// fault class as the ZIP chips: the UI and the thing underneath it disagreed,
// and the UI was the one telling the customer.
//
// ── THE DISAGREEMENT ──────────────────────────────────────────────────────
//
// unlink_franchise_child says what it preserves, in its own comment:
//
//   "Royalty invoices already raised are intentionally preserved — unlinking
//    is not a way to erase what was owed."
//
// It keeps its word. It writes exactly two columns on the child's own row —
// `parent_organization_id = NULL` and `franchise_royalty_percent = 0` — and
// touches neither `franchise_royalty_invoices` nor `franchise_adjustments`.
//
// Both server functions on the location's side keep working afterwards too,
// because neither of them reads `parent_organization_id`:
// getMyFranchiseSettlements filters on `child_organization_id`, and
// franchise_adjustment_ledger matches either side of the row it is looking at.
// The rows were there, readable, the whole time.
//
// /settings/franchise then mounted both panels behind `m?.isChild`, which is
// `!!parent_organization_id`. So the one column removal DOES clear was the
// column deciding whether the location could still read its own bill.
//
// ── WHY THAT IS THE EXPENSIVE DIRECTION ───────────────────────────────────
//
// The franchise keeps its copy — listRoyaltyInvoices filters on
// `parent_organization_id`, which removal does not touch on the parent's side
// and which is stamped on each statement row anyway. So after a removal, the
// two parties who are supposed to reconcile the same document are left with
// one of them able to read it. An issued, unpaid statement is money owed in
// one direction or the other — under parent-collection the franchise is
// holding the LOCATION's money and owes most of it back — and the side that
// loses sight of it is the side with no way to chase it.
//
// ── THE FIX ───────────────────────────────────────────────────────────────
//
// getMyFranchiseMembership answers one more question — is there anything on
// record from a link that has ended — and the page mounts the two ledgers on
// that OR current membership. Asked only when the organization is not a child
// now, so an organization that has never been in a franchise runs two head
// counts and mounts nothing, rather than meeting an empty "Settlement
// statements" card on its settings page.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return (
        !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("{/*")
      );
    })
    .join("\n");

const membershipFns = read("src/lib/franchise-membership.functions.ts");
const settingsPage = read("src/routes/_authenticated/settings.franchise.tsx");

function serverFnBody(src: string, name: string): string {
  const start = src.indexOf(`export const ${name} = createServerFn`);
  if (start === -1) return "";
  const rest = src.slice(start + 10);
  const next = rest.indexOf("\nexport const ");
  return next === -1 ? rest : rest.slice(0, next);
}

/** The last definition of a plpgsql function across the migration sequence,
 *  which is the one that runs. */
function lastFunctionBody(name: string): string {
  const dir = join(ROOT, "supabase/migrations");
  let found = "";
  for (const f of readdirSync(dir)
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    const sql = readFileSync(join(dir, f), "utf8");
    const re = new RegExp(
      `CREATE OR REPLACE FUNCTION public\\.${name}\\s*\\([\\s\\S]*?\\n\\$\\$;`,
      "g",
    );
    for (const hit of sql.match(re) ?? []) found = hit;
  }
  return found;
}

const unlinkSql = lastFunctionBody("unlink_franchise_child");

describe("what removal actually destroys, in SQL", () => {
  it("clears the membership and nothing else on the child's row", () => {
    expect(unlinkSql, "unlink_franchise_child not found").not.toBe("");
    expect(unlinkSql).toContain("parent_organization_id = NULL");
    expect(unlinkSql).toContain("franchise_royalty_percent = 0");
  });

  it("does not touch the statements or the adjustments", () => {
    // The premise of everything below. If this ever stops being true the fix on
    // the UI side is wrong rather than incomplete.
    expect(
      unlinkSql,
      "removal must not delete or rewrite settlement statements",
    ).not.toMatch(/franchise_royalty_invoices/);
    expect(unlinkSql, "removal must not delete or rewrite adjustments").not.toMatch(
      /franchise_adjustments/,
    );
  });
});

describe("the location's own reads survive a removal", () => {
  it("finds statements by child_organization_id, not by membership", () => {
    const body = codeOnly(serverFnBody(membershipFns, "getMyFranchiseSettlements"));
    expect(body).toContain('.eq("child_organization_id", orgId)');
    expect(
      body,
      "reading the location's statements must not depend on a column removal clears",
    ).not.toContain("parent_organization_id");
  });
});

describe("the page shows them after the link ends", () => {
  const code = codeOnly(settingsPage);

  it("does not gate the two ledgers on current membership alone", () => {
    // The defect in one line: `{m?.isChild ? <MyStatements /> : null}`.
    expect(code).not.toMatch(/m\?\.isChild \? <MyStatements \/> : null/);
    expect(code).not.toMatch(/m\?\.isChild \? <MyAdjustments \/> : null/);
    expect(code).toMatch(/\{showLedgers \? <MyStatements \/> : null\}/);
    expect(code).toMatch(/\{showLedgers \? <MyAdjustments \/> : null\}/);
  });

  it("shows them when the organization was a location, as well as when it is one", () => {
    expect(code).toMatch(/const showLedgers =[\s\S]{0,80}m\.isChild \|\| m\.hasFranchiseHistory/);
  });

  it("says why they are still there, so an ex-location is not left guessing", () => {
    // A statement panel on the settings page of an organization that is not in
    // a franchise reads as a bug unless something on the screen accounts for
    // it. And the fact worth saying is the one the SQL insists on: the removal
    // did not clear the debt.
    const flat = settingsPage.replace(/\s+/g, " ");
    expect(flat).toMatch(/no longer part of a franchise/i);
    expect(flat).toMatch(/anything still unpaid is still owed/i);
  });

  it("does not put an empty ledger in front of an organization that never had one", () => {
    // The other direction of the same mistake. Every solo operator opens
    // /settings/franchise to find the Join card; none of them should meet two
    // empty money panels underneath it.
    expect(code).toMatch(/const showLedgers = !!m &&/);
  });
});

describe("the server answers the question the page now asks", () => {
  const body = codeOnly(serverFnBody(membershipFns, "getMyFranchiseMembership"));

  it("reports whether a finished franchise link left anything on record", () => {
    expect(body).toContain("hasFranchiseHistory");
    expect(body).toContain('.from("franchise_royalty_invoices")');
    expect(body).toContain('.from("franchise_adjustments")');
  });

  it("scopes that question to this organization's own rows", () => {
    // Service-role reads across two money tables. Pinned to
    // child_organization_id, so it can only ever count rows this organization
    // is itself the subject of.
    const counts = body.slice(body.indexOf("hasFranchiseHistory"));
    expect(counts.match(/\.eq\("child_organization_id", orgId\)/g)?.length ?? 0).toBe(2);
  });

  it("asks it only when the organization is not currently a location", () => {
    // A child already mounts both panels; asking again would be two head counts
    // per page view for an answer nothing reads.
    expect(body).toMatch(/if \(!me\?\.parent_organization_id\) \{/);
  });

  it("ignores drafts, exactly as the statement list does", () => {
    // A draft is a figure still moving and is not shown to the location, so a
    // draft alone must not be the reason a panel appears — it would appear
    // empty, which is the fault this test exists about, inverted.
    expect(body).toMatch(/\.neq\("status", "draft"\)/);
  });
});
