// The routing trials, as a regression suite.
//
// scripts/routing-trials plans twenty-odd synthetic businesses -- Manhattan,
// Plano, the Gallatin Valley, Tampa Bay, Kansas City, every US time zone that
// is not Central, a 200-stop Phoenix day, and a day of nothing but bad rows --
// with the REAL planner in the local Supabase (inside BEGIN ... ROLLBACK), and
// the real refreshRoadLegs against recorded public-OSRM answers. This file
// asserts the parts of the result that are deterministic. Quality numbers
// that depend on the machine (runtime) are printed, not asserted:
//
//   npm run trials:routing            # the report, offline, ~1 minute
//   npm run trials:routing:record     # re-record OSRM answers (network, 1 req/s)
//
// It needs the local stack (`supabase start`) and skips, loudly, without it.
// The four migrations it exists to prove are applied inside each trial's own
// transaction, so it tests them on a database that has not run them yet; set
// ROUTING_TRIALS_SKIP_MIGRATIONS=1 on such a database and the assertions
// below marked (mutation) fail, which is how they were checked.

import { beforeAll, describe, expect, it, vi } from "vitest";

type Admin = { from: (table: string) => unknown; rpc: (...a: unknown[]) => unknown };
const h = vi.hoisted(() => ({ admin: null as unknown as Admin }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => h.admin.from(table),
    rpc: (...a: unknown[]) => h.admin.rpc(...a),
  },
}));

import { refreshRoadLegs } from "@/lib/road-legs.server";
import {
  DB_URL,
  databaseReachable,
  runTrial,
  type TrialResult,
} from "../scripts/routing-trials/harness";
import { SCENARIOS } from "../scripts/routing-trials/scenarios";
import { formatAll } from "../scripts/routing-trials/report";
import { formatReferee, referee, sourceFromEnv } from "../scripts/routing-trials/google-referee";

const reachable = databaseReachable();
const only = process.env.ROUTING_TRIALS_ONLY?.split(",");
const results = new Map<string, TrialResult>();
const ran = () => [...results.values()];
const get = (id: string) => {
  const r = results.get(id);
  if (!r) throw new Error(`scenario ${id} did not run`);
  return r;
};

if (!reachable) {
  console.warn(
    `\n  SKIPPED: the routing trials did NOT run. No database answered at ${DB_URL}.\n` +
      "  Start the local stack (supabase start) or set ROUTING_TRIALS_DB_URL.\n",
  );
}

describe.skipIf(!reachable)("routing trials: every plan is complete and honest", () => {
  beforeAll(async () => {
    for (const sc of SCENARIOS.filter((s) => !only || only.includes(s.id))) {
      results.set(sc.id, await runTrial(sc, refreshRoadLegs, (a) => (h.admin = a as Admin)));
    }
    if (process.env.ROUTING_TRIALS_REPORT === "1") process.stdout.write(formatAll(ran()));
    // Google as the referee (npm run trials:routing:google). Bills a few
    // thousand Distance Matrix elements, so only when asked for.
    if (process.env.ROUTING_TRIALS_GOOGLE === "1") {
      const source = sourceFromEnv();
      if (!source) {
        throw new Error(
          "ROUTING_TRIALS_GOOGLE=1 needs GOOGLE_MAPS_API_KEY, or ROUTE_REFEREE_URL + ROUTE_REFEREE_TOKEN.",
        );
      }
      process.stdout.write(formatReferee(await referee(ran(), source)));
    }
  }, 900_000);

  it("ran every scenario through the forecast and the write", () => {
    for (const r of ran()) {
      expect(r.forecast.err, `${r.sc.id} forecast\n${r.stderr.slice(-800)}`).toBeNull();
      expect(r.apply.err, `${r.sc.id} apply\n${r.stderr.slice(-800)}`).toBeNull();
    }
  });

  it("never reached the network for an answer it should have had recorded", () => {
    for (const r of ran()) expect(r.fixtureMisses, r.sc.id).toEqual([]);
  });

  it("assigns every visit to somebody (mutation: a 0,0 refused the whole day)", () => {
    for (const r of ran()) expect(r.checks.unassigned, r.sc.id).toEqual([]);
  });

  it("puts nothing new on anyone who cannot run today", () => {
    // Only the visits that were ALREADY on Max before his day off may still
    // be on him; see the KNOWN case below. Owen, who does not run routes,
    // gets nothing even though he was selected.
    for (const r of ran()) {
      const fresh = r.checks.onIneligible.filter((s) => {
        const key = s.split("->")[0];
        return !r.sc.stops.find((st) => st.key === key)?.preassign;
      });
      expect(fresh, r.sc.id).toEqual([]);
    }
  });

  it("sequences every technician's day 1..n with a finite drive and an ETA", () => {
    for (const r of ran()) {
      expect(r.checks.seqBroken, r.sc.id).toEqual([]);
      expect(r.checks.nonFinite, r.sc.id).toEqual([]);
    }
  });

  it("anchors every ETA at the org's own workday start, in the org's own zone", () => {
    // Recomputed in TypeScript (route-window.ts) rather than trusted from
    // SQL: Pacific, Mountain, Arizona, Hawaii, Alaska, both DST Sundays, a
    // 07:30 and a 09:00 start, and a metro across the Eastern/Central line.
    for (const r of ran()) expect(r.checks.etaChainBroken, r.sc.id).toEqual([]);
  });

  it("keeps every ETA on the scheduled day unless the day genuinely overflows", () => {
    for (const r of ran()) {
      if (r.sc.id === "overfull" || r.sc.id === "bad-coordinates") continue;
      expect(r.checks.offDay, r.sc.id).toEqual([]);
    }
  });

  it("never misses an arrival window without flagging it (mutation)", () => {
    for (const r of ran()) {
      const hidden = r.checks.windowTruth.filter((w) => w.missed && !w.flagged);
      expect(hidden, r.sc.id).toEqual([]);
    }
  });

  it("never hides the drive around a stop that has no location (mutation)", () => {
    for (const r of ran()) expect(r.checks.teleports, r.sc.id).toEqual([]);
  });

  it("does not tell the dispatcher to re-optimize a route it just optimized", () => {
    for (const r of ran()) {
      const bogus = r.checks.boardWarnings.filter((w) => w.reason === "eta_inconsistent");
      expect(bogus, r.sc.id).toEqual([]);
    }
  });
});

describe.skipIf(!reachable)("routing trials: specific scenarios", () => {
  it("measures the road where it can, and says why where it cannot", () => {
    for (const id of ["manhattan", "plano", "gallatin", "tampa", "kc", "tiny"]) {
      expect(get(id).legResult.problem, id).toBeNull();
      expect(get(id).legsWritten, id).toBeGreaterThan(0);
    }
    for (const id of ["manhattan-router-down", "plano-router-down", "tampa-router-down"]) {
      expect(get(id).legResult.problem, id).toBe("router_unreachable");
    }
    expect(get("plano-rate-limited").legResult.problem).toBe("router_error");
    // 206 points against a 90-point request: refused, said, never sent.
    expect(get("large-phoenix").legResult.problem).toBe("too_many_points");
    expect(get("large-phoenix").osrmRequests).toBe(0);
  });

  it("orders a measured day within 10% of the best order this harness can find", () => {
    for (const id of ["manhattan", "plano", "gallatin", "tampa", "kc", "tiny"]) {
      for (const t of get(id).techs.filter((x) => x.roadCost != null && x.goodRoadCost)) {
        expect(t.roadCost! / t.goodRoadCost!, `${id}/${t.key}`).toBeLessThanOrEqual(1.1);
      }
    }
  });

  it("still plans a usable day from estimates when the router is down", () => {
    // Scored on the recorded road times: the order planned blind costs at
    // most a quarter more than the best order on real roads. Tampa is the
    // worst case, and it is the water.
    for (const id of ["manhattan-router-down", "plano-router-down", "tampa-router-down"]) {
      for (const t of get(id).techs.filter((x) => x.roadCost != null && x.goodRoadCost)) {
        expect(t.roadCost! / t.goodRoadCost!, `${id}/${t.key}`).toBeLessThanOrEqual(1.25);
      }
    }
  });

  it("does not send a truck across Tampa Bay more often than it must", () => {
    for (const id of ["tampa", "tampa-router-down"]) {
      for (const t of get(id).techs.filter((x) => x.sideChanges)) {
        expect(t.sideChanges!.changes, `${id}/${t.key}`).toBe(t.sideChanges!.minimum);
      }
    }
  });

  it("splits a 200-stop day across six trucks within an hour of each other", () => {
    const r = get("large-phoenix");
    expect(r.visits.filter((v) => v.staffKey)).toHaveLength(200);
    expect(r.checks.balanceSpreadMin).toBeLessThanOrEqual(60);
    for (const t of r.techs) expect(t.stops.length, t.key).toBeGreaterThanOrEqual(25);
  });

  it("re-splits a day the generator put entirely on one technician", () => {
    const r = get("plano-all-on-one");
    for (const t of r.techs) expect(t.stops.length, t.key).toBeGreaterThanOrEqual(5);
  });

  it("routes a day with one bad coordinate instead of refusing it (mutation)", () => {
    const r = get("bad-coordinates");
    expect(r.apply.err).toBeNull();
    expect(r.visits.every((v) => v.staffKey)).toBe(true);
    // 0,0 is stored as "no location", goes last, and the panel says so.
    expect(r.checks.fit.unlocated).toEqual([{ day: r.sc.day, count: 1 }]);
    // Paris is a real place and stays; the board names it.
    expect(r.checks.boardWarnings.map((w) => w.key)).toContain("wrongcontinent");
    // The 0,0 never reached the router; Paris did and was found off the map.
    expect(r.legResult.problem).toBeNull();
    expect(r.legResult.pointsOutsideGraph).toBe(1);
  });

  it("honours the windows set on the service, and flags the one it cannot (mutation)", () => {
    const r = get("windows");
    const missed = r.checks.windowTruth.filter((w) => w.missed).map((w) => w.key);
    expect(missed).toEqual(["w_sub_tight"]);
    expect(r.checks.appliedViolations).toBe(1);
    expect(r.checks.forecastViolations).toBe(1);
    // An afternoon window no longer parks the truck all morning.
    for (const t of r.techs) expect(t.overtimeMin, t.key).toBe(0);
  });

  it("gives a part-timer a part-time day (mutation)", () => {
    const ned = get("edge-cases").techs.find((t) => t.key === "ned")!;
    expect(ned.driveMin + ned.serviceMin).toBeLessThanOrEqual(120);
    expect(ned.stops.length).toBeGreaterThan(0);
  });

  it("starts a technician with no address from the business, or the edge of the round", () => {
    expect(get("plano").techs.find((t) => t.key === "eli")!.startSource).toBe("business");
    expect(get("edge-cases").techs.find((t) => t.key === "lee")!.startSource).toBe("route");
  });

  it("tells the dispatcher when a day does not fit", () => {
    const over = get("overfull").checks.fit.overruns;
    expect(over).toHaveLength(1);
    expect(over[0].minutesPastEnd).toBeGreaterThan(500);
    expect(get("large-phoenix").checks.fit.overruns.length).toBe(6);
    expect(get("plano").checks.fit.overruns).toEqual([]);
  });

  it("KNOWN, NOT FIXED: visits already on a technician who then booked the day off stay on them", () => {
    // Auto-routing with reassign leaves them, and nothing on the panel says
    // so. Flip this when routing picks them up or reports them.
    expect(get("edge-cases").checks.onIneligible.sort()).toEqual([
      "offtech1->max",
      "offtech2->max",
    ]);
  });
});
