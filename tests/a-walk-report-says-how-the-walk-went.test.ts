// A walk report says how the walk went (#410, part 2): the migration, the
// server function, and the offline queue that carries the report ahead of the
// completion. tests/integration/walk-report.db.test.ts runs the function
// against a database built from the migrations.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { stripLineComments } from "./support/sql-migrations";

const read = (p: string) => readFileSync(p, "utf8");
const MIG = "supabase/migrations/20261015210000_a-walk-report-says-how-the-walk-went.sql";
const sql = stripLineComments(read(MIG));
const fnBody = sql.slice(
  sql.indexOf("CREATE OR REPLACE FUNCTION public.record_walk_report"),
  sql.indexOf("REVOKE ALL ON FUNCTION public.record_walk_report"),
);

describe("the migration", () => {
  it("adds the walker-access columns to properties, each with its rule", () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS access_method text/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS key_held boolean NOT NULL DEFAULT false/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS key_tag text/);
    expect(sql).toMatch(
      /access_method IN \('key', 'lockbox', 'code', 'garage', 'person_home'\)/,
    );
    expect(sql).toMatch(/char_length\(key_tag\) <= 40/);
    for (const c of ["access_method", "key_held", "key_tag"])
      expect(sql).toMatch(new RegExp(`COMMENT ON COLUMN public\\.properties\\.${c} IS`));
  });

  it("adds pee, poo and the note for the client to visits", () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS pee boolean,/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS poo boolean,/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS report_note text;/);
    expect(sql).toMatch(/char_length\(report_note\) <= 500/);
    for (const c of ["pee", "poo", "report_note"])
      expect(sql).toMatch(new RegExp(`COMMENT ON COLUMN public\\.visits\\.${c} IS`));
    // Unset until the walker says: no default, nullable.
    expect(sql).not.toMatch(/pee boolean NOT NULL|poo boolean NOT NULL/);
  });

  it("drops each constraint before adding it, so a replay is idempotent", () => {
    for (const name of [
      "properties_access_method_check",
      "properties_key_tag_length",
      "visits_report_note_length",
    ]) {
      expect(sql.indexOf(`DROP CONSTRAINT IF EXISTS ${name}`)).toBeGreaterThan(-1);
      expect(sql.indexOf(`DROP CONSTRAINT IF EXISTS ${name}`)).toBeLessThan(
        sql.indexOf(`ADD CONSTRAINT ${name}`),
      );
    }
  });

  it("records the report through a definer function with a pinned search_path", () => {
    expect(fnBody).toMatch(
      /record_walk_report\(\s*_visit_id uuid,\s*_pee boolean,\s*_poo boolean,\s*_report_note text\s*\)/,
    );
    expect(fnBody).toMatch(/RETURNS void/);
    expect(fnBody).toMatch(/SECURITY DEFINER/);
    expect(fnBody).toMatch(/SET search_path TO 'public', 'pg_temp'/);
  });

  it("lets the assigned walker or the office write it, and nobody else", () => {
    expect(fnBody).toMatch(
      /public\.is_visit_tech\(auth\.uid\(\), _visit_id\)\s+OR public\.can_write_org\(auth\.uid\(\), _org\)/,
    );
    expect(fnBody).toMatch(/RAISE EXCEPTION 'Not authorized for this visit'/);
  });

  it("refuses a visit that was not walked", () => {
    expect(fnBody).toMatch(/_status NOT IN \('scheduled', 'in_progress', 'completed'\)/);
  });

  it("trims the note, stores empty as null, and refuses over 500", () => {
    expect(fnBody).toMatch(/NULLIF\(btrim\(COALESCE\(_report_note, ''\)\), ''\)/);
    expect(fnBody).toMatch(/char_length\(_note\) > 500/);
  });

  it("is executable by signed-in users and the service role, never anon", () => {
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.record_walk_report\(uuid, boolean, boolean, text\) FROM PUBLIC, anon;/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.record_walk_report\(uuid, boolean, boolean, text\)\s+TO authenticated, service_role;/,
    );
  });

  it("does not redefine complete_visit or start_visit", () => {
    expect(sql).not.toMatch(/FUNCTION public\.(complete_visit|start_visit)\b/);
  });

  it("ends by asserting what it establishes", () => {
    const check = sql.slice(sql.lastIndexOf("DO $check$"));
    expect(check).toMatch(/information_schema\.columns/);
    expect(check).toMatch(/pg_constraint/);
    expect(check).toMatch(/to_regprocedure\('public\.record_walk_report\(uuid, boolean, boolean, text\)'\)/);
    expect(check).toMatch(/has_function_privilege\('anon', 'public\.record_walk_report/);
    expect(check).toMatch(/RAISE EXCEPTION/);
    // Nothing measured from a live database: no row counts.
    expect(check).not.toMatch(/count\(\*\)/i);
  });
});

describe("the generated types", () => {
  const types = read("src/integrations/supabase/types.ts");
  it("know the new columns and the function", () => {
    expect(types).toMatch(/access_method: string \| null/);
    expect(types).toMatch(/key_held: boolean\n/);
    expect(types).toMatch(/key_tag: string \| null/);
    expect(types).toMatch(/pee: boolean \| null/);
    expect(types).toMatch(/poo: boolean \| null/);
    expect(types).toMatch(/report_note: string \| null/);
    expect(types).toMatch(/record_walk_report: \{/);
  });
});

describe("the server function", () => {
  const fn = read("src/lib/walk-report.functions.ts");
  it("calls the RPC with the cleaned note", () => {
    expect(fn).toMatch(/\.rpc\("record_walk_report", \{/);
    expect(fn).toMatch(/_report_note: cleanReportNote\(data\.reportNote\)/);
    expect(fn).toMatch(/requireSupabaseAuth/);
  });
});

describe("the report goes before the completion, live or queued", () => {
  const page = read("src/routes/_authenticated/my-day.tsx");
  const hook = read("src/lib/offline/useOfflineVisitActions.ts");
  const sync = read("src/lib/offline/sync.ts");
  const queue = read("src/lib/offline/queue.ts");
  const callers = read("src/hooks/useSyncCallers.ts");

  it("sends the report first, and queues the completion behind a queued one", () => {
    const complete = page.slice(page.indexOf("const complete = useMutation"));
    const send = complete.indexOf("await walkReport.send()");
    expect(send).toBeGreaterThan(-1);
    expect(send).toBeLessThan(complete.indexOf("actions.complete({"));
    expect(complete).toMatch(/queueOnly: reportQueued/);
    expect(hook).toMatch(/online: !queueOnly && isNavigatorOnline\(\)/);
    // queueOnly decides the path and is not sent to the server or stored.
    expect(hook).toMatch(/\(\{ queueOnly, \.\.\.extra \}/);
  });

  it("has a queue kind, a replay, and a caller for it", () => {
    expect(queue).toMatch(/kind: "walk_report";/);
    expect(sync).toMatch(/case "walk_report":[\s\S]{0,400}callers\.recordWalkReport\(/);
    expect(callers).toMatch(/recordWalkReport: walkReportFn/);
  });

  it("only for a walk, or a pet sitting visit's note for the client (#411)", () => {
    expect(page).toMatch(/const walk = isWalkVisit\(visit\)/);
    expect(page).toMatch(
      /const reportQueued = \(walk \|\| sit\) && \(await walkReport\.send\(\)\)\.queued/,
    );
  });
});

describe("a pet-waste card keeps its words", () => {
  const page = read("src/routes/_authenticated/my-day.tsx");
  it("still says Start and Complete when the stop is not a walk", () => {
    // A pet sitting stop (#411) has its own words between the two.
    expect(page).toMatch(
      /walk\s*\?\s*t\("walk\.start"\)\s*:\s*sit\s*\?\s*sitStepLabel\(t, visit\.sit_facts, "start"\)\s*:\s*t\("myDay\.start"\)/,
    );
    expect(page).toMatch(
      /walk\s*\?\s*t\("walk\.end"\)\s*:\s*sit\s*\?\s*sitStepLabel\(t, visit\.sit_facts, "end"\)\s*:\s*t\("myDay\.complete"\)/,
    );
    // The second timer is the old one, untouched, for every other stop.
    expect(page).toMatch(/inProg && visit\.started_at && !walk && \(/);
    expect(page).toMatch(/<ElapsedTimer startedAt=\{visit\.started_at\} \/>/);
  });

  it("draws the walk parts only for a walk", () => {
    for (const part of ["WalkMeta", "WalkAccess", "WalkTimer", "WalkReportFields"]) {
      const at = page.indexOf(`<${part} `);
      expect(at, part).toBeGreaterThan(-1);
      // How the walker gets in is also how a sitter gets in (#411).
      expect(page.slice(Math.max(0, at - 80), at), part).toMatch(/walk( \|\| sit\))? &&/);
    }
  });

  it("the walk timer ticks once a minute and reads no location", () => {
    const parts = read("src/components/my-day/WalkParts.tsx");
    expect(parts).toMatch(/setInterval\(\(\) => setNow\(Date\.now\(\)\), 60_000\)/);
    expect(parts).not.toMatch(/geolocation|watchPosition|getCurrentPosition/);
  });
});
