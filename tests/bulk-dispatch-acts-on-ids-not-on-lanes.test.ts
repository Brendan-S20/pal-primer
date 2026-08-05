// Dispatch could move exactly one visit at a time. The bulk path that replaces
// fourteen drags is also the path where a mistake costs fourteen visits, so the
// invariants below are the ones worth pinning.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

function sql(): string {
  const dir = join(ROOT, "supabase/migrations");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n")
    .replace(/^\s*--.*$/gm, ""); // prose quotes the code it removes
}

/** The LAST definition wins — these functions are defined more than once
 *  across migrations, and asserting against the first tests the version being
 *  replaced. Learned the hard way on `assign_demo_visits_to_staff`. */
function lastBody(name: string, all = sql()): string {
  // Anchored on CREATE, not on the bare name: `COMMENT ON FUNCTION public.<x>`
  // appears AFTER the definition, so lastIndexOf on the name alone returns the
  // comment and every assertion below then tests a docstring.
  const at = all.lastIndexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  expect(at, `${name} definition not found`).toBeGreaterThan(-1);
  const rest = all.slice(at);
  const end = rest.indexOf("$$;");
  return rest.slice(0, end === -1 ? undefined : end);
}

describe("a caller-supplied id list cannot span organizations", () => {
  // Different threat model from reassign_visit(one_id): a list can mix orgs,
  // and a per-row check that silently skipped the ones the caller cannot touch
  // would let someone enumerate ids by watching the count come back short.
  for (const fn of ["bulk_reassign_visits", "bulk_reschedule_visits"]) {
    it(`${fn} resolves the distinct org set and refuses more than one`, () => {
      const body = lastBody(fn);
      expect(body).toMatch(/array_agg\(DISTINCT organization_id\)/);
      expect(body).toMatch(/Visits span more than one organization/);
      expect(body).toMatch(/can_write_org\(auth\.uid\(\), _org\)/);
    });

    it(`${fn} does not use min() on a uuid`, () => {
      // Postgres has no min() for uuid. The first draft used one, both
      // functions raised on that line, and because the probe wrapped each call
      // in an exception handler the failure looked exactly like the guard
      // working. Two green assertions that had never reached the code.
      expect(lastBody(fn)).not.toMatch(/min\(organization_id\)/);
    });

    it(`${fn} never touches a completed or skipped visit`, () => {
      // A finished visit is a record of what happened; moving it rewrites
      // history and shifts revenue between techs after the fact.
      expect(lastBody(fn)).toMatch(/status NOT IN \('completed', 'skipped'\)/);
    });
  }

  it("bulk assignment still enforces routing eligibility", () => {
    // Bulk must not be a way around the rule the single path enforces.
    expect(lastBody("bulk_reassign_visits")).toMatch(/assert_runs_routes\(_staff_id\)/);
  });

  it("bulk assignment leaves unassigning open", () => {
    expect(lastBody("bulk_reassign_visits")).toMatch(/IF _staff_id IS NOT NULL THEN/);
  });
});

describe("one collision does not abandon the rest", () => {
  it("reschedule reports what it could not move", () => {
    const body = lastBody("bulk_reschedule_visits");
    // Two things can make one row unmovable, and both are "the schedule is
    // right", not "the call failed":
    //
    //   unique_violation — visits has UNIQUE(subscription_id, scheduled_on),
    //     so moving a weekly client's Tuesday onto next Tuesday collides with
    //     the visit already generated there.
    //   check_violation  — the assignee has that day booked off
    //     (assert_available_on, via the visits_respect_time_off trigger).
    //
    // Both must be caught per row. Catching only the first would let a day
    // off abort the other forty moves, which is the failure this whole
    // subtransaction loop exists to prevent.
    expect(body).toMatch(/EXCEPTION WHEN unique_violation OR check_violation THEN/);
    expect(body).toMatch(/_skipped := _skipped \+ 1/);
    expect(body).toMatch(/RETURNS TABLE\(moved integer, skipped integer\)/);
  });

  it("records where a visit came from only once", () => {
    // A visit bounced twice should still point at the day it was originally
    // promised for, not the last hop.
    expect(lastBody("bulk_reschedule_visits")).toMatch(
      /rescheduled_from = COALESCE\(rescheduled_from, scheduled_on\)/,
    );
  });
});

describe("taking a tech out", () => {
  it("refuses rather than unassigning when nobody is left", () => {
    // Work in nobody's lane is worse than a refusal: it vanishes from every
    // column into a pile no one owns, on a screen that had just promised to
    // redistribute it.
    const body = lastBody("redistribute_staff_work");
    expect(body).toMatch(/Nobody else is available/);
    expect(body).not.toMatch(/assigned_staff_id = NULL/);
  });

  it("only moves work to techs who are actually available", () => {
    const body = lastBody("redistribute_staff_work");
    expect(body).toMatch(/is_field_tech/);
    expect(body).toMatch(/routing_available/);
  });
});

describe("the flag follows the role for the life of the row", () => {
  it("recomputes on UPDATE, not only on INSERT", () => {
    // It was BEFORE INSERT only, so promoting an office manager to tech left
    // them not a field tech: absent from the board, refused by name when
    // assigned, while Users & roles showed their role as Technician.
    const all = sql();
    const at = all.lastIndexOf("CREATE TRIGGER staff_field_flag");
    expect(at).toBeGreaterThan(-1);
    const def = all.slice(at, at + 200);
    expect(def).toMatch(/BEFORE INSERT OR UPDATE OF role, is_field_tech_overridden/);
  });
});

describe("the board's selection", () => {
  const routes = readFileSync(join(ROOT, "src/routes/_authenticated/routes.tsx"), "utf8");
  const code = routes.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");

  it("sends explicit ids, never a lane's contents", () => {
    // Same reason persistColumn must not be handed a filtered lane: a lane is
    // a view, and "everything in this lane" means something different the
    // moment a filter is on.
    expect(code).toMatch(/visitIds:\s*\[\.\.\.selected\]/);
  });

  it("clears when the day or range changes", () => {
    // Otherwise the action bar offers to reassign visits that are no longer on
    // screen — and because the calls take ids, it would work.
    expect(code).toMatch(/setSelected\(new Set\(\)\);[\s\S]{0,80}\}, \[day, range\]\)/);
  });

  it("surfaces skipped reschedules instead of swallowing them", () => {
    expect(code).toMatch(/r\.skipped > 0/);
  });
});
