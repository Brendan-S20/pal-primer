// Every location's row was cut on the franchise's clock.
//
// Owner decision, 2026-08-19: each location's rollup row uses ITS OWN clock.
//
// ── THE HOUR ──────────────────────────────────────────────────────────────
//
// `franchise_rollup` resolved one timezone — the parent's — and used it for
// every row's "today" and "this month". Measured live: the parent is
// America/New_York and starts August at 2026-08-01 04:00Z; both locations are
// America/Chicago and start it at 05:00Z. A payment taken in that hour is in
// the parent's August and the location's July, so the location's own dashboard
// and its row on the franchise screen disagree — about the same money, in the
// same month, on two screens the same person reads. "Visits today" rolls over
// for a Chicago location at 11pm its own time, so a truck still working at
// 11:30 has its visits filed under tomorrow on one screen and today on the
// other.
//
// ── WHAT THIS SUPERSEDES ──────────────────────────────────────────────────
//
// 20260730140000's comment argues for one clock: "a parent in Chicago comparing
// visits today across locations would see a boundary that matches none of
// them". The fault it was fixing was the SERVER's clock, and that fix was
// right; the further claim — that one boundary makes the rows comparable — is
// the part being superseded. One clock does not make the numbers comparable, it
// makes them wrong for everyone but the parent.
//
// The parent's comparison is now across windows that differ by an hour. That is
// accepted, and true of any multi-timezone business.
//
// ── WHAT MUST NOT MOVE WITH IT ────────────────────────────────────────────
//
// `generate_franchise_settlements` keeps the PARENT's clock, deliberately: a
// settlement is one document covering every location and needs one pair of
// boundaries agreed between two parties. Different shape, different right
// answer. Asserted here so "make the timezone per-org" cannot be applied to
// both routines by someone tidying up.

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

function latestDefinitionOf(fn: string): { file: string; body: string } {
  const re = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${fn}\\s*\\(`, "i");
  let found = { file: "", body: "" };
  for (const f of migrationFiles()) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8");
    const m = re.exec(sql);
    if (!m) continue;
    const tail = sql.slice(m.index);
    const open = /\bAS\s+\$(\w*)\$/.exec(tail)!;
    const tag = `$${open[1]}$`;
    const close = tail.indexOf(tag, open.index + open[0].length);
    found = { file: f, body: tail.slice(0, close) };
  }
  return found;
}

const rollup = latestDefinitionOf("franchise_rollup");
const settlements = latestDefinitionOf("generate_franchise_settlements");

describe("a location's row is cut on the location's clock", () => {
  it("finds the routine at all", () => {
    expect(rollup.body.length, "franchise_rollup is in no migration").toBeGreaterThan(0);
  });

  it("resolves a timezone per row rather than once for the franchise", () => {
    expect(rollup.body).toMatch(/coalesce\(o\.timezone, 'America\/Chicago'\) AS tz/);
    expect(rollup.body).toMatch(/AT TIME ZONE c\.tz/);
  });

  it("has no franchise-wide boundary left to fall back on", () => {
    // Both present is the plausible half-fix: a per-row clock computed and the
    // columns still reading the parent's. The old variables are gone, so
    // nothing can quietly still be using them.
    expect(rollup.body, "the parent-wide month boundary is still declared").not.toMatch(
      /_month_start/,
    );
    // `_today` on its own would match the RETURN TABLE's `visits_today`
    // column, which is a name every caller reads and must not change. What
    // must be gone is the DECLARE and every use of it as a boundary.
    expect(rollup.body, "the parent-wide day boundary is still declared").not.toMatch(
      /^\s*_today\s+date;/m,
    );
    expect(rollup.body, "a column is still cut on the parent-wide day").not.toMatch(/=\s*_today\b/);
  });

  it("moves BOTH windows, not just the month", () => {
    // "Visits today" was the half that shows up first — an hour earlier every
    // evening, on the screen a franchise owner checks at the end of the day.
    expect(rollup.body).toMatch(/p\.created_at >= c\.month_start/);
    expect(rollup.body).toMatch(/ri\.detected_at >= c\.month_start/);
    expect(rollup.body.match(/v\.scheduled_on = c\.today/g)?.length).toBe(2);
  });

  it("keeps the parent's own row in the rollup", () => {
    // "So a rollup reads as the whole franchise rather than everyone but me."
    expect(rollup.body).toMatch(/o\.id = _parent_org OR o\.parent_organization_id = _parent_org/);
    expect(rollup.body).toMatch(/ORDER BY \(c\.id = _parent_org\) DESC/);
  });

  it("does not weaken the authorization or the plan gate on the way past", () => {
    expect(rollup.body).toMatch(
      /has_role\(auth\.uid\(\), _parent_org, 'owner'::public\.app_role\)/,
    );
    expect(rollup.body).toMatch(
      /has_role\(auth\.uid\(\), _parent_org, 'office_manager'::public\.app_role\)/,
    );
    expect(rollup.body).toMatch(/has_plan_entitlement\(_parent_org, 'franchise_structure'\)/);
  });

  it("returns the same ten columns its callers destructure", () => {
    // An earlier draft of the 2026-08-04 migration rewrote this function with
    // seven, which would have broken every caller.
    for (const col of [
      "organization_id uuid",
      "organization_name text",
      "active_clients integer",
      "visits_today integer",
      "visits_completed_today integer",
      "revenue_mtd_cents bigint",
      "revenue_mtd_gross_cents bigint",
      "refunds_mtd_cents bigint",
      "ar_open_cents bigint",
      "tech_count integer",
    ]) {
      expect(rollup.body, `franchise_rollup no longer returns ${col}`).toContain(col);
    }
  });

  it("still counts the money the rest of the product counts", () => {
    expect(rollup.body).toMatch(/p\.status IN \('succeeded', 'refunded'\)/);
    // Reversals come off REVENUE, not off what MOVED — the surcharge was never
    // revenue. Three copies of this expression exist and two have disagreed
    // once already.
    expect(rollup.body).toMatch(/COALESCE\(\(ri\.detail->>'revenue_cents'\)::bigint/);
  });
});

describe("the settlement period is deliberately not per-location", () => {
  it("still cuts the period on the parent's timezone", () => {
    expect(settlements.body).toMatch(
      /SELECT coalesce\(timezone, 'America\/Chicago'\) INTO _tz\s*\n\s*FROM public\.organizations WHERE id = _parent;/,
    );
    expect(settlements.body).toMatch(/_from := _start::timestamp AT TIME ZONE _tz;/);
  });

  it("does not resolve a timezone per child inside the settlement generator", () => {
    // A statement is one document with one pair of boundaries. Two locations
    // settling the same month on different clocks would make the franchise's
    // total not the sum of its statements.
    const kids = settlements.body.slice(
      settlements.body.indexOf("WITH kids"),
      settlements.body.indexOf("rev AS"),
    );
    expect(kids.length).toBeGreaterThan(0);
    expect(kids).not.toMatch(/AT TIME ZONE/);
  });
});

describe("the migration that made the change can be replayed into an empty database", () => {
  const file = migrationFiles().find((f) => f.includes("every-location-kept-the-parents-clock"));
  const sql = file ? readFileSync(join(MIGRATIONS, file), "utf8") : "";

  it("exists", () => {
    expect(file, "the per-location clock migration is missing").toBeTruthy();
  });

  it("supersedes the comment it contradicts, rather than silently disagreeing", () => {
    // The working agreement asks for this by name: the previous migration
    // argues for one clock, and a reader who finds two files disagreeing with
    // no explanation cannot tell which one is current.
    expect(sql).toMatch(/20260730140000/);
    expect(sql).toMatch(/SUPERSEDES/i);
  });

  it("reads prosrc by name rather than pg_get_functiondef over a schema", () => {
    // The CALL, not the mention: the header explains the rule and names the
    // function it forbids, which is exactly the sort of prose a whole-file
    // scan mistakes for code.
    expect(sqlCode(sql)).not.toMatch(/pg_get_functiondef\s*\(/);
    expect(sql).toMatch(/p\.proname = 'franchise_rollup'/);
  });

  it("raises only on what it establishes, and warns about what it measured", () => {
    const survey = sql.slice(sql.indexOf("WHAT WAS MEASURED"));
    expect(survey.length).toBeGreaterThan(0);
    expect(survey).toMatch(/RAISE WARNING/);
    expect(
      survey,
      "a clock comparison needs two orgs, which a fresh build has not got",
    ).not.toMatch(/RAISE EXCEPTION/);
    expect(survey).toMatch(/SKIPPED/);
  });

  it("does not assert on operations state a fresh build cannot create", () => {
    expect(sql).not.toMatch(/cron\.job/);
  });

  it("restates the grants it depends on rather than trusting CREATE OR REPLACE", () => {
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.franchise_rollup\(uuid\) FROM PUBLIC, anon;/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.franchise_rollup\(uuid\) TO authenticated, service_role;/,
    );
  });
});
