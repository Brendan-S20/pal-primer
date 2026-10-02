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
  L.push(
    `    forecast ${r.forecast.ok ? "ok" : `FAILED: ${r.forecast.err}`} in ${r.forecast.ms.toFixed(0)} ms; ` +
      `apply ${r.apply.ok ? "ok" : `FAILED: ${r.apply.err}`} in ${r.apply.ms.toFixed(0)} ms` +
      `${Math.max(r.forecast.ms, r.apply.ms) > STATEMENT_TIMEOUT_MS ? "  << OVER THE 8 s API LIMIT" : ""}`,
  );
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
