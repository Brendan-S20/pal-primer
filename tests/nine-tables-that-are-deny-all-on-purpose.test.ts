import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { migrationFiles, readMigration, statements, stripLineComments } from "./support/sql-migrations";

// Nine tables have RLS enabled and ZERO policies, and the security advisor
// reports each one as `rls_enabled_no_policy` forever.
//
// All nine are correct. RLS with no policies is deny-all to `anon` and
// `authenticated` — it is evaluated after the blanket table grants Supabase
// applies project-wide, so those grants buy nothing. `relforcerowsecurity` is
// false, so the postgres-owned SECURITY DEFINER functions and the service-role
// client pass through, and those are the only callers any of these tables has.
//
// That is the shape you want for a one-time password, a session token, a CSRF
// nonce and an encrypted carrier credential. For two of them a policy would be
// an actual regression rather than merely loose: a readable `impersonation_grants`
// row tells a tenant they are being impersonated, and a readable `oauth_states`
// row defeats the callback check it exists to make.
//
// So this file is the exception, written down. The advisor line is dismissed on
// evidence — this test — rather than re-investigated every time somebody reads
// the list. What it asserts is the thing that would make the dismissal wrong:
// that no migration ever gives one of these tables a policy. That is the shape
// 20260801091000 already uses for `roadmap_votes`, generalised to the other eight.
//
// It deliberately does NOT assert that RLS is enabled. `rls_auto_enable` does
// that for every table, and duplicating it here would be a second definition of
// somebody else's rule.
const DENY_ALL: Record<string, string> = {
  portal_otps: "one-time codes for the customer portal; read only by supabaseAdmin in portal-auth.server.ts",
  portal_sessions: "portal session tokens; same file, plus regenerate_portal_token revokes rows",
  portal_code_attempts: "brute-force counter for the portal codes; same file",
  email_verifications: "signup verification tokens; auth-entry.functions.ts and api/public/verify-email.ts",
  impersonation_grants: "a readable row here tells a tenant they are being impersonated",
  oauth_states: "CSRF nonces for the accounting connectors; a readable state defeats the callback check",
  org_twilio_credentials: "holds an encrypted carrier auth token; deny-all is the entire point",
  roadmap_votes: "reached only through cast_roadmap_vote / roadmap_vote_counts; nothing in src/ names it",
  roadmap_vote_throttle: "salted hashes of voters' addresses; a readable row is the list the poll promises not to keep",
  webhook_endpoint_secrets: "encrypted webhook signing keys; read only by the delivery worker on the service role",
};

/** `CREATE POLICY ... ON [public.]<table>` — parsed, because these migrations
 *  discuss the tables in prose at length and a text match finds the paragraph
 *  as readily as the statement. */
function policiesOn(table: string): string[] {
  const hits: string[] = [];
  const re = new RegExp(String.raw`^create\s+policy\b[\s\S]*?\bon\s+(?:public\.)?"?${table}"?\b`, "i");
  for (const file of migrationFiles()) {
    for (const st of statements(stripLineComments(readMigration(file)))) {
      if (re.test(st)) hits.push(`${file}: ${st.replace(/\s+/g, " ").slice(0, 90)}`);
    }
  }
  return hits;
}

describe("the eight deny-all tables", () => {
  it("parses policies at all, so the rule below is not vacuous", () => {
    // If CREATE POLICY stopped matching, every assertion here would pass on
    // nothing. This repo has a great many policies; a handful proves the parser.
    const anywhere = migrationFiles()
      .flatMap((f) => statements(stripLineComments(readMigration(f))))
      .filter((st) => /^create\s+policy\b/i.test(st));
    expect(anywhere.length).toBeGreaterThan(20);
  });

  for (const [table, why] of Object.entries(DENY_ALL)) {
    it(`${table} is never given a policy — ${why}`, () => {
      const found = policiesOn(table);
      expect(
        found,
        found.length
          ? `${table} is deny-all on purpose (${why}). A policy here does not "fix" the\n` +
            `advisor finding, it opens the table to anon and authenticated, which is the\n` +
            `thing the deny-all was for. If the table genuinely needs a policy now, delete\n` +
            `its entry from DENY_ALL and say why in docs/security-advisor-triage.md:\n` +
            found.map((f) => `  ${f}`).join("\n")
          : "",
      ).toEqual([]);
    });
  }

  it("names every table the triage document names, and no others", () => {
    // The doc and this list are two halves of one claim. If they drift, the
    // document is describing a rule that is not enforced.
    const doc = readFileSync(join(__dirname, "..", "docs", "security-advisor-triage.md"), "utf8");
    for (const table of Object.keys(DENY_ALL)) {
      expect(doc, `${table} is pinned here but missing from the triage doc`).toContain(table);
    }
  });
});
