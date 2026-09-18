// A royalty rate set on the 5th could not reach the draft it was for.
//
// Owner decision, 2026-08-19: a draft takes the CURRENT rate.
//
// ── THE SHAPE OF IT ───────────────────────────────────────────────────────
//
// `generate_franchise_settlements` resolves each location's percentage as
//
//     coalesce((SELECT fri.royalty_percent FROM franchise_royalty_invoices fri
//                WHERE fri.child_organization_id = o.id
//                  AND fri.period_start = _start AND fri.period_end = _end),
//              o.franchise_royalty_percent, 0)
//
// with no condition on the existing statement's status. One CTE below it, the
// upsert carries `ON CONFLICT … DO UPDATE … WHERE status = 'draft'`. The two
// rules partition the same set and the freeze took the wrong half: a statement
// that has left draft is not rewritten at all, so its rate was never at risk,
// while a DRAFT — the one row the generator may move — was pinned to whatever
// percentage was configured the night it was first cut.
//
// Lived version: the nightly job writes last month's drafts on the 1st, the
// owner sets a location's rate on the 5th and presses "Generate last month's
// royalties", and gets rewritten drafts at the OLD percentage plus a toast
// reading "Generated 2 royalty invoices". Every figure moved except the one
// they had just changed.
//
// ── WHAT MUST NOT COME BACK ───────────────────────────────────────────────
//
// The complaint the freeze was written for is real and its protection is
// unchanged: an ISSUED statement is a bill, and nothing about it moves. That is
// the upsert guard, and it is asserted here as well as in
// settlement-statement-integrity, because this is the change most likely to be
// "simplified" by deleting the lookup outright.
//
// ── WHAT COULD NOT BE MEASURED ────────────────────────────────────────────
//
// Nothing was reproduced against real data. `franchise_royalty_invoices` and
// `franchise_adjustments` are both EMPTY in the live database and
// `franchise_royalty_percent` is 0.00 on the one franchise and both its
// locations, so there is no statement anywhere carrying a stale rate. This
// reads the routine; it does not observe a row.

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

/** The LAST migration to define a routine is the one in force — CREATE OR
 *  REPLACE means an earlier copy proves nothing. A DEFINITION, not a mention:
 *  a REVOKE names the function too, and matching that made a grant-only file
 *  "the latest definition" once already. */
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

const settlements = latestDefinitionOf("generate_franchise_settlements");

/** The rate lookup on its own, so nothing here can be satisfied by the word
 *  'draft' appearing elsewhere in a 5KB routine — it appears four times. */
const kids = settlements.body.slice(
  settlements.body.indexOf("WITH kids"),
  settlements.body.indexOf("rev AS"),
);

describe("the rate a draft settles at", () => {
  it("finds the routine and its rate lookup at all", () => {
    // Both halves. An assertion about a slice that came back empty is an
    // assertion about nothing, and every expectation below is of that form.
    expect(
      settlements.body.length,
      "generate_franchise_settlements is in no migration",
    ).toBeGreaterThan(0);
    expect(
      kids.length,
      "the kids CTE could not be isolated — this file is measuring nothing",
    ).toBeGreaterThan(0);
  });

  it("does not take the rate from a statement that is still a draft", () => {
    // The fix, and the whole of it.
    expect(
      kids,
      "the frozen rate is still read from a draft, so a rate change cannot reach the one statement the generator is allowed to rewrite",
    ).toMatch(/fri\.status\s*<>\s*'draft'/);
  });

  it("still freezes the rate on a statement that has been delivered", () => {
    // Deleting the sub-select entirely would also make the draft take the
    // current rate — and would restate every closed period the next time
    // anybody regenerated one, which is the fault 20260801080000 was written
    // for. The lookup stays; only its scope narrows.
    expect(kids).toMatch(/SELECT\s+fri\.royalty_percent/);
    expect(kids).toMatch(/fri\.period_start\s*=\s*_start/);
    expect(kids).toMatch(/fri\.period_end\s*=\s*_end/);
  });

  it("falls back to the location's configured rate for a period never settled", () => {
    expect(kids).toMatch(/o\.franchise_royalty_percent/);
  });

  it("keeps the protection that made the freeze reach only drafts", () => {
    // Load-bearing and pre-existing: without it, "drafts take the current rate"
    // would be "everything takes the current rate", and an issued bill would
    // change underneath the party it was sent to.
    expect(settlements.body).toMatch(/WHERE public\.franchise_royalty_invoices\.status = 'draft'/);
  });

  it("changes nothing else about the arithmetic", () => {
    // The deployed body was copied forward wholesale, which is the only safe
    // way to edit a routine whose migration history is behind the database.
    // These are the four figures a careless retype would lose.
    expect(settlements.body).toMatch(/p\.status IN \('succeeded', 'refunded'\)/);
    expect(settlements.body.match(/fa\.created_at\s*<\s*_to/g)?.length).toBe(2);
    expect(settlements.body).toMatch(/round\(\s*r\.total\s*\*\s*r\.pct\s*\/\s*100\.0\s*\)/);
    expect(settlements.body).toMatch(/revenue_collected_by_parent_cents/);
  });
});

describe("the migration that made the change can be replayed into an empty database", () => {
  const file = migrationFiles().find((f) =>
    f.includes("a-royalty-rate-set-on-the-fifth-could-not-reach-the-draft-it-was-for"),
  );
  const sql = file ? readFileSync(join(MIGRATIONS, file), "utf8") : "";

  it("exists", () => {
    expect(file, "the rate-freeze migration is missing").toBeTruthy();
  });

  it("reads prosrc by name rather than pg_get_functiondef over a schema", () => {
    // The working agreement's rule, and the seventh fault the Sandboxes replay
    // found: pg_get_functiondef raises on any pg_proc row that is not a plain
    // function, and what lives in `public` is not the same on every database.
    //
    // The CALL, not the mention: the header names the function it forbids, and
    // a whole-file scan reads that explanation as code.
    expect(sqlCode(sql)).not.toMatch(/pg_get_functiondef\s*\(/);
    expect(sql).toMatch(/p\.proname = 'generate_franchise_settlements'/);
  });

  it("raises only on what it establishes, and warns about what it measured", () => {
    // A count of draft statements is a fact about whatever database this runs
    // against. On a fresh build it is zero and there is nothing to say — which
    // must not look the same in the log as "the check found nothing wrong".
    const survey = sql.slice(sql.indexOf("WHAT WAS MEASURED"));
    expect(survey.length, "the migration records no survey at all").toBeGreaterThan(0);
    expect(survey).toMatch(/RAISE WARNING/);
    expect(survey, "a measured row count must not fail a replay").not.toMatch(/RAISE EXCEPTION/);
    expect(survey, "a check that could not run must say so").toMatch(/SKIPPED/);
  });

  it("does not assert on operations state a fresh build cannot create", () => {
    // No cron job, no tenant, no rows. The verification blocks ask only about
    // the routine the file itself just wrote.
    expect(sql).not.toMatch(/cron\.job/);
  });

  it("restates the grants it depends on rather than trusting CREATE OR REPLACE", () => {
    // Replacing an existing function keeps its ACL; a fresh CREATE in `public`
    // hands EXECUTE to PUBLIC, and anon is a member of PUBLIC. On a replay this
    // is the difference between a private billing routine and a public one.
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.generate_franchise_settlements\(uuid, date, date\) FROM PUBLIC, anon;/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.generate_franchise_settlements\(uuid, date, date\) TO authenticated, service_role;/,
    );
  });
});
