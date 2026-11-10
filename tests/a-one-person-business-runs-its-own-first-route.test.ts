// Onboarding audit, 2026-11-09, D13: the owner of a one-person business saved
// their first weekly plan during setup (the clients step comes before "Who
// runs the route") and every generated visit read "Unassigned"; the schedule
// said "No visits today. / 0 Unassigned" and My Day was empty. There was
// nobody else in the business the visits could ever go to.
//
// The fix has two halves: the new-client save puts the sole owner on routes
// and gives them the plan's visits (solo-owner-route.server.ts), and the
// visits trigger gives a one-person scooping business every later visit the
// nightly generator makes (20261109200000).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  giveSoloOwnerThePlan,
  soloOwnerRunsTheRoute,
  type SoloStaffRow,
} from "@/lib/solo-owner-route.server";

const OWNER = "user-owner";
const owner = (over: Partial<SoloStaffRow> = {}): SoloStaffRow => ({
  id: "staff-owner",
  user_id: OWNER,
  role: "owner",
  active: true,
  is_field_tech: false,
  ...over,
});

describe("who runs a one-person business's route", () => {
  it("is the owner, when they are the only active person and no tech is invited", () => {
    expect(soloOwnerRunsTheRoute([owner()], 0, OWNER)).toEqual({
      staffId: "staff-owner",
      alreadyRunsRoutes: false,
    });
    expect(soloOwnerRunsTheRoute([owner({ is_field_tech: true })], 0, OWNER)).toEqual({
      staffId: "staff-owner",
      alreadyRunsRoutes: true,
    });
  });

  it("is nobody in particular when somebody else could be", () => {
    const tech: SoloStaffRow = { ...owner(), id: "t", user_id: "u-t", role: "tech" };
    expect(soloOwnerRunsTheRoute([owner(), tech], 0, OWNER)).toBeNull();
    // An invitation sent is the owner saying a tech is coming.
    expect(soloOwnerRunsTheRoute([owner()], 1, OWNER)).toBeNull();
    // Only the owner decides that the owner runs the route.
    expect(soloOwnerRunsTheRoute([owner({ role: "office_manager" })], 0, OWNER)).toBeNull();
    expect(soloOwnerRunsTheRoute([owner()], 0, "someone-else")).toBeNull();
    expect(soloOwnerRunsTheRoute([], 0, OWNER)).toBeNull();
  });
});

/** Just enough of supabase-js for the helper: records each write. */
function fakeDb(state: {
  staff: SoloStaffRow[];
  invites: number;
  visits: { id: string; subscription_id: string; assigned_staff_id: string | null }[];
}) {
  const writes: { table: string; patch: Record<string, unknown> }[] = [];
  const from = (table: string) => {
    const filters: [string, string, unknown][] = [];
    let patch: Record<string, unknown> | null = null;
    const q: any = {
      select: () => q,
      update: (p: Record<string, unknown>) => ((patch = p), q),
      eq: (c: string, v: unknown) => (filters.push(["eq", c, v]), q),
      is: (c: string, v: unknown) => (filters.push(["is", c, v]), q),
      then: (ok: (r: unknown) => unknown, bad?: (e: unknown) => unknown) => {
        const run = () => {
          if (table === "org_invites") return { count: state.invites, error: null };
          const rows: any[] = table === "staff" ? state.staff : state.visits;
          const hit = rows.filter((r) =>
            filters.every(([op, c, v]) =>
              c === "organization_id" ? true : op === "is" ? r[c] === v : r[c] === v,
            ),
          );
          if (patch) {
            writes.push({ table, patch });
            hit.forEach((r) => Object.assign(r, patch));
          }
          return { data: hit, error: null };
        };
        return Promise.resolve(run()).then(ok, bad);
      },
    };
    return q;
  };
  return { db: { from }, writes };
}

describe("saving the first plan in a one-person business", () => {
  it("puts the owner on routes and gives them every unassigned visit of that plan", async () => {
    const state = {
      staff: [owner()],
      invites: 0,
      visits: [
        { id: "v1", subscription_id: "sub-1", assigned_staff_id: null },
        { id: "v2", subscription_id: "sub-1", assigned_staff_id: null },
        { id: "v3", subscription_id: "sub-other", assigned_staff_id: null },
      ],
    };
    const { db, writes } = fakeDb(state);
    const r = await giveSoloOwnerThePlan(db, {
      orgId: "org",
      userId: OWNER,
      subscriptionId: "sub-1",
    });
    expect(r).toEqual({ assigned: 2, putOnRoutes: true });
    // The same write as "That's me": marked as a human decision so the
    // role-based reconciliation does not undo it.
    expect(writes[0]).toEqual({
      table: "staff",
      patch: { is_field_tech: true, is_field_tech_overridden: true },
    });
    expect(state.visits.map((v) => v.assigned_staff_id)).toEqual([
      "staff-owner",
      "staff-owner",
      null,
    ]);
  });

  it("leaves a business with a second person, or an invited tech, to dispatch", async () => {
    for (const s of [
      { staff: [owner(), { ...owner(), id: "t", user_id: "u-t", role: "tech" }], invites: 0 },
      { staff: [owner()], invites: 1 },
    ]) {
      const state = {
        ...s,
        visits: [{ id: "v1", subscription_id: "sub-1", assigned_staff_id: null }],
      };
      const { db, writes } = fakeDb(state);
      expect(
        await giveSoloOwnerThePlan(db, { orgId: "org", userId: OWNER, subscriptionId: "sub-1" }),
      ).toBeNull();
      expect(writes).toEqual([]);
      expect(state.visits[0].assigned_staff_id).toBeNull();
    }
  });

  it("is wired into onboardClient after the visits are generated, and the form says so", () => {
    const fn = readFileSync(resolve(__dirname, "../src/lib/clients.functions.ts"), "utf8");
    const body = fn.slice(fn.indexOf("export const onboardClient"));
    const gen = body.indexOf("await generateVisitHorizon(supabase, orgId);");
    const give = body.indexOf("await giveSoloOwnerThePlan(supabase, {");
    expect(gen).toBeGreaterThan(0);
    expect(give).toBeGreaterThan(gen);
    expect(body).toContain("soloOwnerAssigned: soloOwner?.assigned ?? 0,");
    const form = readFileSync(
      resolve(__dirname, "../src/routes/_authenticated/clients.new.tsx"),
      "utf8",
    );
    expect(form).toMatch(/if \(soloOwnerAssigned > 0\)/);
    expect(form).toContain("Invite a tech any time in Settings, Users & roles.");
  });
});

describe("the nightly generator gives a one-person scooping business its own visits", () => {
  const sql = readFileSync(
    resolve(
      __dirname,
      "../supabase/migrations/20261109200000_a-one-person-scooping-business-runs-its-own-route.sql",
    ),
    "utf8",
  );
  const fill = sql.slice(
    sql.indexOf("CREATE OR REPLACE FUNCTION public.fill_visit_walker()"),
    sql.indexOf("REVOKE ALL ON FUNCTION public.fill_visit_walker()"),
  );

  it("covers pet waste and plans with no service, and nothing that can clash", () => {
    expect(fill).toContain(
      "IF _line IS NOT NULL AND _line NOT IN ('dog_walking', 'pet_waste') THEN",
    );
    expect(fill).not.toContain("IF _line IS DISTINCT FROM 'dog_walking' THEN");
    expect(fill).not.toMatch(/mobile_grooming|training|pet_sitting/);
  });

  it("keeps every other rule of 20261108170100: insert only, never overwrite, never fail", () => {
    expect(fill).toContain(
      "IF NEW.assigned_staff_id IS NOT NULL OR NEW.subscription_id IS NULL THEN",
    );
    expect(fill).toContain("IF NOT FOUND OR _stay IS NOT NULL THEN");
    expect(fill).toContain("IF _people = 1 AND EXISTS (");
    expect(fill.match(/COALESCE\(st\.is_field_tech, false\)/g)).toHaveLength(2);
    expect(fill.match(/NOT public\.is_staff_off\(/g)).toHaveLength(2);
    expect(fill).not.toContain("RAISE");
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION public.fill_visit_walker() FROM PUBLIC, anon, authenticated;",
    );
  });

  it("and the walker proof now expects the cleanup to go to the owner", () => {
    const proof = readFileSync(
      resolve(__dirname, "../supabase/proofs/20261108170100-a-walk-plan-has-a-walker.sql"),
      "utf8",
    );
    expect(proof).toContain(
      "IF _got IS DISTINCT FROM _owner THEN\n    RAISE EXCEPTION 'PROOF FAILED [solo-line]",
    );
    expect(proof).not.toContain("a cleanup was given to the owner by the walk rule");
  });
});
