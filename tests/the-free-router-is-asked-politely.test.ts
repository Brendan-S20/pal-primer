// The free router is asked politely, and counted.
//
// Launch measures road legs on router.project-osrm.org, the public OSRM demo.
// It is free and shared, its usage policy asks for no more than one request a
// second, and under load it answers 429. Four things follow, and each is
// pinned here by BEHAVIOUR -- fetch and the admin client are faked, the clock
// is injected, nothing sleeps for real and nothing reaches a network:
//
//   1. a day whose every leg is already measured and fresh is not asked at all;
//   2. requests to the demo host are at least 1.1 s apart; a self-hosted router
//      is not paced;
//   3. a 429 is retried ONCE after Retry-After (seconds or HTTP-date, capped at
//      5 s), and a second 429 is its own named cause, `router_busy`;
//   4. every day measured leaves one row in road_leg_runs -- measured, cached or
//      estimated-and-why -- and a failure to write that row changes nothing.
//
// The migration half (the table, its deny-all, the two functions) is
// supabase/migrations/20261002090600_the-free-router-is-counted.sql, whose own
// $check$ block asserts it on every replay.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Admin = { from: (table: string) => unknown; rpc: (...a: unknown[]) => unknown };
const h = vi.hoisted(() => ({ admin: null as unknown as Admin }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => h.admin.from(table),
    rpc: (...a: unknown[]) => h.admin.rpc(...a),
  },
}));

import { refreshRoadLegs, setRoadLegTiming, type RoadLegResult } from "@/lib/road-legs.server";

// ── The world, faked ────────────────────────────────────────────────────────

/** Three stops in Plano. Three points is six ordered pairs. */
const STOPS: Array<[number, number]> = [
  [33.0496, -96.8468],
  [33.0532, -96.6789],
  [33.0198, -96.698912345], // more than 5 dp, to prove the cache check is asked rounded
];
const PAIRS = STOPS.length * (STOPS.length - 1);

type Run = Record<string, unknown>;
type World = {
  /** What count_fresh_road_legs answers: the number of fresh pairs, or an error. */
  fresh: number | "error";
  freshArgs: Array<Record<string, unknown>>;
  runs: Run[];
  /** What inserting into road_leg_runs does. */
  runInsert: "ok" | "error" | "throw";
  pruned: number;
  written: number;
};

let world: World;

function adminFor(w: World): Admin {
  const rows = (data: unknown[]) => {
    const q = {
      select: () => q,
      eq: () => q,
      maybeSingle: () => Promise.resolve({ data: data[0] ?? null, error: null }),
      then: (ok: (v: unknown) => unknown, no?: (e: unknown) => unknown) =>
        Promise.resolve({ data, error: null }).then(ok, no),
    };
    return q;
  };
  return {
    from(t: string) {
      if (t === "visits")
        return rows(
          STOPS.map(([latitude, longitude]) => ({ properties: { latitude, longitude } })),
        );
      if (t === "staff" || t === "waste_disposal_facilities") return rows([]);
      if (t === "organizations") return rows([{ latitude: null, longitude: null }]);
      if (t === "road_legs")
        return {
          upsert: async (r: unknown[]) => {
            w.written += r.length;
            return { error: null };
          },
        };
      if (t === "road_leg_runs")
        return {
          insert: async (row: Run) => {
            if (w.runInsert === "throw") throw new Error("connection reset");
            if (w.runInsert === "error") return { error: { message: "permission denied" } };
            w.runs.push(row);
            return { error: null };
          },
          delete: () => ({
            eq: () => ({
              lt: async () => {
                w.pruned++;
                return { error: null };
              },
            }),
          }),
        };
      throw new Error(`unexpected table ${t}`);
    },
    async rpc(name: unknown, args: unknown) {
      if (name === "count_fresh_road_legs") {
        w.freshArgs.push(args as Record<string, unknown>);
        if (w.fresh === "error") return { data: null, error: { message: "boom" } };
        return { data: w.fresh, error: null };
      }
      if (name === "refresh_road_profile") return { data: null, error: null };
      throw new Error(`unexpected rpc ${String(name)}`);
    },
  };
}

// The clock. `sleep` advances it, so "how long apart were two requests" is a
// subtraction rather than a stopwatch.
let t = 0;
let sleeps: number[] = [];
const clock = {
  now: () => t,
  sleep: async (ms: number) => {
    sleeps.push(ms);
    t += ms;
  },
};

type Reply = { status: number; headers?: Record<string, string> };
let fetches: Array<{ url: string; at: number }> = [];
/** Replies to hand out in order; once empty, every request gets a good table. */
let replies: Reply[] = [];

function okTable(url: string) {
  const n = url.split("/table/v1/driving/")[1].split("?")[0].split(";").length;
  const m = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 0 : 600)),
  );
  return {
    code: "Ok",
    durations: m,
    distances: m,
    sources: Array.from({ length: n }, () => ({ distance: 5 })),
    destinations: Array.from({ length: n }, () => ({ distance: 5 })),
  };
}

beforeEach(() => {
  world = { fresh: 0, freshArgs: [], runs: [], runInsert: "ok", pruned: 0, written: 0 };
  h.admin = adminFor(world);
  t = 1_790_000_000_000;
  sleeps = [];
  fetches = [];
  replies = [];
  setRoadLegTiming(clock);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      fetches.push({ url, at: t });
      const r = replies.shift();
      if (r && r.status !== 200)
        return new Response(JSON.stringify({ message: "Too Many Requests" }), {
          status: r.status,
          headers: r.headers,
        });
      return new Response(JSON.stringify(okTable(url)), { status: 200 });
    }),
  );
});

afterEach(() => {
  setRoadLegTiming(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.OSRM_ENDPOINTS;
});

const DAY = "2026-10-14";

// ── 1. Do not ask a question we already hold the answer to ──────────────────

describe("a day whose legs are all measured and fresh is not sent to the router", () => {
  it("makes no request at all, and says the day was cached rather than estimated", async () => {
    world.fresh = PAIRS;
    const r = await refreshRoadLegs("org", DAY);
    expect(fetches).toHaveLength(0);
    expect(r).toEqual({ measured: 0, problem: null, pointsOutsideGraph: 0, cached: true });
  });

  it("asks the cache about the points rounded as road_legs stores them", async () => {
    world.fresh = PAIRS;
    await refreshRoadLegs("org", DAY);
    expect(world.freshArgs).toEqual([
      {
        _org_id: "org",
        _lats: [33.0496, 33.0532, 33.0198],
        _lons: [-96.8468, -96.6789, -96.69891],
      },
    ]);
  });

  it("asks the router once when a single pair is missing or stale", async () => {
    world.fresh = PAIRS - 1;
    const r = await refreshRoadLegs("org", DAY);
    expect(fetches).toHaveLength(1);
    expect(r).toMatchObject({ measured: PAIRS, problem: null, cached: false });
  });

  it("asks the router when the cache check itself fails, rather than trusting nothing", async () => {
    world.fresh = "error";
    const r = await refreshRoadLegs("org", DAY);
    expect(fetches).toHaveLength(1);
    expect(r.cached).toBe(false);
    expect(r.problem).toBeNull();
  });
});

// ── 2. One request a second to the demo, none of that for our own ───────────

describe("requests to the public demo are paced", () => {
  it("keeps two days at least 1.1 s apart on router.project-osrm.org", async () => {
    await refreshRoadLegs("org", DAY);
    await refreshRoadLegs("org", "2026-10-15");
    expect(fetches).toHaveLength(2);
    expect(new URL(fetches[0].url).hostname).toBe("router.project-osrm.org");
    expect(fetches[1].at - fetches[0].at).toBeGreaterThanOrEqual(1100);
    expect(sleeps).toEqual([1100]);
  });

  it("does not wait when the last request was already long enough ago", async () => {
    await refreshRoadLegs("org", DAY);
    t += 5000;
    await refreshRoadLegs("org", "2026-10-15");
    expect(sleeps).toEqual([]);
  });

  it("queues concurrent days behind each other instead of firing them together", async () => {
    // A frozen clock, because the shared one advances on every sleep and so
    // cannot model three waits running at once. What it can show: each day
    // waits for its OWN slot -- 0, 1.1 s, 2.2 s -- rather than all three
    // reading the same last-request time and waking together at 1.1 s.
    const frozen = t;
    setRoadLegTiming({ now: () => frozen, sleep: async (ms) => void sleeps.push(ms) });
    await Promise.all([
      refreshRoadLegs("org", DAY),
      refreshRoadLegs("org", "2026-10-15"),
      refreshRoadLegs("org", "2026-10-16"),
    ]);
    expect(fetches).toHaveLength(3);
    expect([...sleeps].sort((a, b) => a - b)).toEqual([1100, 2200]);
  });

  it("does not pace a self-hosted router", async () => {
    process.env.OSRM_ENDPOINTS = JSON.stringify({ default: "http://osrm.internal:5000" });
    await refreshRoadLegs("org", DAY);
    await refreshRoadLegs("org", "2026-10-15");
    expect(fetches.map((f) => new URL(f.url).host)).toEqual([
      "osrm.internal:5000",
      "osrm.internal:5000",
    ]);
    expect(sleeps).toEqual([]);
    expect(fetches[1].at).toBe(fetches[0].at);
  });

  it("can be turned off, for the routing-trials harness", async () => {
    setRoadLegTiming({ ...clock, paceDemo: false });
    await refreshRoadLegs("org", DAY);
    await refreshRoadLegs("org", "2026-10-15");
    expect(sleeps).toEqual([]);
  });
});

// ── 3. Too Many Requests ────────────────────────────────────────────────────

describe("a 429 is retried once, as told, and then named", () => {
  it("waits the Retry-After seconds, retries once, and measures the day", async () => {
    replies = [{ status: 429, headers: { "Retry-After": "3" } }];
    const r = await refreshRoadLegs("org", DAY);
    expect(fetches).toHaveLength(2);
    expect(sleeps).toContain(3000);
    expect(fetches[1].at - fetches[0].at).toBe(3000);
    expect(r).toMatchObject({ measured: PAIRS, problem: null, cached: false });
  });

  it("gives up after the second 429 and says the router was busy", async () => {
    replies = [
      { status: 429, headers: { "Retry-After": "1" } },
      { status: 429, headers: { "Retry-After": "1" } },
    ];
    const r = await refreshRoadLegs("org", DAY);
    expect(fetches).toHaveLength(2);
    expect(r).toEqual({
      measured: 0,
      problem: "router_busy",
      pointsOutsideGraph: 0,
      cached: false,
    });
  });

  it("caps a long Retry-After at 5 s", async () => {
    replies = [{ status: 429, headers: { "Retry-After": "60" } }];
    await refreshRoadLegs("org", DAY);
    expect(sleeps).toEqual([5000]);
  });

  it("reads an HTTP-date Retry-After against the clock", async () => {
    replies = [{ status: 429, headers: { "Retry-After": new Date(t + 2000).toUTCString() } }];
    await refreshRoadLegs("org", DAY);
    // toUTCString drops milliseconds, so the date can land up to 999 ms early.
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(1000);
    expect(sleeps[0]).toBeLessThanOrEqual(2000);
  });

  it("waits a second when there is no Retry-After, and still paces the demo", async () => {
    replies = [{ status: 429 }];
    await refreshRoadLegs("org", DAY);
    expect(fetches).toHaveLength(2);
    expect(fetches[1].at - fetches[0].at).toBeGreaterThanOrEqual(1100);
  });

  it("does not retry other errors", async () => {
    replies = [{ status: 503 }];
    const r = await refreshRoadLegs("org", DAY);
    expect(fetches).toHaveLength(1);
    expect(r.problem).toBe("router_error");
  });
});

// ── 4. Counted ──────────────────────────────────────────────────────────────

describe("every day measured leaves one row in road_leg_runs", () => {
  const counted = () =>
    world.runs.map((r) => ({ outcome: r.outcome, reason: r.reason, points: r.points }));

  it("counts a measured day", async () => {
    await refreshRoadLegs("org", DAY);
    expect(counted()).toEqual([{ outcome: "measured", reason: null, points: 3 }]);
    expect(world.runs[0]).toMatchObject({ organization_id: "org", day: DAY });
  });

  it("counts a cached day", async () => {
    world.fresh = PAIRS;
    await refreshRoadLegs("org", DAY);
    expect(counted()).toEqual([{ outcome: "cached", reason: null, points: 3 }]);
  });

  it("counts an estimated day with its reason", async () => {
    replies = [{ status: 429 }, { status: 429 }];
    await refreshRoadLegs("org", DAY);
    expect(counted()).toEqual([{ outcome: "estimated", reason: "router_busy", points: 3 }]);
  });

  it("counts a router that cannot be reached as estimated, router_unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await refreshRoadLegs("org", DAY);
    expect(counted()).toEqual([{ outcome: "estimated", reason: "router_unreachable", points: 3 }]);
  });

  it("counts a partly-measured day as measured, and names the partial", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const body = okTable(String(input));
        body.sources[2] = { distance: 9000 }; // snapped 9 km: outside the graph
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    const r = await refreshRoadLegs("org", DAY);
    expect(r.pointsOutsideGraph).toBe(1);
    expect(counted()).toEqual([{ outcome: "measured", reason: "points_outside_graph", points: 3 }]);
  });

  it("prunes that organization's old rows in the same write", async () => {
    await refreshRoadLegs("org", DAY);
    expect(world.pruned).toBe(1);
  });

  it("does not count a day that had nothing to measure", async () => {
    h.admin = {
      ...adminFor(world),
      from(tbl: string) {
        if (tbl === "visits") return adminFor(world).from("staff");
        return adminFor(world).from(tbl);
      },
    };
    const r = await refreshRoadLegs("org", DAY);
    expect(r).toEqual({ measured: 0, problem: null, pointsOutsideGraph: 0, cached: false });
    expect(world.runs).toEqual([]);
  });
});

describe("a counter that cannot write changes nothing", () => {
  const scenarios: Array<[string, () => void]> = [
    ["measured", () => {}],
    ["cached", () => (world.fresh = PAIRS)],
    ["estimated", () => (replies = [{ status: 429 }, { status: 429 }])],
  ];

  for (const failure of ["error", "throw"] as const) {
    for (const [name, arrange] of scenarios) {
      it(`returns the same ${name} result when the insert ${failure === "error" ? "is refused" : "throws"}`, async () => {
        arrange();
        const healthy: RoadLegResult = await refreshRoadLegs("org", DAY);

        world.runInsert = failure;
        setRoadLegTiming(clock); // reset pacing so the second run is shaped like the first
        arrange();
        const broken = await refreshRoadLegs("org", DAY);

        expect(broken).toEqual(healthy);
      });
    }
  }
});
