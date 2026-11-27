// Rigel's review of #1069 at 23d432bc: a plan read off Housecall Pro's Jobs
// export carries a warning about its schedule, the visits left out and the
// notes on its visits. They were leftover columns, summarised with the
// file's sixty others under a 600-character cap, so the saved client note
// cut them off. Now each is kept in full on the note, ahead of the leftover
// columns. This runs the real customers and jobs exports (with every column
// Housecall Pro writes) through preview and commit, and reads the saved note.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Papa from "papaparse";

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const chain = {
      middleware: () => chain,
      inputValidator: () => chain,
      handler: (handler: unknown) => handler,
    };
    return chain;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/lib/authz.server", () => ({
  requirePermission: vi.fn(async () => ({ orgId: "org" })),
  resolveCaller: vi.fn(async () => ({ orgId: "org", role: "owner" })),
}));
vi.mock("@/lib/geocode.server", () => ({
  geocodeAddresses: vi.fn(async (list: unknown[]) => list.map(() => null)),
  geocodeAddress: vi.fn(async () => null),
}));
vi.mock("@/lib/visit-generation.server", () => ({ generateVisitHorizon: vi.fn(async () => {}) }));

import {
  autoMap,
  commitImport,
  detectImportEntity,
  detectImportSource,
  previewImport,
  type ImportEntity,
} from "@/lib/imports.functions";
import { tableFromCsv } from "@/lib/import-file-table";
import { leftoverColumns } from "@/lib/import-leftovers";
import {
  planVisitFile,
  VISITS_COLUMNS,
  VISITS_LEFT_OUT_COLUMN,
  VISITS_NOTES_COLUMN,
  VISITS_SCHEDULE_NOTE_COLUMN,
  visitFileColumns,
} from "@/lib/import-visit-plans";
import { emptyTables, fakeSupabase, type Tables } from "./support/fake-supabase-for-imports";

const FIXTURES = join(import.meta.dirname, "fixtures", "imports");
const TODAY = "2026-11-27";
const TZ = "America/Detroit";

function read(name: string) {
  const text = readFileSync(join(FIXTURES, name), "utf8");
  return tableFromCsv(Papa.parse<string[]>(text, { skipEmptyLines: true }).data);
}

let tables: Tables;
const call = (fn: unknown, data: unknown) =>
  (fn as (i: unknown) => Promise<any>)({
    data,
    context: { userId: "owner", supabase: fakeSupabase(tables) },
  });

async function importRows(source: string, entity: ImportEntity, headers: string[], rows: any[]) {
  const mapping = autoMap(source, headers, entity);
  const { batchId, stats } = await call(previewImport, { source, entity, mapping, rows });
  return { mapping, stats, result: await call(commitImport, { batchId }) };
}

beforeEach(() => {
  tables = emptyTables();
});

describe("Housecall Pro jobs: the plan's note keeps the visits' warnings", () => {
  it("saves the schedule warning, the visits left out and the visit notes in full", async () => {
    const customers = read("housecall-pro-customers.csv");
    expect(detectImportSource(customers.headers)).toBe("housecall_pro");
    await importRows(
      "housecall_pro",
      detectImportEntity(customers.headers) as ImportEntity,
      customers.headers,
      customers.rows,
    );

    const jobs = read("housecall-pro-jobs.csv");
    const sam = (r: Record<string, string>) => r["Street"] === "123 Test St";
    // Nothing is booked for Sam while Jordan's visits run on to next
    // November: Sam's plan may have ended. Two more completed visits before
    // the real one, one canceled, one with no date, and a note.
    const first = jobs.rows.find((r: any) => sam(r) && r["Job status"] === "Completed") as Record<
      string,
      string
    >;
    const done = (on: string) => ({ ...first, "Job scheduled start date": `${on}T09:00:00-05:00` });
    const rows = [
      ...jobs.rows.filter((r: any) => !sam(r)),
      done("2026-10-30"),
      done("2026-11-06"),
      { ...first, Notes: "Gate code changed to 4411; the side gate sticks, lift it." },
      {
        ...first,
        "Job status": "Canceled",
        "Job scheduled start date": "2026-11-20T09:00:00-05:00",
      },
      { ...first, "Job status": "Scheduled", "Job scheduled start date": "" },
    ];

    const cols = visitFileColumns("housecall_pro", jobs.headers)!;
    const planned = planVisitFile(rows, cols, TODAY, TZ);
    const plan = planned.rows.find((r) => r["Street"] === "123 Test St")!;
    const schedule = plan[VISITS_SCHEDULE_NOTE_COLUMN];
    const leftOut = plan[VISITS_LEFT_OUT_COLUMN];
    const visitNotes = plan[VISITS_NOTES_COLUMN];
    expect(schedule).toContain("so this plan may have ended");
    expect(leftOut).toContain("2026-11-20 (Canceled)");
    expect(leftOut).toContain("no date (Scheduled)");
    expect(visitNotes).toContain("Gate code changed to 4411; the side gate sticks, lift it.");

    const headers = [...jobs.headers, ...VISITS_COLUMNS];
    const { mapping, result } = await importRows("housecall_pro", "services", headers, [plan]);
    expect(result.created).toBe(1);
    // The three are read for the note, not left over with the rest.
    const left = leftoverColumns("services", mapping, headers);
    expect(left).not.toContain(VISITS_SCHEDULE_NOTE_COLUMN);
    expect(left).not.toContain(VISITS_LEFT_OUT_COLUMN);
    expect(left).not.toContain(VISITS_NOTES_COLUMN);
    // Enough other columns are left over to fill the summary's cap.
    expect(left.length).toBeGreaterThan(20);

    const notes = (tables.client_notes as any[]).map((n) => n.body as string);
    const note = notes.find((b) => b.includes("may have ended"));
    expect(note, notes.join("\n---\n")).toBeTruthy();
    expect(note).toContain(schedule);
    expect(note).toContain(leftOut);
    expect(note).toContain(visitNotes);
    // And ahead of the leftover columns, which are the part that is cut.
    expect(note!.indexOf(visitNotes)).toBeLessThan(note!.indexOf("Job #"));
  });
});
