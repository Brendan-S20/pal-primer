// Google-derived data is refreshed or dropped after 30 days (#529 / #745).
//
// Decision (Brendan, 2026-11-09): Google for geocoding and routing, and
// Google-derived data refreshed or dropped after 30 days for Google Maps
// Platform's caching terms. What this file pins is the SELECTION, because
// that is where a mistake costs something: picking too little keeps Google
// data past its terms, and picking too much deletes a coordinate that was
// never Google's -- which the decision rules out.
//
//   * Google road legs older than 30 days are deleted; newer Google legs and
//     every non-Google leg are not.
//   * Google pins ('google', 'google_places') older than 30 days are
//     re-geocoded, or cleared when that fails; newer Google pins, and pins
//     from Geocodio, Nominatim, a person, or an unknown source, are not.
//
// The fake below APPLIES the filters the job sends (in, lt, eq, order, limit)
// to rows in memory, so a wrong column, a wrong operator or a missing filter
// changes which rows move -- not merely which strings were sent.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  GOOGLE_CACHE_DAYS,
  GOOGLE_REFRESH_DAYS,
  inferClientPointSource,
  isGoogleGeocodeDue,
  isGoogleRoadLegDue,
} from "@/lib/geocode-source";
import {
  expireGoogleDerivedData,
  purgeGoogleRoadLegs,
  refreshGooglePins,
  selectDueGooglePins,
} from "@/lib/google-cache-expiry.server";
import type { SourcedGeocode } from "@/lib/geocode.server";

const root = join(import.meta.dirname, "..");
const NOW = new Date("2026-11-09T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

// ── A table in memory that honours the filters ─────────────────────────────

type Row = Record<string, unknown>;
type Filter = (r: Row) => boolean;

function fakeAdmin(tables: Record<string, Row[]>) {
  const writes: Array<{ table: string; op: string; ids: unknown[] }> = [];
  function from(table: string) {
    const rows = tables[table];
    if (!rows) throw new Error(`unexpected table ${table}`);
    const filters: Filter[] = [];
    let op: "select" | "update" | "delete" = "select";
    let patch: Row = {};
    let order: { col: string; asc: boolean } | null = null;
    let limit = Infinity;
    let returning = false;
    let wantCount = false;
    const q: any = {
      select(_cols?: string) {
        if (op !== "select") returning = true;
        return q;
      },
      update(p: Row) {
        op = "update";
        patch = p;
        return q;
      },
      delete(opts?: { count?: string }) {
        op = "delete";
        wantCount = opts?.count === "exact";
        return q;
      },
      eq(col: string, v: unknown) {
        filters.push((r) => r[col] === v);
        return q;
      },
      in(col: string, vs: unknown[]) {
        filters.push((r) => vs.includes(r[col]));
        return q;
      },
      lt(col: string, v: string) {
        // Postgres: NULL < x is not true, so a NULL timestamp is never picked.
        filters.push((r) => r[col] != null && Date.parse(String(r[col])) < Date.parse(v));
        return q;
      },
      order(col: string, o?: { ascending?: boolean }) {
        order = { col, asc: o?.ascending !== false };
        return q;
      },
      limit(n: number) {
        limit = n;
        return q;
      },
      then(ok: (v: unknown) => unknown, no?: (e: unknown) => unknown) {
        return Promise.resolve().then(run).then(ok, no);
      },
    };
    function run() {
      let hit = rows.filter((r) => filters.every((f) => f(r)));
      if (order) {
        const { col, asc } = order;
        hit = [...hit].sort(
          (a, b) => (Date.parse(String(a[col])) - Date.parse(String(b[col]))) * (asc ? 1 : -1),
        );
      }
      hit = hit.slice(0, limit);
      if (op === "select") return { data: hit.map((r) => ({ ...r })), error: null };
      if (op === "update") {
        for (const r of hit) Object.assign(r, patch);
        writes.push({ table, op, ids: hit.map((r) => r.id) });
        return { data: returning ? hit.map((r) => ({ id: r.id })) : null, error: null };
      }
      for (const r of hit) rows.splice(rows.indexOf(r), 1);
      writes.push({ table, op, ids: hit.map((r) => r.id) });
      return { data: null, count: wantCount ? hit.length : null, error: null };
    }
    return q;
  }
  return { admin: { from } as any, writes };
}

// ── The rule itself ─────────────────────────────────────────────────────────

describe("which Google-derived values are due", () => {
  it("is thirty days at most, and refresh starts a week inside that", () => {
    // 29, not 30: one daily run's margin inside the 30-day terms
    // (Product review 5830897980).
    expect(GOOGLE_CACHE_DAYS).toBe(29);
    expect(GOOGLE_REFRESH_DAYS).toBe(22);
  });

  it("a Google pin is due for refresh from 22 days", () => {
    expect(isGoogleGeocodeDue({ geocode_source: "google", geocoded_at: daysAgo(24) }, NOW)).toBe(
      true,
    );
    expect(isGoogleGeocodeDue({ geocode_source: "google", geocoded_at: daysAgo(21) }, NOW)).toBe(
      false,
    );
  });

  it("a Google pin older than 30 days is due; a newer one is not", () => {
    expect(isGoogleGeocodeDue({ geocode_source: "google", geocoded_at: daysAgo(31) }, NOW)).toBe(
      true,
    );
    expect(
      isGoogleGeocodeDue({ geocode_source: "google_places", geocoded_at: daysAgo(45) }, NOW),
    ).toBe(true);
    expect(isGoogleGeocodeDue({ geocode_source: "google", geocoded_at: daysAgo(5) }, NOW)).toBe(
      false,
    );
  });

  it("a pin from any other source, or an unknown one, is never due however old", () => {
    for (const geocode_source of ["geocodio", "nominatim", "manual", null, "osm", ""]) {
      expect(isGoogleGeocodeDue({ geocode_source, geocoded_at: daysAgo(400) }, NOW)).toBe(false);
    }
    expect(isGoogleGeocodeDue({ geocode_source: "google", geocoded_at: null }, NOW)).toBe(false);
  });

  it("a Google road leg older than 30 days is due; newer Google legs and every OSRM leg are not", () => {
    expect(isGoogleRoadLegDue({ source: "google", fetched_at: daysAgo(31) }, NOW)).toBe(true);
    expect(isGoogleRoadLegDue({ source: "google", fetched_at: daysAgo(10) }, NOW)).toBe(false);
    expect(isGoogleRoadLegDue({ source: "osrm", fetched_at: daysAgo(80) }, NOW)).toBe(false);
  });
});

// ── road_legs ───────────────────────────────────────────────────────────────

describe("the road-leg purge", () => {
  it("deletes Google legs older than 30 days and nothing else", async () => {
    const legs: Row[] = [
      { id: "g-old", source: "google", fetched_at: daysAgo(31) },
      { id: "g-much-older", source: "google", fetched_at: daysAgo(89) },
      { id: "g-new", source: "google", fetched_at: daysAgo(28) },
      { id: "osrm-old", source: "osrm", fetched_at: daysAgo(60) },
      { id: "osrm-new", source: "osrm", fetched_at: daysAgo(1) },
    ];
    const { admin } = fakeAdmin({ road_legs: legs });
    const r = await purgeGoogleRoadLegs(admin, NOW);
    expect(r).toEqual({ deleted: 2, error: null });
    expect(legs.map((l) => l.id).sort()).toEqual(["g-new", "osrm-new", "osrm-old"]);
  });
});

// ── properties ──────────────────────────────────────────────────────────────

function pins(): Row[] {
  const base = { street: "1 Main St", city: "Detroit", region: "MI", postal_code: "48201" };
  return [
    {
      id: "google-old",
      ...base,
      latitude: 1,
      longitude: 1,
      geocode_source: "google",
      geocoded_at: daysAgo(40),
    },
    {
      id: "places-old",
      ...base,
      latitude: 2,
      longitude: 2,
      geocode_source: "google_places",
      geocoded_at: daysAgo(31),
    },
    {
      id: "google-new",
      ...base,
      latitude: 3,
      longitude: 3,
      geocode_source: "google",
      geocoded_at: daysAgo(5),
    },
    {
      id: "geocodio-old",
      ...base,
      latitude: 4,
      longitude: 4,
      geocode_source: "geocodio",
      geocoded_at: daysAgo(300),
    },
    {
      id: "nominatim-old",
      ...base,
      latitude: 5,
      longitude: 5,
      geocode_source: "nominatim",
      geocoded_at: daysAgo(300),
    },
    {
      id: "manual-old",
      ...base,
      latitude: 6,
      longitude: 6,
      geocode_source: "manual",
      geocoded_at: daysAgo(300),
    },
    {
      id: "unknown-old",
      ...base,
      latitude: 7,
      longitude: 7,
      geocode_source: null,
      geocoded_at: null,
    },
  ];
}

const found = (lat: number, source: SourcedGeocode["source"] = "google"): SourcedGeocode => ({
  point: { latitude: lat, longitude: -lat, precision: "house", place: null },
  source,
});

describe("the pin refresh", () => {
  it("selects exactly the Google pins older than 30 days, oldest first", async () => {
    const { admin } = fakeAdmin({ properties: pins() });
    const { rows } = await selectDueGooglePins(admin, NOW);
    expect(rows.map((r) => r.id)).toEqual(["google-old", "places-old"]);
  });

  it("re-geocodes a due pin: new point, new source, new clock", async () => {
    const table = pins();
    const { admin } = fakeAdmin({ properties: table });
    const asked: string[] = [];
    const r = await refreshGooglePins(admin, {
      now: () => NOW,
      geocode: async (p) => {
        asked.push(String(p.street));
        return found(42, "google");
      },
    });
    expect(r).toMatchObject({ pinsDue: 2, pinsRefreshed: 2, pinsCleared: 0, pinsSkipped: 0 });
    expect(asked).toHaveLength(2);
    const g = table.find((p) => p.id === "google-old")!;
    expect(g).toMatchObject({
      latitude: 42,
      longitude: -42,
      geocode_source: "google",
      geocoded_at: NOW.toISOString(),
    });
    // The re-geocode answered from whichever provider is configured now.
    const { admin: a2 } = fakeAdmin({ properties: table });
    expect((await selectDueGooglePins(a2, NOW)).rows).toEqual([]);
  });

  it("records the new source when the refresh came from somebody else", async () => {
    const table = pins();
    const { admin } = fakeAdmin({ properties: table });
    await refreshGooglePins(admin, { now: () => NOW, geocode: async () => found(9, "nominatim") });
    expect(table.find((p) => p.id === "places-old")).toMatchObject({
      latitude: 9,
      geocode_source: "nominatim",
    });
  });

  const CLEARED = { latitude: null, longitude: null, geocode_source: null, geocoded_at: null };

  it("clears a due pin when a provider answers that there is no match", async () => {
    const table = pins();
    const { admin } = fakeAdmin({ properties: table });
    const r = await refreshGooglePins(admin, {
      now: () => NOW,
      geocode: async () => ({ point: null, source: null }),
    });
    expect(r).toMatchObject({ pinsCleared: 2, pinsRefreshed: 0, pinsRetrying: 0 });
    for (const id of ["google-old", "places-old"]) {
      expect(table.find((p) => p.id === id)).toMatchObject(CLEARED);
    }
  });

  // Product review 5828450331: the first version cleared on ANY failure, so
  // one typo in GEOCODING_PROVIDER, or a Google outage on the 07:23 run,
  // would have blanked every due pin that morning.
  it("keeps a due pin under 30 days and retries it tomorrow when nobody answered", async () => {
    const table = pins();
    // 25 days old: due (22+) but inside the 29-day removal age.
    Object.assign(
      table.find((p) => p.id === "places-old")!,
      { geocoded_at: daysAgo(25) },
    );
    const before = { ...table.find((p) => p.id === "places-old")! };
    const { admin } = fakeAdmin({ properties: table });
    let n = 0;
    const r = await refreshGooglePins(admin, {
      now: () => NOW,
      geocode: async () => {
        // An invalid setting, then a thrown outage.
        if (n++ === 0) return { point: null, source: null, failed: true };
        throw new Error("Google said OVER_QUERY_LIMIT");
      },
    });
    expect(table.find((p) => p.id === "places-old")).toEqual(before);
    expect(r.pinsRetrying).toBe(1);
  });

  // Product review 5829303569: the grace used to run 7 days PAST the 30.
  it("clears a pin at 30 days even while the geocoder is failing -- never kept past 30", async () => {
    const table = pins();
    const { admin } = fakeAdmin({ properties: table });
    const r = await refreshGooglePins(admin, {
      now: () => NOW,
      geocode: async () => ({ point: null, source: null, failed: true }),
    });
    // google-old is 40 days old and places-old 31: both past the limit.
    expect(table.find((p) => p.id === "google-old")).toMatchObject(CLEARED);
    expect(table.find((p) => p.id === "places-old")).toMatchObject(CLEARED);
    expect(r).toMatchObject({ pinsCleared: 2, pinsRetrying: 0 });
  });

  // Product review 5830897980: with the limit AT 30 and a daily run, a value
  // written one second after a run is 29d 23:59:59 at the day-30 run and
  // survived to the day-31 run. The day-30 run must remove it.
  it("a pin and a road leg written one second after a run are gone at the run 30 days later", async () => {
    const justAfterARun = new Date(NOW.getTime() - (30 * 86_400_000 - 1_000)).toISOString();
    const table = pins();
    Object.assign(
      table.find((p) => p.id === "google-new")!,
      { geocoded_at: justAfterARun },
    );
    const legs: Row[] = [{ id: "g-edge", source: "google", fetched_at: justAfterARun }];
    const { admin } = fakeAdmin({ properties: table, road_legs: legs });
    await expireGoogleDerivedData(admin, {
      now: () => NOW,
      geocode: async () => ({ point: null, source: null, failed: true }),
    });
    expect(table.find((p) => p.id === "google-new")).toMatchObject(CLEARED);
    expect(legs).toEqual([]);
  });

  it("selects a 24-day Google pin for refresh, and refreshes it when the geocoder answers", async () => {
    const table = pins();
    Object.assign(
      table.find((p) => p.id === "google-new")!,
      { geocoded_at: daysAgo(24) },
    );
    const { admin } = fakeAdmin({ properties: table });
    const r = await refreshGooglePins(admin, { now: () => NOW, geocode: async () => found(7) });
    expect(r.pinsRefreshed).toBe(3);
    expect(table.find((p) => p.id === "google-new")).toMatchObject({
      latitude: 7,
      geocoded_at: NOW.toISOString(),
    });
  });

  it("never touches a newer Google pin or a pin from any other source", async () => {
    const table = pins();
    const before = new Map(table.map((p) => [p.id, { ...p }]));
    const { admin, writes } = fakeAdmin({ properties: table });
    await refreshGooglePins(admin, {
      now: () => NOW,
      geocode: async () => ({ point: null, source: null }),
    });
    for (const id of ["google-new", "geocodio-old", "nominatim-old", "manual-old", "unknown-old"]) {
      expect(table.find((p) => p.id === id)).toEqual(before.get(id));
    }
    expect(writes.flatMap((w) => w.ids).sort()).toEqual(["google-old", "places-old"]);
  });

  it("leaves a pin alone when somebody changed it while the job ran", async () => {
    const table = pins();
    const { admin } = fakeAdmin({ properties: table });
    const r = await refreshGooglePins(admin, {
      now: () => NOW,
      geocode: async () => {
        // An office user re-picks the address mid-run.
        Object.assign(
          table.find((p) => p.id === "google-old")!,
          {
            latitude: 50,
            geocode_source: "google_places",
            geocoded_at: NOW.toISOString(),
          },
        );
        return { point: null, source: null };
      },
    });
    expect(table.find((p) => p.id === "google-old")).toMatchObject({ latitude: 50 });
    expect(r.pinsSkipped).toBeGreaterThanOrEqual(1);
  });

  it("stops at its time budget and leaves the rest due for tomorrow", async () => {
    const table = pins();
    const { admin } = fakeAdmin({ properties: table });
    let t = NOW.getTime();
    const r = await refreshGooglePins(admin, {
      now: () => new Date(t),
      budgetMs: 1_000,
      geocode: async () => {
        t += 1_500;
        return found(1);
      },
    });
    expect(r).toMatchObject({ pinsDue: 2, pinsRefreshed: 1, pinsDeferred: 1 });
  });
});

describe("the daily run", () => {
  it("purges legs and refreshes pins in one call, and reports counts only", async () => {
    const legs: Row[] = [
      { id: "g-old", source: "google", fetched_at: daysAgo(31) },
      { id: "osrm-old", source: "osrm", fetched_at: daysAgo(31) },
    ];
    const { admin } = fakeAdmin({ road_legs: legs, properties: pins() });
    const s = await expireGoogleDerivedData(admin, {
      now: () => NOW,
      geocode: async () => found(1),
    });
    expect(s).toEqual({
      cutoff: daysAgo(29),
      roadLegsDeleted: 1,
      pinsDue: 2,
      pinsRefreshed: 2,
      pinsCleared: 0,
      pinsSkipped: 0,
      pinsRetrying: 0,
      pinsDeferred: 0,
      errors: [],
    });
  });
});

// ── Where a browser-sent pin came from ──────────────────────────────────────

describe("a pin the browser sends", () => {
  it("keeps the label the server gave it", () => {
    expect(inferClientPointSource("nominatim", "manual")).toBe("nominatim");
    expect(inferClientPointSource("google", "manual")).toBe("google");
  });

  it("is Google Places when it came from the address search box with no label", () => {
    expect(inferClientPointSource(undefined, "matched")).toBe("google_places");
  });

  it("is unknown -- and so never expired -- otherwise", () => {
    expect(inferClientPointSource(undefined, "manual")).toBeNull();
    expect(inferClientPointSource("not-a-source", undefined)).toBeNull();
  });
});

// ── The wiring ──────────────────────────────────────────────────────────────

describe("the wiring", () => {
  const migrations = readdirSync(join(root, "supabase/migrations")).sort();
  const COLUMNS = "20261109200000_a-pin-knows-who-placed-it.sql";
  const SCHEDULE = "20261109200100_google-derived-data-is-kept-thirty-days.sql";

  it("the provenance columns, their grant and the schedule are new migrations", () => {
    expect(migrations).toContain(COLUMNS);
    expect(migrations).toContain(SCHEDULE);
    const cols = readFileSync(join(root, "supabase/migrations", COLUMNS), "utf8");
    expect(cols).toMatch(/ADD COLUMN IF NOT EXISTS geocode_source text/);
    expect(cols).toMatch(/ADD COLUMN IF NOT EXISTS geocoded_at timestamptz/);
    expect(cols).toMatch(
      /GRANT SELECT \(geocode_source, geocoded_at\) ON TABLE public\.properties TO authenticated/,
    );
    // The CHECK list and the TypeScript list are one list.
    for (const s of ["google", "google_places", "geocodio", "nominatim", "manual"]) {
      expect(cols).toContain(`'${s}'`);
    }
  });

  it("the daily job is scheduled, and only warns about itself", () => {
    const sql = readFileSync(join(root, "supabase/migrations", SCHEDULE), "utf8");
    expect(sql).toMatch(/cron\.schedule\('google-cache-expiry', '23 7 \* \* \*'/);
    expect(sql).toContain("/api/public/hooks/google-cache-expiry");
    expect(sql).toContain("cron_service_role_key");
    expect(sql).not.toMatch(/RAISE EXCEPTION/);
  });

  it("the endpoint refuses a caller without the cron credential", () => {
    const src = readFileSync(
      join(root, "src/routes/api/public/hooks/google-cache-expiry.ts"),
      "utf8",
    );
    expect(src).toMatch(/authorizeCronRequest\(request\)/);
    expect(src).toMatch(/if \(!auth\.ok\) return cronUnauthorized/);
  });
});

// ── "Nobody answered" is reported, not mistaken for "no match" ──────────────

describe("the geocoder says when nobody answered", () => {
  it("an invalid GEOCODING_PROVIDER is failed, not a miss", async () => {
    const { vi } = await import("vitest");
    vi.stubEnv("GEOCODING_PROVIDER", "gogle");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const { geocodeAddressSourced } = await import("@/lib/geocode.server");
      const r = await geocodeAddressSourced({ street: "1 Main St", city: "Detroit" });
      expect(r).toEqual({ point: null, source: null, failed: true });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });
});
