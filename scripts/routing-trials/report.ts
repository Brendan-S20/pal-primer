/**
 * The trials, as text a person can read. Printed by `npm run trials:routing`.
 */
import { STATEMENT_TIMEOUT_MS, type TrialResult } from "./harness";
import { pct } from "./metrics";

const f1 = (x: number | null | undefined) =>
  x == null || !Number.isFinite(x) ? "-" : x.toFixed(1);
const signed = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`;

export function formatTrial(r: TrialResult): string {
  const c = r.checks;
  const L: string[] = [];
  L.push(`\n=== ${r.sc.id}: ${r.sc.title}`);
  L.push(`    ${r.sc.question}`);
  L.push(
    `    road legs: ${r.legResult.problem ? `NOT measured (${r.legResult.problem})` : `${r.legsWritten} measured`}` +
      `${r.legResult.pointsOutsideGraph ? `, ${r.legResult.pointsOutsideGraph} points outside the map` : ""}` +
      `; OSRM requests ${r.osrmRequests}${r.recorded ? ` (${r.recorded} recorded now)` : ""}` +
      `${r.profile.speed ? `; measured profile ${f1(r.profile.speed)} km/h x${r.profile.factor}` : ""}`,
  );
  if (r.ts) {
    L.push(
      `    read ${r.forecast.ok ? "ok" : `FAILED: ${r.forecast.err}`} in ${r.ts.inputsMs.toFixed(0)} ms; ` +
        `solve ${r.ts.solveMs.toFixed(0)} ms (${r.ts.solver?.rounds ?? 0} rounds, stopped by ${r.ts.solver?.stoppedBy ?? "-"}); ` +
        `write ${r.apply.ok ? "ok" : `FAILED: ${r.apply.err}`} in ${r.ts.applyMs.toFixed(0)} ms; ` +
        `windows ${r.ts.honourWindows ? "honoured" : "set aside"}; drive model vs drive_minutes ${r.modelMismatch?.toFixed(4) ?? "-"} min` +
        `${Math.max(r.ts.inputsMs, r.ts.applyMs) > STATEMENT_TIMEOUT_MS ? "  << OVER THE 8 s API LIMIT" : ""}`,
    );
  } else {
    L.push(
      `    forecast ${r.forecast.ok ? "ok" : `FAILED: ${r.forecast.err}`} in ${r.forecast.ms.toFixed(0)} ms; ` +
        `apply ${r.apply.ok ? "ok" : `FAILED: ${r.apply.err}`} in ${r.apply.ms.toFixed(0)} ms` +
        `${Math.max(r.forecast.ms, r.apply.ms) > STATEMENT_TIMEOUT_MS ? "  << OVER THE 8 s API LIMIT" : ""}`,
    );
  }
  for (const t of r.techs) {
    if (!t.stops.length && !t.eligible) {
      L.push(`    - ${t.name}: not routed`);
      continue;
    }
    const vsNN = t.plannerCost != null && t.nnCost ? signed(pct(t.plannerCost, t.nnCost)) : "-";
    const vsGood =
      t.plannerCost != null && t.goodCost ? signed(pct(t.plannerCost, t.goodCost)) : "-";
    const road =
      t.roadCost != null
        ? ` | on real roads ${f1(t.roadCost)} min (best order found ${f1(t.goodRoadCost)})`
        : "";
    L.push(
      `    - ${t.name}${t.eligible ? "" : " [NOT ELIGIBLE]"}: ${t.stops.length} stops, drive ${f1(t.driveMin)} + service ${t.serviceMin} min, ` +
        `ends ${t.endLocal ?? "-"}${t.overtimeMin ? ` (${t.overtimeMin} min past workday end)` : ""}` +
        `${t.overCapacityMin ? `, ${f1(t.overCapacityMin)} min over capacity` : ""}; start=${t.startSource}`,
    );
    L.push(
      `        order: planner ${f1(t.plannerCost)} vs nearest-neighbour ${f1(t.nnCost)} (${vsNN}) vs best found ${f1(t.goodCost)} (${vsGood}); ` +
        `self-crossings ${t.crossings}` +
        `${t.sideChanges ? `; bay crossings ${t.sideChanges.changes} (minimum ${t.sideChanges.minimum})` : ""}${road}`,
    );
  }
  const bad: string[] = [];
  if (c.unassigned.length) bad.push(`UNASSIGNED: ${c.unassigned.join(", ")}`);
  if (c.onIneligible.length)
    bad.push(`left on someone who cannot run today: ${c.onIneligible.join(", ")}`);
  if (c.seqBroken.length) bad.push(`sequence not 1..n: ${c.seqBroken.join(", ")}`);
  if (c.nonFinite.length) bad.push(`no ETA / non-finite drive: ${c.nonFinite.join(", ")}`);
  if (c.etaChainBroken.length) bad.push(`ETA chain broken: ${c.etaChainBroken.join("; ")}`);
  if (c.offDay.length) bad.push(`ETA not on the scheduled day: ${c.offDay.join(", ")}`);
  const missed = c.windowTruth.filter((w) => w.missed);
  const hidden = missed.filter((w) => !w.flagged);
  if (c.windowTruth.length) {
    bad.push(
      `windows: ${c.windowTruth.length} with a latest time, ${missed.length} missed, ${hidden.length} missed WITHOUT the flag; ` +
        `forecast said ${c.forecastViolations}, applied flags ${c.appliedViolations}` +
        ` [${c.windowTruth.map((w) => `${w.key} ${w.arrivalLocal}<=${w.latest}${w.missed ? (w.flagged ? " MISSED/flagged" : " MISSED/silent") : ""}`).join("; ")}]`,
    );
  }
  if (c.teleports.length) {
    bad.push(
      `no-coordinate stops placed mid-route: ${c.teleports.map((t) => `${t.key} hides ${f1(t.hiddenMin)} min`).join(", ")}`,
    );
  }
  if (c.fit.overruns.length || c.fit.unlocated.length) {
    bad.push(
      `the panel now says: ${[
        ...c.fit.overruns.map((o) =>
          o.minutesPastEnd > 0
            ? `${o.staffId} finishes ${o.minutesPastEnd} min after the workday ends`
            : `${o.staffId} has ${o.plannedMin} min planned against ${o.capacityMin}`,
        ),
        ...c.fit.unlocated.map((u) => `${u.count} stop(s) with no map location`),
      ].join("; ")}`,
    );
  }
  if (c.boardWarnings.length) {
    bad.push(`board warnings: ${c.boardWarnings.map((w) => `${w.key}: ${w.reason}`).join("; ")}`);
  }
  L.push(
    `    split: spread ${f1(c.balanceSpreadMin)} min between busiest and lightest; interleave ${(c.interleave * 100).toFixed(0)}% of stops' nearest neighbour is another truck's`,
  );
  for (const b of bad) L.push(`    ! ${b}`);
  if (!r.forecast.ok || !r.apply.ok) {
    const tail = r.stderr.trim().split("\n").slice(-14).join("\n      ");
    if (tail) L.push(`    psql said:\n      ${tail}`);
  }
  return L.join("\n");
}

export function formatAll(rs: TrialResult[]): string {
  return rs.map(formatTrial).join("\n") + "\n";
}

// ── The benchmark: the planner the app ships against the one it replaced ──

export type BenchSide = {
  /** Sum of every eligible truck's drive minutes, as written (travel_min). */
  driveMin: number;
  /** Busiest minus lightest truck, drive + service minutes. */
  spreadMin: number;
  /** Stops reached after their latest time. */
  lateMisses: number;
  /** Stops reached before their earliest time (only possible when windows are set aside). */
  earlyMisses: number;
  /** What a dispatcher waits for: every planner statement plus the solve. */
  runtimeMs: number;
  /** The single longest database statement, against the 8 s API limit. */
  longestStatementMs: number;
  ok: boolean;
};

export type BenchRow = {
  id: string;
  trucks: number;
  stops: number;
  measured: boolean;
  sql: BenchSide | null;
  ts: BenchSide;
};

function side(r: TrialResult): BenchSide {
  const eligible = r.techs.filter((t) => t.eligible);
  const statements =
    r.planner === "ts" ? [r.ts?.inputsMs ?? 0, r.ts?.applyMs ?? 0] : [r.forecast.ms, r.apply.ms];
  return {
    driveMin: eligible.reduce((s, t) => s + t.driveMin, 0),
    spreadMin: r.checks.balanceSpreadMin,
    lateMisses: r.checks.windowTruth.filter((w) => w.missed).length,
    earlyMisses: r.ts ? r.ts.misses.filter((m) => m.kind === "early").length : 0,
    runtimeMs: statements.reduce((a, b) => a + b, 0) + (r.ts?.solveMs ?? 0),
    longestStatementMs: Math.max(...statements),
    ok: r.forecast.ok && r.apply.ok,
  };
}

export function benchmarkRows(ts: TrialResult[], sql: Map<string, TrialResult>): BenchRow[] {
  return ts.map((r) => {
    const base = sql.get(r.sc.id);
    return {
      id: r.sc.id,
      trucks: r.techs.filter((t) => t.eligible).length,
      stops: r.visits.length,
      measured: !r.legResult.problem && r.legsWritten > 0,
      sql: base ? side(base) : null,
      ts: side(r),
    };
  });
}

const sec = (ms: number) => `${(ms / 1000).toFixed(ms < 1000 ? 2 : 1)} s`;
const delta = (a: number, b: number) =>
  b > 0 ? `${a - b >= 0 ? "+" : ""}${(((a - b) / b) * 100).toFixed(1)}%` : a === b ? "0%" : "-";

/** The comparison as a Markdown table, which is what the PR body carries. */
export function formatBenchmark(rows: BenchRow[]): string {
  const L: string[] = [
    "",
    "Benchmark: plpgsql planner (old) vs TypeScript solver (new), same day, same road data",
    "",
    "| Scenario | Trucks | Stops | Road | Drive old → new (min) | Δ drive | Spread old → new (min) | Late old → new | Runtime old → new | Longest statement old → new |",
    "|---|---:|---:|---|---:|---:|---:|---:|---:|---:|",
  ];
  let dOld = 0;
  let dNew = 0;
  for (const r of rows) {
    const o = r.sql;
    const n = r.ts;
    if (o) {
      dOld += o.driveMin;
      dNew += n.driveMin;
    }
    const late = (s: BenchSide) =>
      `${s.lateMisses}${s.earlyMisses ? ` (+${s.earlyMisses} early)` : ""}`;
    L.push(
      `| ${r.id} | ${r.trucks} | ${r.stops} | ${r.measured ? "measured" : "estimated"} | ` +
        `${o ? f1(o.driveMin) : "-"} → ${f1(n.driveMin)} | ${o ? delta(n.driveMin, o.driveMin) : "-"} | ` +
        `${o ? f1(o.spreadMin) : "-"} → ${f1(n.spreadMin)} | ` +
        `${o ? late(o) : "-"} → ${late(n)} | ` +
        `${o ? sec(o.runtimeMs) : "-"} → ${sec(n.runtimeMs)} | ` +
        `${o ? sec(o.longestStatementMs) : "-"}${o && o.longestStatementMs > STATEMENT_TIMEOUT_MS ? " (over 8 s)" : ""} → ${sec(n.longestStatementMs)} |`,
    );
  }
  L.push(
    "",
    `All scenarios: ${f1(dOld)} → ${f1(dNew)} minutes of driving (${delta(dNew, dOld)}).`,
    "",
  );
  return L.join("\n");
}
