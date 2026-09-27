import { describe, expect, it } from "vitest";
import { migrationFiles, readMigration, stripLineComments } from "./support/sql-migrations";

// seed_demo_org chose "today" with current_date, the database session's
// date, which is UTC on Supabase and therefore TOMORROW from 7 pm Central on.
// An evening Reseed built the demo's working day on the next calendar date,
// and the app (which asks the organization what day it is) opened on an
// empty board. Found when the board E2E spec failed at 21:56 Central with the
// seeded visits one date ahead.
//
// The same function's TIMES were moved onto the org's clock a week earlier
// (20260919230000) and its DATE was not, which is why this pins the latest
// definition rather than one file: the next redefinition must keep both.

function latestSeedDemoOrg(): { file: string; body: string } {
  const files = migrationFiles().filter((f) =>
    /CREATE OR REPLACE FUNCTION public\.seed_demo_org\s*\(/i.test(readMigration(f)),
  );
  const file = files[files.length - 1];
  const sql = readMigration(file);
  const start = sql.search(/CREATE OR REPLACE FUNCTION public\.seed_demo_org\s*\(/i);
  const end = sql.indexOf("$fn$;", start);
  return { file, body: stripLineComments(sql.slice(start, end)) };
}

describe("the demo org's today is the org's today", () => {
  const { file, body } = latestSeedDemoOrg();

  it("never asks the database what day it is", () => {
    expect(body, `${file} reads current_date`).not.toMatch(/current_date/i);
  });

  it("derives today from the org's clock after the timezone is read", () => {
    const tz = body.search(/INTO\s+_tz/i);
    const today = body.search(/today\s*:=\s*\(now\(\)\s+AT TIME ZONE _tz\)::date/i);
    expect(tz, "the timezone is read").toBeGreaterThan(-1);
    expect(today, "today comes from the org's clock").toBeGreaterThan(tz);
  });

  it("keeps its visit times on the org's clock too (20260919230000's fix)", () => {
    // That fix covered the VISIT stamps (eta, started, completed); the
    // payment rows' date::timestamptz + 9h was out of its scope and still is.
    expect(body).toMatch(/\(today \+ time '07:30'[^;]*AT TIME ZONE _tz\)/);
    expect(body).not.toMatch(/\(today \+ time '[0-9:]+'[^;]*?\)::timestamptz/);
  });
});
