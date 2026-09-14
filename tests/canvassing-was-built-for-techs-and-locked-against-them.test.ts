import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROUTE_ROLES } from "@/hooks/useMyRole";
import { hasPermission } from "@/lib/permissions";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** The last migration that says anything about neighbor_leads policies, with
 *  SQL line comments stripped — this file's subject is heavily commented and
 *  every assertion below would pass on the prose otherwise. */
function latestNeighborPolicySql(): string {
  const dir = join(ROOT, "supabase", "migrations");
  let latest = "";
  for (const f of readdirSync(dir).sort()) {
    const sql = readFileSync(join(dir, f), "utf8").replace(/--[^\n]*/g, "");
    if (/POLICY[^;]*ON\s+public\.neighbor_leads/i.test(sql)) latest = sql;
  }
  return latest;
}

// Reported from an iPhone: "As a technician... I can't select a client to go
// off of for neighbors/doors, and if I enter an address to be a lead I receive
// an error."
//
// neighbor_leads carried ONE policy, FOR ALL, USING and WITH CHECK both
// view_client_directory — which a tech does not hold. So the list came back
// empty, adding a door raised, and the walk mode's buttons did nothing.
//
// The point of this file is the DISAGREEMENT, not the policy text: four places
// in src/ were written for a technician doing this work, and the policy was
// never widened to agree with them. That is the shape that stayed invisible,
// because each half is reasonable on its own.
describe("the roles canvassing is offered to are the roles it works for", () => {
  const sql = latestNeighborPolicySql();

  it("finds the migration at all", () => {
    // Guard: every assertion below is a regex over this string, and they all
    // pass vacuously against "".
    expect(sql, "no migration mentions a policy on public.neighbor_leads").toBeTruthy();
    expect(sql).toMatch(/CREATE POLICY/i);
  });

  it("the page is offered to technicians", () => {
    // The premise. If /neighbors ever stops admitting techs then the policy was
    // right all along and this whole file is the thing that should fail.
    expect(ROUTE_ROLES["/neighbors"], "/neighbors no longer admits techs").toContain("tech");
  });

  it("a technician still does not hold the client directory", () => {
    // The other premise, and the reason the fix is not "give techs the
    // permission": that would hand them the client roster.
    expect(hasPermission("tech", "view_client_directory")).toBe(false);
    expect(hasPermission("dispatcher", "view_client_directory")).toBe(true);
  });

  it("reading, adding and answering a door no longer need the directory", () => {
    for (const [cmd, label] of [
      ["SELECT", "reading the list"],
      ["INSERT", "adding a door"],
      ["UPDATE", "recording an answer"],
    ] as const) {
      const m = sql.match(new RegExp(`FOR ${cmd}\\b[\\s\\S]*?;`, "i"));
      expect(m, `no ${cmd} policy on neighbor_leads`).toBeTruthy();
      expect(
        m![0],
        `${label} still requires view_client_directory, which a technician does not hold — ` +
          "that is the bug this file exists for",
      ).not.toMatch(/view_client_directory/);
      expect(m![0], `${label} must still be scoped to the caller's organization`).toMatch(
        /is_org_member/,
      );
    }
  });

  it("deleting still does", () => {
    // Not a widening of everything. Delete is the destructive one and the
    // office has the screen for it; a tech could not delete before either.
    const m = sql.match(/FOR DELETE\b[\s\S]*?;/i);
    expect(m, "no DELETE policy on neighbor_leads").toBeTruthy();
    expect(m![0], "anyone in the org can now delete a day's canvassing").toMatch(
      /view_client_directory/,
    );
  });

  it("no FOR ALL policy survives", () => {
    // A single FOR ALL is how the four commands got one answer between them in
    // the first place. Re-adding one would silently re-merge them.
    expect(sql, "a FOR ALL policy would collapse the four commands again").not.toMatch(
      /FOR ALL[\s\S]{0,200}ON public\.neighbor_leads/i,
    );
  });

  it("the seed picker is not gated on the directory any more", () => {
    // The other half of the report. The card was wrapped in
    // `{canSeeDirectory && (`, so a technician was shown no picker at all.
    const page = read("src/routes/_authenticated/neighbors.tsx").replace(/\/\/[^\n]*/g, "");
    expect(page, "the seed card is still hidden from anyone without the client directory").not.toMatch(
      /\{canSeeDirectory && \(\s*<Card>/,
    );
    expect(
      page,
      "the picker should be fed by listCanvassSeedClients, which answers with the caller's own " +
        "clients when they cannot see the roster",
    ).toContain("listCanvassSeedClients");
  });

  it("seeding is authorized per client, not per role alone", () => {
    const fns = read("src/lib/neighbors.functions.ts").replace(/\/\/[^\n]*/g, "");
    // A tech may seed around a client they are ASSIGNED to. The check has to
    // read the caller's own visits; a bare role test cannot express that.
    expect(fns, "resolveSeederOrgId no longer takes the client it is authorizing").toMatch(
      /resolveSeederOrgId\(\s*supabase[\s\S]{0,120}clientId/,
    );
    expect(fns, "seeding no longer checks the caller's assigned visits").toMatch(
      /assigned_staff_id[\s\S]{0,200}client_id/,
    );
  });
});
