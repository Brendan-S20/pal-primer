// The preview showed every tech the whole day.
//
// 20260815170000 fixed Apply: `plan_day_across_staff` divides a day between the
// selected technicians. It did not fix Preview, which still looped the array it
// was given and asked `plan_route` — a SINGLE-VEHICLE solver whose candidate set
// is the whole organisation's day — once per technician:
//
//   FOREACH _s IN ARRAY _staff_ids LOOP
//     ... FROM public.plan_route(_org_id, _s, _d, _reassign, _level)
//
// so each technician was costed as though they personally drove every stop.
//
// Measured on the demo organisation, 2026-08-20, three field techs, reassign on,
// before this change:
//
//   preview   20 + 20 + 20 = 60 stops   (403.7 / 436.4 / 436.4 drive minutes)
//   the day    20 visits
//
// after:
//
//   preview    6 +  6 +  8 = 20 stops   (170.7 / 128.6 / 148.4)
//
// ── WHY THIS FILE IS SHAPED THE WAY IT IS ─────────────────────────────────
//
// A test that mocked the RPC and asserted "stops === 20" would have been green
// before the fix on any day with a single technician selected, and it would go
// green again the moment somebody rewrote the preview with its own private copy
// of the split. Neither is the property that matters. The two properties that
// matter are structural, and both are about a RELATIONSHIP between functions:
//
//   1. THE PREVIEW WRITES NOTHING. Not "the preview is careful" — the preview
//      must not be able to write, because the function that plans the day for
//      real is one identifier away from it and returns almost the same rows.
//
//   2. THE PREVIEW AND THE APPLY ARE THE SAME PLANNER. Not "they agree today".
//      Two copies of a sweep-and-rebalance heuristic agree on the day they are
//      written and drift silently thereafter, and the drift is invisible
//      because the only symptom is a number nobody can check without running
//      both. That is exactly how the bug above happened: the split was written
//      once, in the writer, and the reader kept its own older idea.
//
// So the assertions below are about which function calls which, and about which
// tables each is allowed to name. They are cheap, they run with no database,
// and they name a function rather than a screenshot.
//
// ── WHAT THEY CANNOT SHOW, AND WHAT WAS RUN INSTEAD ───────────────────────
//
// Text cannot prove that a plpgsql body did not write, and it cannot prove that
// two planners produce the same numbers. Both were measured against the live
// demo organisation, acting as a real org owner through request.jwt.claims so
// the authz path ran rather than being bypassed:
//
//   * 2026-08-20, reassign on: the twenty visits' assigned_staff_id, sequence,
//     travel_km/min, eta_start/end, window_violated and updated_at were
//     snapshotted before and after a preview. EXCEPT in both directions
//     returned zero rows and the fingerprint was unchanged
//     (986195c2e0ac7651ddb14ed82c578227). The day stayed on one technician.
//   * 2026-08-24 → 28 at 'thorough': every day's preview summed to that day's
//     real visit count — 25/20/21/19/18 — and again nothing was written.
//   * 2026-08-19: preview said 7 / 7 / 6 stops and 139.3 / 143.1 / 91.9 drive
//     minutes; Apply then produced 7 / 7 / 6 and 139.3 / 143.1 / 91.9. Zero
//     mismatches on any field, which is the one-planner property observed
//     rather than argued.
//   * level 'turbo' still raises "Unknown optimization level: turbo", from
//     inside the dryrun, through the preview.
//
// A green run here says the wiring is right. It does not say the planner is.
//
// ── UPDATE 2026-08-19: "PREVIEW" IS NO LONGER A BUTTON ────────────────────
//
// QA asked for one press instead of two, so the panel now has only Apply and
// the preview STEP is gone from the UI. Nothing below changed, because nothing
// below is about the UI: `preview_optimize` is still defined, still granted,
// and still called — by applyOptimize, immediately before it writes, which is
// where the arrival-window count the dispatcher gets warned about comes from.
// The property this file exists for is if anything load-bearing now: the
// measurement nobody presses a button for is still the read-only twin, and one
// identifier's difference in the wrong direction would have Apply plan the day
// twice for real. See tests/two-presses-to-route-a-day.test.ts for the caller.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(import.meta.dirname, "..", "supabase", "migrations");
const FILE = "20260815190000_the-preview-showed-every-tech-the-whole-day.sql";

/** Every function body in the migration history, last definition wins.
 *
 *  Keyed on the name alone rather than name+arity, which is a real limitation
 *  and a deliberate one here: `staff_start_point` genuinely has two live
 *  signatures, so it is read out of one named file below instead of through
 *  this map. Everything else this file asks about has exactly one. */
function bodies(): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    for (const m of sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\s*\(/g)) {
      // The body is whatever sits between `AS $tag$` and the next `$tag$`.
      // Both delimiters are in use across this repo ($$ and $function$), and
      // assuming one of them silently returns an empty string for the other —
      // which passes every `not.toMatch` in this file.
      const tag = /AS\s+(\$\w*\$)/.exec(sql.slice(m.index!, m.index! + 4000));
      if (!tag) continue;
      const start = sql.indexOf(tag[1], m.index! + tag.index!) + tag[1].length;
      const end = sql.indexOf(tag[1], start);
      if (end === -1) continue;
      out.set(m[1], sql.slice(start, end));
    }
  }
  return out;
}

/** Comments are not code. The prose inside these bodies quotes the very calls
 *  being banned — the dryrun explains itself by naming plan_route — so a rule
 *  that reads comments reports the documentation as the violation. */
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");

const BODY = bodies();
const body = (name: string) => {
  const b = BODY.get(name);
  expect(b, `no migration defines public.${name}`).toBeTruthy();
  expect(b!.length, `public.${name} was parsed as an empty body`).toBeGreaterThan(50);
  return codeOnly(b!);
};

const migration = readFileSync(join(MIGRATIONS, FILE), "utf8");

/** Every table an INSERT/UPDATE/DELETE in this body names. A temp table is
 *  bookkeeping; anything in `public` is a customer's data. */
function writeTargets(sql: string): string[] {
  return [...sql.matchAll(/(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([A-Za-z_][\w.]*)/gi)].map(
    (m) => m[1],
  );
}

describe("the preview writes nothing", () => {
  it("finds the functions at all", () => {
    // Every assertion below is of the form "this text is absent", and absence
    // is what a mis-parsed body looks like too. 2026-08-15's own sweep spent
    // several runs green against a page that had not rendered; this is the
    // same guard, one layer down.
    for (const fn of [
      "preview_optimize",
      "plan_day_across_staff",
      "plan_day_across_staff_dryrun",
      "routable_staff",
    ]) {
      expect(body(fn).length, `${fn} is suspiciously short`).toBeGreaterThan(100);
    }
  });

  it("the preview names no table it could write to", () => {
    const sql = body("preview_optimize");
    expect(writeTargets(sql), "preview_optimize must not write anywhere").toEqual([]);
  });

  it("the preview does not call the function that applies", () => {
    // The trap this closes: `plan_day_across_staff` and
    // `plan_day_across_staff_dryrun` differ by a suffix and return almost the
    // same information. Calling the first from the preview would look right,
    // read right, and reassign the customer's day on the way past — the
    // dispatcher would still be deciding whether to press Apply.
    const sql = body("preview_optimize");
    expect(sql).toMatch(/plan_day_across_staff_dryrun\(/);
    expect(sql, "the preview must not reach the writing planner").not.toMatch(
      /plan_day_across_staff\(/,
    );
  });

  it("the planner both of them share writes only to its own temp tables", () => {
    // This is the assertion that makes the preview possible at all. The dryrun
    // does everything Apply does — sweep, capacity shares, cluster match,
    // sequencing, eight passes of measured rebalancing — and the only tables it
    // may name in a write are the `_dry_*` scratch ones it created itself.
    const sql = body("plan_day_across_staff_dryrun");
    const offenders = writeTargets(sql).filter((t) => !t.startsWith("_dry_"));
    expect(offenders, "the dryrun wrote to something that is not its own temp table").toEqual([]);
    // And it must genuinely be doing the work, not delegating it to something
    // that writes. Two of the five steps, spot-checked.
    expect(sql, "the sweep is missing from the dryrun").toMatch(/atan2\(/);
    expect(sql, "the measured rebalance is missing from the dryrun").toMatch(/_new_spread/);
  });

  it("exactly one of the three touches public.visits", () => {
    // Stated as a set rather than as three separate assertions, because the
    // property is about the boundary between them: the moment a second one
    // acquires a write, "preview" and "apply" stop being different words.
    const writers = ["preview_optimize", "plan_day_across_staff", "plan_day_across_staff_dryrun"]
      .filter((fn) => /UPDATE\s+public\.visits/i.test(body(fn)));
    expect(writers).toEqual(["plan_day_across_staff"]);
  });
});

describe("the preview is multi-technician aware", () => {
  it("hands the whole team to one planner, once per day", () => {
    // The shape of the original bug, and the same shape applyOptimize had:
    // a loop over the technicians around a single-technician planner. One call
    // per day is correct; one call per technician per day cannot divide
    // anything, because each call sees the entire day as its own.
    const sql = body("preview_optimize");
    expect(sql, "the preview must not iterate the technicians").not.toMatch(
      /FOREACH\s+\w+\s+IN\s+ARRAY\s+_staff_ids/i,
    );
    expect(sql).toMatch(/plan_day_across_staff_dryrun\(_org_id,\s*_staff_ids,\s*_d,/);
  });

  it("never calls the single-vehicle solver directly", () => {
    // `plan_route` is not deleted and is not wrong — it is still exactly right
    // for one person's day, and optimize_route_v3 still uses it. What must not
    // come back is the PREVIEW reaching for it, because its candidate set is
    //
    //   AND (_reassign OR v.assigned_staff_id IS NULL
    //                  OR v.assigned_staff_id = _staff_id)
    //
    // which is the whole organisation's day, every time, for whoever asks.
    expect(body("preview_optimize")).not.toMatch(/public\.plan_route\(/);
  });

  it("decides who is routable in one place, and it is not the preview", () => {
    // The preview used to ask `IF NOT public.is_staff_off(_s, _d)` and nothing
    // else, so it offered routes for people Apply then refused — someone who
    // does not run routes, or is switched off. One function, three callers.
    const routable = body("routable_staff");
    for (const rule of ["is_staff_off", "is_field_tech", "routing_available", "active"]) {
      expect(routable, `routable_staff ignores ${rule}`).toMatch(new RegExp(rule));
    }
    expect(body("plan_day_across_staff_dryrun")).toMatch(/routable_staff\(/);
    expect(body("plan_day_across_staff")).toMatch(/routable_staff\(/);
  });

  it("still refuses a day nobody can be routed on, out loud, on the apply side", () => {
    // And silently on the preview side, which is the asymmetry that matters:
    // one Tuesday when everybody is off must not fail a thirty-one day
    // preview, but it must never let Apply proceed unremarked.
    expect(body("plan_day_across_staff")).toMatch(/check "Runs routes" and time off/);
    expect(body("plan_day_across_staff_dryrun")).not.toMatch(/check "Runs routes" and time off/);
  });
});

describe("one planner, two callers", () => {
  it("the writer no longer carries a copy of the algorithm", () => {
    // 20260815170000 put the sweep, the capacity shares, the nearest-start
    // match and the rebalance INSIDE the function that writes, which is what
    // made a read-only version impossible and this bug inevitable. If any of
    // it comes back here, there are two planners again.
    const apply = body("plan_day_across_staff");
    expect(apply).toMatch(/plan_day_across_staff_dryrun\(_org_id, _staff_ids, _day, _reassign, _level\)/);
    expect(apply, "the sweep is back inside the writer").not.toMatch(/atan2\(/);
    expect(apply, "the cluster match is back inside the writer").not.toMatch(/haversine_km/);
    expect(apply, "the rebalance is back inside the writer").not.toMatch(/_spread/);
  });

  it("the writer keeps the guards and the summary the UI is built on", () => {
    // applyOptimize turns each of these into something on screen. Losing them
    // in the rewrite would be silent: the planner would still plan.
    const apply = body("plan_day_across_staff");
    expect(apply).toMatch(/Select at least one technician to route/);
    expect(apply).toMatch(/Unknown optimization level: %/);
    expect(apply).toMatch(/can_write_org\(auth\.uid\(\), _org_id\)/);
    // The nothing-to-do branch: a day with nothing to plan reports each
    // technician's current load rather than erroring.
    expect(apply).toMatch(/route_cost_current\(_org_id, e\.s, _day\)/);
  });

  it("the solver is derived from plan_route rather than retyped", () => {
    // `plan_visits` is plan_route with its candidate set replaced by an
    // explicit list. Splicing pg_get_functiondef keeps it the SAME solver —
    // the time windows, the morning/afternoon penalties and the 2-opt pass are
    // not restated anywhere and so cannot fall out of step. A hand copy would
    // be a second solver, which is the failure this whole migration repairs.
    expect(migration).toMatch(
      /pg_get_functiondef\('public\.plan_route\(uuid,uuid,date,boolean,text\)'::regprocedure\)/,
    );
    // Each substitution asserts that it took. A splice that matched nothing
    // would produce a plausible function that plans the wrong visits, which is
    // far worse than a migration that refuses to apply.
    const raises = migration.match(/RAISE EXCEPTION 'plan_route does not/g) ?? [];
    expect(raises.length, "a splice is not asserted to have taken").toBe(3);
    expect(migration).toMatch(/AND v\.id = ANY\(_visit_ids\);/);
    expect(migration).toMatch(/the derived solver still mentions _reassign/);
  });

  it("the start point is asked about the PLANNED visits, not the written ones", () => {
    // Tiers 3 and 4 of the start-point chain (20260815180000) are measured
    // against "the work this person is doing", which Apply reads out of
    // visits.assigned_staff_id AFTER it has written it. A preview has written
    // nothing, and two of the three demo technicians have no start address, so
    // without this overload they resolve to 'none' — and plan_route coalesces
    // a NULL start to a flat 5.0 km for every candidate, which is a route from
    // nowhere and travel minutes that mean nothing.
    const four = /CREATE OR REPLACE FUNCTION public\.staff_start_point\([^)]*_visit_ids uuid\[\]/;
    expect(migration, "the four-argument start point is missing").toMatch(four);
    // Bounded to the end of THAT function. The first version of this ran to the
    // end of the file, and a mutation that dropped the restriction from the
    // periphery tier survived — the splice below rebuilds the same clause in a
    // string literal, so the count it was checking never fell. A scan that
    // reads past its subject measures the wrong text and passes.
    const from = migration.search(four);
    const overload = migration.slice(from, migration.indexOf("\n$$;", from));
    // The tiers, in the order 20260815180000 fixed them in: a personal address
    // beats the depot, which beats a dump site, which beats guessing.
    const order = ["'staff'", "'business'", "'disposal'", "'route'"].map((t) =>
      overload.indexOf(t),
    );
    expect(order.every((i) => i > -1), "a tier is missing from the overload").toBe(true);
    expect(order, "the fallback tiers are out of order").toEqual([...order].sort((a, b) => a - b));
    // Both visit-measured tiers restricted to the named set: the centroid and
    // the periphery. One without the other measures the edge of one round from
    // the middle of a different one.
    expect((overload.match(/v\.id = ANY\(_visit_ids\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // And the derived solver has to actually pass the list along.
    expect(migration).toMatch(/staff_start_point\(_org_id, _staff_id, _day, _visit_ids\) sp;/);
  });
});
