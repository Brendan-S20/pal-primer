// `staff.is_field_tech` decides who runs routes, and until now nothing enforced
// it: `assign_route_for_day` and `reassign_visit` checked authorization and org
// membership, then assigned to whoever was named. The only gate was a filter in
// the browser, and that filter had an escape hatch — holding one visit was
// enough to pass it for ever.
//
// These assert the two halves stay closed.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const ROUTES = readFileSync(join(ROOT, "src/routes/_authenticated/routes.tsx"), "utf8");

/** Migration text with `--` comments stripped.
 *
 *  The prose in these files quotes the very code it removes, so a naive search
 *  matches the explanation and passes while the defect is still live. */
function migrationsSql(): string {
  const dir = join(ROOT, "supabase/migrations");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n")
    .replace(/^\s*--.*$/gm, "");
}

/** routes.tsx with `//` comments and JSX `{/* … *\/}` blocks stripped, for the
 *  same reason. */
function routesCode(): string {
  return ROUTES.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("who may be given a route", () => {
  it("does not re-admit a non-tech just because they already hold a visit", () => {
    const code = routesCode();
    // The exact shape that was there: `is_field_tech || assignedIds.has(...)`.
    // Written as a gap-tolerant pattern so reformatting cannot smuggle it back.
    expect(code).not.toMatch(/is_field_tech\s*\|\|\s*assignedIds\.has/);
  });

  it("filters the assignable list on is_field_tech alone", () => {
    const code = routesCode();
    expect(code).toMatch(/\.filter\(\s*\(s:\s*any\)\s*=>\s*s\.is_field_tech\s*\)/);
  });

  it("still shows non-techs who hold work, so their visits are not hidden", () => {
    // Dropping them from the board would leave a day whose stops do not add up
    // and nothing to click — a worse failure than the one being fixed.
    const code = routesCode();
    expect(code).toMatch(/const stranded\s*=/);
    expect(code).toMatch(/!s\.is_field_tech\s*&&\s*assignedIds\.has\(s\.id\)/);
  });

  it("makes those lanes refuse drops rather than erroring on drop", () => {
    const code = routesCode();
    expect(code).toMatch(/useDroppable\(\{\s*id,\s*disabled:\s*notRoutable\s*\}\)/);
  });
});

describe("the server is the gate, not the browser", () => {
  const sql = migrationsSql();

  it("defines assert_runs_routes", () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.assert_runs_routes\(_staff_id uuid\)/);
  });

  it("calls it from both assignment paths", () => {
    // Two call sites: the whole-day assign and the single-visit reassign.
    const calls = sql.match(/PERFORM public\.assert_runs_routes\(_staff_id\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it("leaves unassigning open", () => {
    // Null is how work is taken OFF someone, and it is the only remedy for rows
    // that predate the check. Gating it would strand exactly the data this
    // exists to clean up.
    expect(sql).toMatch(
      /IF _staff_id IS NOT NULL THEN\s*PERFORM public\.assert_runs_routes\(_staff_id\);/,
    );
  });

  it("does not gate on routing_available", () => {
    // "Off routes today" is temporary — leave, sickness, training. You must
    // still be able to schedule that tech's work for tomorrow.
    expect(sql).not.toMatch(/assert_runs_routes[\s\S]{0,400}?routing_available/);
  });

  it("seeds demo visits only to field techs", () => {
    // The seeder round-robined across tech + dispatcher + office_manager and
    // put 95 of 149 demo visits onto people the same app reported as not field
    // techs — the contradiction that surfaced all of this.
    // lastIndexOf, not indexOf. Migrations concatenate in filename order and
    // this function is defined more than once, so the FIRST match is the
    // original — the very definition being replaced. Asserting against it
    // fails while the fix is present, which is how this test first ran.
    const seeder = sql.slice(sql.lastIndexOf("FUNCTION public.assign_demo_visits_to_staff"));
    const body = seeder.slice(0, seeder.indexOf("$function$;"));
    expect(body).toMatch(/AND is_field_tech/);
    expect(body).not.toMatch(/role IN \('tech','dispatcher','office_manager'\)/);
  });
});
