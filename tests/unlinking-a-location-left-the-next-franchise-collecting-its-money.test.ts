// Unlinking a location left the next franchise collecting its money.
//
// Owner decision, 2026-08-19: clear the routing state on unlink, in the same
// transaction that ends the link.
//
// ── THE TWO COLUMNS THAT SURVIVED ─────────────────────────────────────────
//
// `unlink_franchise_child` cleared `parent_organization_id` and reset
// `franchise_royalty_percent`. It left `payments_collected_by_parent` and
// `chargeback_responsibility` exactly as the franchise had set them.
//
// Harmless today, and only by luck: `resolveOrgStripeAccount` requires the flag
// AND a non-null parent, so with the parent gone the stale `true` decides
// nothing. It is one clause away from mattering, and the sequence that makes it
// matter needs no bug anywhere else — the location redeems a DIFFERENT
// franchise's link code, `redeem_franchise_link_code` sets
// `parent_organization_id` and nothing more, and the row now says that the new
// franchise collects this location's customer payments and carries a chargeback
// split nobody agreed to. The routing screen reads the flag it finds and
// reports it as the arrangement.
//
// ── WHY NOT IN TYPESCRIPT ─────────────────────────────────────────────────
//
// Clearing them after the RPC returns would make the app a second writer of
// routing state, outside the transaction that ends the link and outside the
// `app.allow_protected_org_write` guard that lets these columns be written at
// all. Two writers, one of which can crash between statements, is how a row
// ends up half-unlinked: parent gone, money still routed.
//
// ── WHAT COULD NOT BE MEASURED ────────────────────────────────────────────
//
// Nothing. `payments_collected_by_parent` is false on all four organizations in
// the live database and `chargeback_responsibility` is 'location' on all four,
// so no row carries stale routing and no unlink has ever left one. The fix is
// for the next unlink, not for a row that exists.

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MIGRATIONS = join(ROOT, "supabase", "migrations");

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/** A migration with its comments removed. Every header in this repo quotes the
 *  SQL it is about, so a whole-file scan reads the explanation as code. */
function sqlCode(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

function latestDefinitionOf(fn: string): string {
  const re = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${fn}\\s*\\(`, "i");
  let body = "";
  for (const f of migrationFiles()) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8");
    const m = re.exec(sql);
    if (!m) continue;
    const tail = sql.slice(m.index);
    const open = /\bAS\s+\$(\w*)\$/.exec(tail)!;
    const tag = `$${open[1]}$`;
    body = tail.slice(0, tail.indexOf(tag, open.index + open[0].length));
  }
  return body;
}

const unlink = latestDefinitionOf("unlink_franchise_child");

describe("ending a franchise link ends all of it", () => {
  it("finds the routine at all", () => {
    expect(unlink.length, "unlink_franchise_child is in no migration").toBeGreaterThan(0);
  });

  it("clears the payment routing flag", () => {
    expect(
      unlink,
      "an unlinked location still says its old franchise collects its customer payments",
    ).toMatch(/payments_collected_by_parent = false/);
  });

  it("clears the chargeback split", () => {
    expect(unlink, "a liability split agreed with one franchise is inherited by the next").toMatch(
      /chargeback_responsibility = 'location'/,
    );
  });

  it("clears them in the SAME statement that ends the link", () => {
    // Not a second UPDATE, and certainly not a second writer in TypeScript: a
    // row that is half-unlinked — parent gone, money still routed — is the
    // exact state this is meant to make unreachable.
    const stmt = unlink.slice(
      unlink.indexOf("UPDATE public.organizations"),
      unlink.indexOf(";", unlink.indexOf("UPDATE public.organizations")),
    );
    expect(stmt).toMatch(/parent_organization_id = NULL/);
    expect(stmt).toMatch(/franchise_royalty_percent = 0/);
    expect(stmt).toMatch(/payments_collected_by_parent = false/);
    expect(stmt).toMatch(/chargeback_responsibility = 'location'/);
  });

  it("does not weaken who may remove a location", () => {
    // A franchisee cannot detach itself: exit is governed by the franchise
    // agreement rather than by software. Platform admins are included so a
    // franchisee whose parent has gone quiet is not stranded.
    expect(unlink).toMatch(/has_role\(auth\.uid\(\), _parent, 'owner'::public\.app_role\)/);
    expect(unlink).toMatch(/_caller_org = _parent/);
    expect(unlink).toMatch(/is_platform_admin\(auth\.uid\(\)\)/);
  });

  it("still stops calling an org a parent once its last location goes", () => {
    expect(unlink).toMatch(/UPDATE public\.organizations SET is_franchise_parent = false/);
  });

  it("is deliberately NOT plan-gated", () => {
    // A paywall may withhold a capability. It must not lock an organization
    // inside a relationship — and the TypeScript wrapper makes the same
    // argument for having no requireEntitlement, so gating one side would put
    // the two in disagreement.
    expect(unlink, "a franchise whose plan lapses can no longer release its locations").not.toMatch(
      /has_plan_entitlement/,
    );
    const wrapper = readFileSync(
      join(ROOT, "src/lib/franchise-membership.functions.ts"),
      "utf8",
    ).slice(0);
    const fn = wrapper.slice(wrapper.indexOf("export const removeFranchiseLocation"));
    expect(fn).not.toMatch(/requireEntitlement/);
  });
});

describe("the values it clears to are the ones a never-linked org has", () => {
  const file = migrationFiles().find((f) =>
    f.includes("unlinking-a-location-left-the-next-franchise-collecting-its-money"),
  );
  const sql = file ? readFileSync(join(MIGRATIONS, file), "utf8") : "";

  it("exists", () => {
    expect(file, "the unlink migration is missing").toBeTruthy();
  });

  it("checks the column defaults rather than assuming them", () => {
    // "Reset to the default" is only meaningful if these ARE the defaults, and
    // a later migration is free to change one. Read from the catalog, so the
    // claim stays true or the replay says why not.
    expect(sql).toMatch(/information_schema\.columns/);
    expect(sql).toMatch(/column_name = 'payments_collected_by_parent'/);
    expect(sql).toMatch(/column_name = 'chargeback_responsibility'/);
  });

  it("reads prosrc by name rather than pg_get_functiondef over a schema", () => {
    expect(sqlCode(sql)).not.toMatch(/pg_get_functiondef\s*\(/);
    expect(sql).toMatch(/p\.proname = 'unlink_franchise_child'/);
  });

  it("raises only on what it establishes, and warns about what it measured", () => {
    const survey = sql.slice(sql.indexOf("WHAT WAS MEASURED"));
    expect(survey.length).toBeGreaterThan(0);
    expect(survey).toMatch(/RAISE WARNING/);
    expect(survey).not.toMatch(/RAISE EXCEPTION/);
    expect(survey).toMatch(/SKIPPED/);
  });

  it("does not remediate rows, and says so", () => {
    // A migration that rewrote existing routing state would be making a
    // decision about somebody's money on its own authority.
    expect(sql).not.toMatch(/^\s*UPDATE public\.organizations\s+SET payments_collected/m);
    expect(sql).toMatch(/does not clean those rows/);
  });

  it("does not assert on operations state a fresh build cannot create", () => {
    expect(sql).not.toMatch(/cron\.job/);
  });

  it("restates the grants it depends on rather than trusting CREATE OR REPLACE", () => {
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.unlink_franchise_child\(uuid\) FROM PUBLIC, anon;/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.unlink_franchise_child\(uuid\) TO authenticated, service_role;/,
    );
  });
});
