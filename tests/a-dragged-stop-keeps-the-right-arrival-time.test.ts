// A dragged stop keeps the right arrival time (#430, QA row 15), and a visit
// moved to another day keeps its technician when it can (QA row 16).
//
// Dragging a card on the Schedule board called reassign_visit and
// reorder_route, and neither touched eta_start. The customer's "on my way"
// text reads eta_start, so a stop dragged from tenth to first still promised
// the afternoon. 20261015130000 recomputes every lane a drag changes;
// 20261015131000 stops reschedule_visit dropping the technician on every
// move.
//
// Two halves. The first reads the migrations, so it runs everywhere and
// names what is missing. The second runs
// tests/sql/a-dragged-stop-keeps-the-right-arrival-time.proof.sql against a
// real Postgres and ROLLS BACK; when no database is reachable it says so
// loudly and skips, like the other proofs.

import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
const M = (f: string) => join(ROOT, "supabase/migrations", f);
const ETAS = M("20261015130000_a-dragged-stop-keeps-the-right-arrival-time.sql");
const RESCHEDULE = M("20261015131000_a-moved-visit-keeps-its-tech.sql");
const PROOF = join(ROOT, "tests/sql/a-dragged-stop-keeps-the-right-arrival-time.proof.sql");
const DB_URL =
  process.env.DRAGGED_STOP_PROOF_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

/** The body of `CREATE OR REPLACE FUNCTION public.<name>(` up to its `$function$;`. */
function fn(sql: string, name: string): string {
  const at = sql.indexOf(`FUNCTION public.${name}(`);
  expect(at, `${name} is defined`).toBeGreaterThan(-1);
  const end = sql.indexOf("$function$;", at);
  return sql.slice(at, end);
}

describe("the migrations say what they do", () => {
  const etas = readFileSync(ETAS, "utf8");
  const reschedule = readFileSync(RESCHEDULE, "utf8");

  it("recomputes both lanes a reassign touches, and clears the time of an unassigned visit", () => {
    const body = fn(etas, "reassign_visit");
    expect(body).toMatch(/recompute_lane_etas\(v_org, v_old, v_day\)/);
    expect(body).toMatch(/recompute_lane_etas\(v_org, _staff_id, v_day\)/);
    expect(body).toMatch(/eta_start\s+=\s+CASE WHEN _staff_id IS NULL THEN NULL/);
    // The authorization it had is still there.
    expect(body).toMatch(/can_write_org\(auth\.uid\(\), v_org\)/);
    expect(body).toMatch(/assert_runs_routes\(_staff_id\)/);
  });

  it("recomputes the reordered lane, and any lane a listed visit came from", () => {
    const body = fn(etas, "reorder_route");
    expect(body).toMatch(/recompute_lane_etas\(v_org, _staff_id, _day\)/);
    expect(body).toMatch(/FOREACH v_s IN ARRAY v_prev/);
    expect(body).toMatch(/can_write_org\(auth\.uid\(\), v_org\)/);
  });

  it("replays apply_route_plan's clock rather than inventing another", () => {
    const body = fn(etas, "recompute_lane_etas");
    for (const helper of ["staff_start_point", "drive_minutes", "road_km", "stop_service_min"]) {
      expect(body, helper).toContain(`public.${helper}(`);
    }
    // Windows follow the organization's setting, as auto-routing's do.
    expect(body).toMatch(/route_windows/);
  });

  it("keeps the original unchecked helper away from the API roles", () => {
    expect(etas).toMatch(
      /REVOKE ALL ON FUNCTION public\.recompute_lane_etas\(uuid, uuid, date\) FROM PUBLIC, anon, authenticated;/,
    );
    expect(etas).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\.recompute_lane_etas[^;]*authenticated/,
    );
  });

  it("grants the checked helper to authenticated without changing its clock", () => {
    const sql = readFileSync(
      M("20261015141000_routing-functions-check-before-writing.sql"),
      "utf8",
    );
    const guard = `  IF NOT public.can_write_org(auth.uid(), _org_id) THEN
    RAISE EXCEPTION 'Not authorized to plan routes for this organization' USING ERRCODE = '42501';
  END IF;

`;
    const body = fn(sql, "recompute_lane_etas");
    expect(body).toContain(guard);
    expect(body.indexOf(guard)).toBeLessThan(body.indexOf("SELECT COALESCE(o.timezone"));
    expect(body.replace(guard, "")).toBe(fn(etas, "recompute_lane_etas"));
    for (const signature of [
      "recompute_lane_etas(uuid, uuid, date)",
      "reassign_visit(uuid, uuid)",
      "reorder_route(uuid, date, uuid[])",
      "reschedule_visit(uuid, date, text)",
      "capture_routing_run_undo(uuid)",
      "seal_routing_run_undo(uuid)",
      "routing_run_undo_state(uuid)",
      "undo_routing_run(uuid)",
    ]) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC, anon;`);
      expect(sql).toContain(
        `GRANT EXECUTE ON FUNCTION public.${signature} TO authenticated, service_role;`,
      );
    }
  });

  it("keeps the technician on a work day they are not off, and clears the old times", () => {
    const body = fn(reschedule, "reschedule_visit");
    expect(body).not.toMatch(/assigned_staff_id = NULL,/);
    expect(body).toMatch(/assigned_staff_id = CASE WHEN _keep THEN _tech ELSE NULL END/);
    expect(body).toMatch(/is_staff_off\(_tech, _new_date\)/);
    expect(body).toMatch(/work_days/);
    expect(body).toMatch(/eta_start = NULL/);
    expect(body).toMatch(/recompute_lane_etas\(_org, _tech, _old\)/);
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
    `\n  SKIPPED: the dragged-stop proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set DRAGGED_STOP_PROOF_DB_URL to run them.\n",
  );
}

function runProof(args: string[]) {
  let r = spawnSync(psql!, args, { encoding: "utf8", timeout: 300_000 });
  for (let i = 0; i < 2 && /deadlock detected/.test(`${r.stdout}${r.stderr}`); i++) {
    r = spawnSync(psql!, args, { encoding: "utf8", timeout: 300_000 });
  }
  return r;
}

describe.skipIf(!reachable)(
  "a dragged stop keeps the right arrival time, in a real database",
  () => {
    it("has the files it runs", () => {
      for (const f of [ETAS, RESCHEDULE, PROOF]) expect(existsSync(f), f).toBe(true);
    });

    it("proves every rule, and leaves nothing behind", () => {
      const r = runProof([
        DB_URL,
        "-X",
        "-v",
        `etas=${ETAS}`,
        "-v",
        `reschedule=${RESCHEDULE}`,
        "-f",
        PROOF,
      ]);
      const out = `${r.stdout}\n${r.stderr}`;
      expect(r.status, out).toBe(0);
      expect(out).not.toMatch(/PROOF FAILED/);
      expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(4);
      expect(out).toMatch(/ALL DRAGGED-STOP PROOFS PASSED/);

      const left = spawnSync(
        psql!,
        [
          DB_URL,
          "-XAtc",
          "select count(*) from public.organizations where name like 'ETA Proof %'",
        ],
        { encoding: "utf8" },
      );
      expect(left.stdout.trim()).toBe("0");
    });
  },
);
