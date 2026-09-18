import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Q-5: techs can log a DNA sample from the field.
//
// This is the capability a comment in useMyRole.ts claimed existed for months
// while nothing implemented it. Chasing that claim found the hole this sits
// next to: every RLS policy on dna_matches was `is_org_member`, which techs
// pass, so a tech could re-point a $250 violation onto another client's dog,
// close it, and delete a sample sitting at the lab.
//
// So the shape of THIS feature is the security boundary, not an implementation
// detail. What the RPC declines to accept is what stops it from re-opening
// what the previous migration closed. These assertions read the shipped SQL
// rather than restating the rule — a test that restates it agrees with itself
// no matter what the database does.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MIGRATIONS = join(ROOT, "supabase", "migrations");

function latestDefinitionOf(fnName: string): string {
  const re = new RegExp(
    `CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${fnName}\\s*\\(`,
    "i",
  );
  let found: string | null = null;
  for (const f of readdirSync(MIGRATIONS)
    .filter((x) => x.endsWith(".sql"))
    .sort()) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8");
    if (re.test(sql)) found = sql.slice(sql.search(re));
  }
  if (!found) throw new Error(`no migration defines ${fnName}`);
  return found;
}

describe("log_dna_sample_from_field — what it refuses to accept", () => {
  const sql = latestDefinitionOf("log_dna_sample_from_field");
  // The parameter list only — everything before the body begins.
  const params = sql.slice(0, sql.indexOf("RETURNS"));

  it("is guarded by is_visit_tech and nothing weaker", () => {
    // The caller must BE the visit's assigned tech. can_write_org or
    // is_org_member here would let any office user — or any tech in the org —
    // file a sample against work they have nothing to do with.
    expect(sql).toMatch(
      /IF\s+NOT\s+public\.is_visit_tech\s*\(\s*auth\.uid\(\)\s*,\s*_visit_id\s*\)/i,
    );
    expect(params).not.toMatch(/is_org_member|can_write_org/i);
  });

  it("takes a VISIT, never a property, client or organization", () => {
    // Derivation is the control. If the caller could name the property, a tech
    // could file against a property they have never been to.
    expect(params).toMatch(/_visit_id\s+uuid/i);
    expect(params).not.toMatch(/_property_id|_client_id|_org_id|_organization_id/i);
    expect(sql).toMatch(/SELECT\s+v\.organization_id,\s*v\.property_id,\s*v\.client_id/i);
  });

  it("cannot be told a fine, a matched dog, or a status", () => {
    // The three fields that decide who pays. A field sample is always new,
    // unmatched and unpriced; deciding otherwise stays an office action behind
    // can_write_org and manage_dna_billing.
    expect(params).not.toMatch(/_fine|_matched_dog|_status\b/i);
    // And the INSERT hard-codes the safe status rather than passing one through.
    expect(sql).toMatch(/'new'/);
  });

  it("attributes the sample to the visit's own assigned tech", () => {
    // Not to a staff id the caller supplies — that would let one tech file
    // under another's name.
    expect(params).not.toMatch(/_staff_id|_collected_by/i);
    expect(sql).toMatch(/collected_by_staff_id/);
  });

  it("refuses a client who is not on the DNA programme", () => {
    expect(sql).toMatch(/dna_compliance_enabled/);
  });

  it("refuses a unit that is not at the visit's property", () => {
    expect(sql).toMatch(/u\.property_id\s*=\s*_prop/i);
  });

  it("refuses a storage path outside the caller's own organization", () => {
    expect(sql).toMatch(/_sample_photo_path\s+NOT\s+LIKE/i);
  });

  it("is executable by authenticated but not anon", () => {
    expect(sql).toMatch(/REVOKE\s+EXECUTE[\s\S]*FROM\s+PUBLIC,\s*anon/i);
    expect(sql).toMatch(/GRANT\s+EXECUTE[\s\S]*TO\s+authenticated/i);
  });
});

describe("dna_matches is not writable by every org member any more", () => {
  it("every policy is gated on can_write_org", () => {
    // The migration that closed the hole. If someone reintroduces an
    // is_org_member policy, the field-logging RPC above stops being the only
    // way a tech can touch this table.
    let latest: string | null = null;
    for (const f of readdirSync(MIGRATIONS)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      const s = readFileSync(join(MIGRATIONS, f), "utf8");
      if (/CREATE\s+POLICY[^;]*ON\s+public\.dna_matches/i.test(s)) latest = s;
    }
    expect(latest, "no migration creates policies on dna_matches").toBeTruthy();
    const policies = latest!.match(/CREATE\s+POLICY[\s\S]*?;/gi) ?? [];
    expect(policies.length).toBe(4);
    for (const p of policies) {
      expect(p, p.slice(0, 60)).toMatch(/can_write_org/);
      expect(p, p.slice(0, 60)).not.toMatch(/is_org_member/);
    }
  });
});
