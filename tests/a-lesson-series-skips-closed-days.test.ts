import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { seriesVisitHolds, seriesVisitsToDrop, sessionLimitProblem } from "@/lib/subscription-form";
import { seriesRulesPatch } from "@/lib/subscription-form";

// R2-49 (train-r2-08): an open-ended weekly lesson series put a lesson on
// Fri Dec 25 and had no count. The DB half, with the generator, is
// tests/integration/a-lesson-series-skips-closed-days.db.test.ts; this file
// pins the migration's shape and the edit's clean-up.

const MIGRATION =
  "supabase/migrations/20261102172500_a-lesson-series-skips-closed-days-and-can-stop.sql";
const sql = readFileSync(MIGRATION, "utf8").replace(/--.*$/gm, "");

describe("the rule every series visit meets", () => {
  const fn = sql.slice(sql.indexOf("FUNCTION public.visits_follow_series_rules()"));

  it("skips blackout and holiday dates when the series says so, or by the business default for training", () => {
    expect(fn).toMatch(
      /COALESCE\(\s*s\.skip_closed_days,\s*CASE WHEN svc\.service_line = 'training' THEN o\.training_series_skip_closed ELSE false END/,
    );
    expect(fn).toMatch(/FROM public\.blackout_dates b/);
    expect(fn).toMatch(/FROM public\.holiday_dates h/);
    expect(fn).toMatch(/RETURN NULL;/);
  });

  it("never touches a one-time plan, a package's or a stay's, or a visit that is not scheduled", () => {
    expect(fn).toMatch(/s\.frequency <> 'one_time'/);
    expect(fn).toMatch(/s\.client_package_id IS NULL/);
    expect(fn).toMatch(/s\.stay_id IS NULL/);
    expect(fn).toMatch(/NEW\.status IS DISTINCT FROM 'scheduled'/);
  });

  it("counts held lessons the way a package does", () => {
    expect(fn).toMatch(
      /v\.status IN \('scheduled', 'in_progress', 'completed', 'missed'\)\s+OR \(v\.status = 'skipped' AND v\.skip_billable\)/,
    );
  });

  it("is a trigger before insert, revoked from the API roles, and defaults are as decided", () => {
    expect(sql).toMatch(
      /CREATE TRIGGER aa_visits_follow_series_rules BEFORE INSERT ON public\.visits/,
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.visits_follow_series_rules\(\) FROM PUBLIC, anon, authenticated;/,
    );
    expect(sql).toMatch(/training_series_skip_closed boolean NOT NULL DEFAULT true/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS skip_closed_days boolean,/);
    expect(sql).toMatch(/CHECK \(session_limit IS NULL OR session_limit BETWEEN 1 AND 520\)/);
  });
});

describe("editing a series", () => {
  const v = (id: string, scheduled_on: string, status = "scheduled", skip_billable = false) => ({
    id,
    scheduled_on,
    status,
    skip_billable,
  });
  const today = "2026-12-01";

  it("drops the upcoming Dec 25 lesson when the series skips closed days", () => {
    const visits = [v("a", "2026-12-18"), v("b", "2026-12-25"), v("c", "2027-01-01")];
    expect(
      seriesVisitsToDrop(visits, {
        skipClosed: true,
        sessionLimit: null,
        closedDays: new Set(["2026-12-25"]),
        today,
      }),
    ).toEqual(["b"]);
    expect(
      seriesVisitsToDrop(visits, {
        skipClosed: false,
        sessionLimit: null,
        closedDays: new Set(["2026-12-25"]),
        today,
      }),
    ).toEqual([]);
  });

  it("drops the latest upcoming lessons past the count, and never a past or taught one", () => {
    const visits = [
      v("done1", "2026-11-20", "completed"),
      v("free", "2026-11-27", "skipped", false),
      v("billed", "2026-11-28", "skipped", true),
      v("n1", "2026-12-04"),
      v("n2", "2026-12-11"),
      v("n3", "2026-12-18"),
    ];
    expect(
      seriesVisitsToDrop(visits, {
        skipClosed: false,
        sessionLimit: 3,
        closedDays: new Set(),
        today,
      }),
    ).toEqual(["n3", "n2"]);
    // A limit below what is already taught removes only what is still to come.
    expect(
      seriesVisitsToDrop(visits, {
        skipClosed: false,
        sessionLimit: 1,
        closedDays: new Set(),
        today,
      }),
    ).toEqual(["n3", "n2", "n1"]);
  });

  it("holds a session like a package lesson", () => {
    expect(seriesVisitHolds({ status: "missed" })).toBe(true);
    expect(seriesVisitHolds({ status: "skipped", skip_billable: false })).toBe(false);
    expect(seriesVisitHolds({ status: "canceled" })).toBe(false);
  });

  it("an empty count is open-ended; anything else is a whole number of lessons", () => {
    expect(sessionLimitProblem("")).toBeNull();
    expect(sessionLimitProblem("8")).toBeNull();
    expect(sessionLimitProblem("0")).not.toBeNull();
    expect(sessionLimitProblem("2.5")).not.toBeNull();
    expect(sessionLimitProblem("600")).not.toBeNull();
  });

  it("writes only what the form sent", () => {
    expect(seriesRulesPatch({})).toEqual({});
    expect(seriesRulesPatch({ skipClosedDays: true, sessionLimit: null })).toEqual({
      skip_closed_days: true,
      session_limit: null,
    });
  });
});

describe("where the settings are", () => {
  it("the series drawer offers both, for a training plan that is not a package's", () => {
    const code = readFileSync("src/components/client-detail/ServicesTab.tsx", "utf8");
    expect(code).toMatch(
      /chosenService\?\.service_line === "training" &&\s+form\.choice !== "one_time" &&\s+!subscription\?\.client_package_id/,
    );
    expect(code).toMatch(/Skip holidays and closed days/);
    expect(code).toMatch(/id="lesson-series-limit"/);
  });
  it("the business default sits with the other training rules", () => {
    const card = readFileSync("src/components/settings/TrainingSessionRulesCard.tsx", "utf8");
    expect(card).toMatch(/seriesSkipClosed: skipClosed/);
    const fns = readFileSync("src/lib/training-packages.functions.ts", "utf8");
    expect(fns).toMatch(/db\.rpc\("set_training_series_skip_closed"/);
  });
});
