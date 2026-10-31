// Auto-routing can be taken back (#435, QA row 17).
//
// Apply rewrites every selected technician's days with no preview (the
// owner's call, 2026-08-19, and it stands) and, until this, no way back.
// 20261015140000 keeps what each run replaced; the panel offers "Moved 14
// visits across 3 techs. Undo" once the run has saved.
//
// Three halves: the words, which are pure; the wiring, read from the source
// so a refactor that drops a call fails here by name; and the database rules,
// proved by tests/sql/auto-routing-can-be-taken-back.proof.sql against a real
// Postgres inside a transaction that is rolled back. When no database is
// reachable the last half says so loudly and skips.

import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { undoSummaryLine, undoToastMs, undoUnavailableLine } from "@/lib/routing-undo";

vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
const MIGRATION = join(
  ROOT,
  "supabase/migrations/20261015140000_auto-routing-can-be-taken-back.sql",
);
const PROOF = join(ROOT, "tests/sql/auto-routing-can-be-taken-back.proof.sql");
const DB_URL =
  process.env.ROUTING_UNDO_PROOF_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

describe("the words", () => {
  it("says what moved and across how many techs", () => {
    expect(undoSummaryLine(14, 3)).toBe("Moved 14 visits across 3 techs.");
    expect(undoSummaryLine(1, 1)).toBe("Moved 1 visit across 1 tech.");
    expect(undoSummaryLine(2, 0)).toBe("Moved 2 visits.");
  });

  it("names why Undo is gone", () => {
    expect(undoUnavailableLine("expired")).toMatch(/15 minutes/);
    expect(undoUnavailableLine("changed_since")).toMatch(/changed since/);
    expect(undoUnavailableLine(null)).toMatch(/nothing to undo/);
  });

  it("keeps the toast up for a minute, or until the window closes, never under ten seconds", () => {
    const now = Date.parse("2026-10-15T12:00:00Z");
    expect(undoToastMs("2026-10-15T12:15:00Z", now)).toBe(60_000);
    expect(undoToastMs("2026-10-15T12:00:30Z", now)).toBe(30_000);
    expect(undoToastMs("2026-10-15T11:59:00Z", now)).toBe(10_000);
    expect(undoToastMs(null, now)).toBe(60_000);
  });
});

describe("the wiring", () => {
  it("snapshots before the write and seals after it", () => {
    const src = read("src/lib/auto-routing.server.ts");
    const capture = src.indexOf('"capture_routing_run_undo"');
    const write = src.indexOf("await applyRoutePlans(");
    const seal = src.indexOf('"seal_routing_run_undo"');
    expect(capture).toBeGreaterThan(-1);
    expect(seal).toBeGreaterThan(-1);
    expect(capture).toBeLessThan(write);
    expect(seal).toBeGreaterThan(write);
  });

  it("offers Undo after a run is announced, live or on review, and Apply writes the preview", () => {
    const src = read("src/components/routes/AutoRoutingPanel.tsx");
    expect(src.match(/void offerUndo\(/g)?.length).toBe(2);
    expect(src).toMatch(/label: "Undo"/);
    // CHANGED 2026-10-31 (#609, D10): Preview comes first and Apply sends
    // that preview. Undo stays as the way back from a run that was shown.
    expect(src).toMatch(/preview \? applyMut\.mutate\(\) : previewMut\.mutate\(\)/);
    const at = src.indexOf("const applyMut = useMutation");
    const apply = src.slice(at, src.indexOf("onSuccess: (out)", at));
    expect(apply).toMatch(/if \(!preview\) throw/);
    expect(apply).toMatch(
      /startFn\(\{\s*data: \{ runId, staffIds: chosen, from, to, level: LEVEL, windows, preview \},?\s*\}\)/,
    );
  });

  it("tells the technicians when their day is put back", () => {
    const src = read("src/lib/routing-runs.functions.ts");
    const undo = src.slice(src.indexOf("export const undoRoutingRun"));
    expect(undo).toMatch(/startRouteWatch\(/);
    expect(undo).toMatch(/await watch\.finish\(\)/);
  });

  it("the date row cannot run out of the side of the card", () => {
    const src = read("src/components/routes/AutoRoutingPanel.tsx");
    // The dates EDITOR, not the pill above it that also mentions the section.
    const start = src.indexOf('{section === "dates" && (');
    const end = src.indexOf('{section === "windows" && (');
    expect(start, "the dates editor block").toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const dates = src.slice(start, end);
    expect(dates.match(/<Input\b[\s\S]*?\/>/g)).toHaveLength(2);
    expect(dates).toMatch(/aria-label="First day"/);
    expect(dates).toMatch(/aria-label="Last day"/);
    expect(dates).toMatch(/grid-cols-\[auto_minmax\(0,1fr\)\]/);
    expect(dates.match(/min-w-0/g)?.length).toBeGreaterThanOrEqual(2);
    expect(dates.match(/touch:min-h-11/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("the board leaves room under the card", () => {
    expect(read("src/routes/_authenticated/routes.tsx")).toMatch(
      /h-\[var\(--auto-routing-h,0px\)\]/,
    );
    expect(read("src/components/routes/AutoRoutingPanel.tsx")).toMatch(/--auto-routing-h/);
  });
});

describe("the migration", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  it("puts the table behind two-step sign-in and its functions", () => {
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/SELECT public\.require_mfa_policy\('public\.routing_run_undo'\);/);
    expect(sql).toMatch(/REVOKE ALL ON public\.routing_run_undo FROM PUBLIC, anon, authenticated;/);
    expect(sql).not.toMatch(/CREATE POLICY/);
  });
  it("asks the same gate as every routing write", () => {
    for (const f of [
      "capture_routing_run_undo",
      "seal_routing_run_undo",
      "routing_run_undo_state",
    ]) {
      const at = sql.indexOf(`FUNCTION public.${f}(`);
      const body = sql.slice(at, sql.indexOf("$function$;", at));
      expect(body, f).toMatch(/can_write_org\(auth\.uid\(\), _run\.organization_id\)/);
    }
  });
});

function findPsql(): string | null {
  for (const p of [
    "psql",
    "/opt/homebrew/opt/libpq/bin/psql",
    "/opt/homebrew/opt/postgresql@18/bin/psql",
    "/opt/homebrew/opt/postgresql@17/bin/psql",
    "/usr/local/opt/libpq/bin/psql",
  ]) {
    const r = spawnSync(p, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return p;
  }
  return null;
}

const psql = findPsql();
const reachable =
  !!psql &&
  spawnSync(psql, [DB_URL, "-XAtc", "select 1"], {
    encoding: "utf8",
    timeout: 30_000,
  }).stdout?.trim() === "1";

if (!reachable) {
  console.warn(
    `\n  SKIPPED: the routing-undo proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set ROUTING_UNDO_PROOF_DB_URL to run them.\n",
  );
}

function runProof(args: string[]) {
  let r = spawnSync(psql!, args, { encoding: "utf8", timeout: 300_000 });
  for (let i = 0; i < 2 && /deadlock detected/.test(`${r.stdout}${r.stderr}`); i++) {
    r = spawnSync(psql!, args, { encoding: "utf8", timeout: 300_000 });
  }
  return r;
}

describe.skipIf(!reachable)("auto-routing can be taken back, in a real database", () => {
  it("has the files it runs", () => {
    for (const f of [MIGRATION, PROOF]) expect(existsSync(f), f).toBe(true);
  });

  it("proves every rule, and leaves nothing behind", () => {
    const r = runProof([DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-f", PROOF]);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(4);
    expect(out).toMatch(/ALL ROUTING-UNDO PROOFS PASSED/);

    const left = spawnSync(
      psql!,
      [DB_URL, "-XAtc", "select count(*) from public.organizations where name like 'Undo Proof %'"],
      { encoding: "utf8" },
    );
    expect(left.stdout.trim()).toBe("0");
  });
});
