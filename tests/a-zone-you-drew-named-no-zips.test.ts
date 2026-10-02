// A zone you drew named no ZIPs.
//
// Owner, 2026-10-01: drawing a radius, drive time or polygon "does not auto
// insert all the zip codes that are within that. We need that to happen, due
// to many things relying on the zip codes." The signup page and the lead form
// quote through public_quote, which matches by ZIP alone, so a drawn zone with
// no ZIPs quoted nobody who arrived that way.
//
// What is pinned here:
//   1. The fill's "inside" IS the matcher's "inside" -- asked of matchZone,
//      not re-derived -- for radius, polygon and, especially, drive time.
//   2. Partly-overlapping ZIPs are offered, never added.
//   3. Changing the shape drops what only the old shape held and keeps what
//      the owner typed; a chip the owner removed stays removed.
//   4. The lookup is a member-gated function over a table no API role can
//      read, proved in a real Postgres when one is running.
//
// The real Census rows are read straight out of the data migration, so the
// geometry is checked against actual ZIP centers and not only against points
// invented to pass.

import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  addTyped,
  applyShapeFill,
  baselineFill,
  claimedElsewhere,
  classifyZipCentroids,
  EDGE_MAX_M,
  fillStatusText,
  IDLE_FILL,
  initialZipState,
  MAX_AUTO_ZIPS,
  removeZips,
  searchBox,
  shapeKey,
  zoneFromShape,
  type ZipCentroid,
} from "@/lib/zone-zip-fill";
import { DRIVE_M_PER_MIN, haversineMeters, matchZone } from "@/lib/zone-match";

// A proof waits its turn for the shared lock (the-proofs-take-turns.test.ts),
// so on a loaded runner one can take minutes without being hung.
vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
const SCHEMA = join(ROOT, "supabase/migrations/20261001120000_a-zone-you-drew-named-no-zips.sql");
const DATA = join(
  ROOT,
  "supabase/migrations/20261001120100_the-zip-centers-a-zone-is-filled-from.sql",
);
const PROOF = join(ROOT, "tests/sql/a-zone-you-drew-named-no-zips.proof.sql");
const DB_URL =
  process.env.WEBHOOKS_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

/** Every row the data migration loads, parsed the way the migration does. */
function censusRows(): ZipCentroid[] {
  const sql = readFileSync(DATA, "utf8");
  const body = sql.slice(sql.indexOf("$zcta$") + 6, sql.lastIndexOf("$zcta$"));
  return body
    .trim()
    .split("\n")
    .map((l) => {
      const [zip, lat, lng, r] = l.split(",");
      return { zip, lat: Number(lat), lng: Number(lng), radiusM: Number(r) };
    });
}

/** A point `m` metres (by the matcher's haversine) due east of `c`. */
const east = (c: { lat: number; lng: number }, m: number) => ({
  lat: c.lat,
  lng: c.lng + m / (((6_371_000 * Math.PI) / 180) * Math.cos((c.lat * Math.PI) / 180)),
});

const AUSTIN = { lat: 30.2706, lng: -97.7426 };

describe("inside is the matcher's inside", () => {
  it("there is one drive speed, and the map draws with it", () => {
    // Read, not imported: the map module pulls in Leaflet, which needs a window.
    const map = readFileSync(join(ROOT, "src/components/ZoneCoverageMap.tsx"), "utf8");
    expect(map).toMatch(/import \{ DRIVE_M_PER_MIN \} from "@\/lib\/zone-match";/);
    expect(map).not.toMatch(/DRIVE_M_PER_MIN\s*=/);
    expect(DRIVE_M_PER_MIN).toBe(800);
  });

  it("radius: centers inside are added, a ZIP straddling the line is offered, far ones are neither", () => {
    const shape = {
      mode: "radius",
      centerLat: AUSTIN.lat,
      centerLng: AUSTIN.lng,
      radiusMeters: 5000,
    };
    const r = classifyZipCentroids(shape, [
      { zip: "00001", ...east(AUSTIN, 1000), radiusM: 1500 },
      { zip: "00002", ...east(AUSTIN, 4900), radiusM: 1500 },
      { zip: "00003", ...east(AUSTIN, 6000), radiusM: 1500 }, // 1 km out, 1.5 km radius
      { zip: "00004", ...east(AUSTIN, 6000), radiusM: 500 }, // 1 km out, 0.5 km radius
      { zip: "00005", ...east(AUSTIN, 40000), radiusM: 50000 }, // huge rural ZIP, far out
    ]);
    expect(r.inside).toEqual(["00001", "00002"]);
    expect(r.edge).toEqual(["00003"]);
  });

  it("drive time: the fill is exactly the matcher's minutes x DRIVE_M_PER_MIN circle", () => {
    const minutes = 12;
    const shape = {
      mode: "drive_time",
      centerLat: AUSTIN.lat,
      centerLng: AUSTIN.lng,
      driveTimeMinutes: minutes,
    };
    const zone = zoneFromShape(shape)!;
    // Points either side of the boundary, ten metres apart.
    const reach = minutes * DRIVE_M_PER_MIN;
    const pts: ZipCentroid[] = [-5, 5].map((d, i) => ({
      zip: `9000${i}`,
      ...east(AUSTIN, reach + d),
      radiusM: 0,
    }));
    const r = classifyZipCentroids(shape, pts);
    for (const p of pts) {
      expect(r.inside.includes(p.zip), p.zip).toBe(!!matchZone([zone], { point: p }));
    }
    expect(r.inside).toEqual(["90000"]);
  });

  it("drive time and the equivalent radius fill the same ZIPs, on real Census centers", () => {
    const rows = censusRows();
    const drive = classifyZipCentroids(
      { mode: "drive_time", centerLat: AUSTIN.lat, centerLng: AUSTIN.lng, driveTimeMinutes: 15 },
      rows,
    );
    const radius = classifyZipCentroids(
      {
        mode: "radius",
        centerLat: AUSTIN.lat,
        centerLng: AUSTIN.lng,
        radiusMeters: 15 * DRIVE_M_PER_MIN,
      },
      rows,
    );
    expect(drive.inside).toEqual(radius.inside);
    expect(drive.inside.length).toBeGreaterThan(10);
  });

  it("on real Census centers, every ZIP added is one the matcher would put in the zone, and none it would is missed", () => {
    const rows = censusRows();
    expect(rows.length).toBe(33791);
    const shapes = [
      { mode: "radius", centerLat: AUSTIN.lat, centerLng: AUSTIN.lng, radiusMeters: 8047 },
      { mode: "drive_time", centerLat: 41.8781, centerLng: -87.6298, driveTimeMinutes: 20 },
      {
        mode: "polygon",
        polygon: {
          type: "Polygon",
          coordinates: [
            [
              [-97.8, 30.22],
              [-97.68, 30.22],
              [-97.7, 30.33],
              [-97.79, 30.31],
              [-97.8, 30.22],
            ],
          ],
        },
      },
    ];
    for (const shape of shapes) {
      const zone = zoneFromShape(shape)!;
      const r = classifyZipCentroids(shape, rows, 100_000);
      const expected = rows.filter((c) => matchZone([zone], { point: c })).map((c) => c.zip);
      expect([...r.inside].sort(), shape.mode).toEqual(expected.sort());
      expect(r.inside.length, shape.mode).toBeGreaterThan(3);
      // And no edge ZIP is also inside.
      expect(r.edge.filter((z) => r.inside.includes(z))).toEqual([]);
      // The database only ever sees the box. What the box holds must classify
      // exactly as the whole country does, or the prefilter lost a ZIP.
      const b = searchBox(shape)!;
      const boxed = rows.filter(
        (c) => c.lat >= b.south && c.lat <= b.north && c.lng >= b.west && c.lng <= b.east,
      );
      expect(classifyZipCentroids(shape, boxed, 100_000), shape.mode).toEqual(r);
    }
  });

  it("five miles round downtown Austin holds downtown and not the suburbs", () => {
    const r = classifyZipCentroids(
      { mode: "radius", centerLat: AUSTIN.lat, centerLng: AUSTIN.lng, radiusMeters: 8047 },
      censusRows(),
    );
    for (const zip of ["78701", "78702", "78703", "78705"]) expect(r.inside).toContain(zip);
    for (const zip of ["78660", "78613", "78664"]) {
      expect(r.inside).not.toContain(zip);
      expect(r.edge).not.toContain(zip);
    }
    expect(r.inside[0]).toBe("78701"); // nearest the middle first
  });

  it("polygon: inside by the matcher's ray cast; a center just outside an edge is offered", () => {
    const ring = [
      [-97.8, 30.2],
      [-97.7, 30.2],
      [-97.7, 30.3],
      [-97.8, 30.3],
      [-97.8, 30.2],
    ];
    const shape = { mode: "polygon", polygon: { type: "Polygon", coordinates: [ring] } };
    const r = classifyZipCentroids(shape, [
      { zip: "11111", lat: 30.25, lng: -97.75, radiusM: 1000 },
      { zip: "22222", lat: 30.25, lng: -97.695, radiusM: 1500 }, // ~480 m east of the edge
      { zip: "33333", lat: 30.25, lng: -97.6, radiusM: 1500 }, // ~9.6 km east
    ]);
    expect(r.inside).toEqual(["11111"]);
    expect(r.edge).toEqual(["22222"]);
  });

  it("a half-drawn shape asks for nothing", () => {
    expect(
      zoneFromShape({
        mode: "polygon",
        polygon: {
          coordinates: [
            [
              [0, 0],
              [1, 1],
            ],
          ],
        },
      }),
    ).toBeNull();
    expect(
      zoneFromShape({ mode: "radius", centerLat: null, centerLng: null, radiusMeters: 5000 }),
    ).toBeNull();
    expect(
      searchBox({ mode: "drive_time", centerLat: 30, centerLng: -97, driveTimeMinutes: null }),
    ).toBeNull();
    expect(shapeKey({ mode: "radius", centerLat: null, centerLng: 1, radiusMeters: 1 })).toBeNull();
  });

  it("the database box reaches the shape plus the widest edge margin", () => {
    const shape = {
      mode: "radius",
      centerLat: AUSTIN.lat,
      centerLng: AUSTIN.lng,
      radiusMeters: 10000,
    };
    const box = searchBox(shape)!;
    const reach = 10000 + EDGE_MAX_M;
    expect(haversineMeters(AUSTIN, { lat: box.north, lng: AUSTIN.lng })).toBeGreaterThanOrEqual(
      reach - 1,
    );
    expect(haversineMeters(AUSTIN, { lat: AUSTIN.lat, lng: box.east })).toBeGreaterThanOrEqual(
      reach - 1,
    );
  });

  it("a very large shape is capped, nearest first, and says so", () => {
    const pts: ZipCentroid[] = Array.from({ length: 30 }, (_, i) => ({
      zip: String(10000 + i),
      ...east(AUSTIN, (i + 1) * 100),
      radiusM: 0,
    }));
    const shape = {
      mode: "radius",
      centerLat: AUSTIN.lat,
      centerLng: AUSTIN.lng,
      radiusMeters: 50000,
    };
    const r = classifyZipCentroids(shape, pts, 10);
    expect(r.inside).toEqual(pts.slice(0, 10).map((p) => p.zip));
    expect(r.insideTotal).toBe(30);
    const text = fillStatusText(
      { ...IDLE_FILL, status: "done", insideTotal: MAX_AUTO_ZIPS + 240, added: MAX_AUTO_ZIPS },
      "the circle",
    );
    expect(text).toMatch(/holds 1,240 ZIPs, so only the 1,000 nearest the middle are used/);
  });
});

describe("where each chip came from", () => {
  it("a new zone fills from its first shape", () => {
    const r = applyShapeFill(initialZipState([]), ["78701", "78702"]);
    expect(r.state.zips).toEqual(["78701", "78702"]);
    expect(r.added).toEqual(["78701", "78702"]);
  });

  it("shrinking the shape drops what only the old shape held, and keeps what the owner typed", () => {
    let st = applyShapeFill(initialZipState([]), ["78701", "78702", "78703"]).state;
    st = addTyped(st, ["78759"]); // typed by hand, outside any shape
    st = addTyped(st, ["78703"]); // typed by hand, ALSO inside the shape
    const r = applyShapeFill(st, ["78701"]);
    expect(r.removed).toEqual(["78702"]);
    expect(r.state.zips).toEqual(["78701", "78703", "78759"]);
  });

  it("a chip the owner removed is not put back by the next fill, but is by an explicit one", () => {
    let st = applyShapeFill(initialZipState([]), ["78701", "78702"]).state;
    st = removeZips(st, ["78702"]);
    expect(applyShapeFill(st, ["78701", "78702", "78703"]).state.zips).toEqual(["78701", "78703"]);
    expect(applyShapeFill(st, ["78701", "78702"], { explicit: true }).state.zips).toEqual([
      "78701",
      "78702",
    ]);
  });

  it("an existing zone is not changed on open; its missing ZIPs are counted for the button", () => {
    const saved = ["78701", "78759"]; // 78759 is outside the saved shape: it was typed
    const { state, missing } = baselineFill(initialZipState(saved), ["78701", "78702"]);
    expect(state.zips).toEqual(saved);
    expect(missing).toEqual(["78702"]);
    // Moving the shape away later removes the shape's ZIP and never the typed one.
    const r = applyShapeFill(state, ["78745"]);
    expect(r.state.zips).toEqual(["78759", "78745"]);
  });

  it("before the saved shape is looked up, nothing saved can be removed", () => {
    const r = applyShapeFill(initialZipState(["78701"]), ["78745"]);
    expect(r.removed).toEqual([]);
    expect(r.state.zips).toEqual(["78701", "78745"]);
  });

  it("names the other zone that already lists a ZIP, and not this one", () => {
    const m = claimedElsewhere(
      ["78701", "78702", "78703"],
      [
        { id: "self", name: "This zone", zip_codes: ["78701"] },
        { id: "b", name: "East Side", zip_codes: ["78702"] },
      ],
      "self",
    );
    expect([...m.entries()]).toEqual([["78702", "East Side"]]);
  });
});

describe("the migrations", () => {
  const code = (p: string) =>
    readFileSync(p, "utf8")
      .split("\n")
      .filter((l) => !/^\s*--/.test(l))
      .join("\n");

  it("keep the table out of every API role's reach", () => {
    const sql = code(SCHEMA);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS reference\.zip_centroids/);
    expect(sql).not.toMatch(/CREATE TABLE[^;]*public\.zip_centroids/);
    expect(sql).toMatch(/REVOKE ALL ON SCHEMA reference FROM anon, authenticated;/);
    expect(sql).toMatch(/REVOKE ALL ON reference\.zip_centroids FROM anon, authenticated;/);
    expect(sql).not.toMatch(/GRANT[^;]*reference[^;]*TO[^;]*\b(anon|authenticated)\b/);
  });

  it("let a signed-in member in through one function, and nobody else", () => {
    const sql = code(SCHEMA);
    expect(sql).toMatch(/SECURITY DEFINER\s+SET search_path TO ''/);
    expect(sql).toMatch(
      /auth\.uid\(\) IS NULL OR NOT public\.is_org_member\(auth\.uid\(\), _org_id\)/,
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.zip_centroids_in_box\([^)]*\) FROM PUBLIC, anon;/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.zip_centroids_in_box\([^)]*\) TO authenticated, service_role;/,
    );
  });

  it("load the data idempotently and check what they loaded", () => {
    const sql = code(DATA);
    expect(sql).toMatch(/ON CONFLICT \(zip\) DO UPDATE/);
    expect(sql).not.toMatch(/\bDELETE\b|\bTRUNCATE\b/);
    expect(sql).toMatch(/IF _n < 33791 THEN/);
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
    timeout: 5_000,
  }).stdout?.trim() === "1";

if (!reachable) {
  console.warn(
    `\n  SKIPPED: the ZIP-fill proof did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set WEBHOOKS_PROOF_DB_URL to run it.\n",
  );
}

/** Run the proof, again if and only if Postgres chose it as a deadlock victim.
 *  Same reasoning as tests/the-demo-was-paid-next-week.test.ts: every proof
 *  applies migrations inside its own transaction, vitest runs files side by
 *  side, and a deadlock rolls the whole transaction back, so a retry starts
 *  clean. Any other failure is returned as it is. */
function runProof(args: string[]) {
  let r = spawnSync(psql!, args, { encoding: "utf8", timeout: 300_000 });
  for (let i = 0; i < 2 && /deadlock detected/.test(`${r.stdout}${r.stderr}`); i++) {
    r = spawnSync(psql!, args, { encoding: "utf8", timeout: 300_000 });
  }
  return r;
}

describe.skipIf(!reachable)("the ZIP lookup, in a real database", () => {
  it("has the files it runs", () => {
    for (const f of [SCHEMA, DATA, PROOF]) expect(existsSync(f), f).toBe(true);
  });

  it("answers a member, refuses everyone else, and loads twice to the same rows", () => {
    const r = runProof([DB_URL, "-X", "-v", `schema=${SCHEMA}`, "-v", `data=${DATA}`, "-f", PROOF]);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(7);
    expect(out).toMatch(/ALL ZIP-FILL PROOFS PASSED/);
  });
});
