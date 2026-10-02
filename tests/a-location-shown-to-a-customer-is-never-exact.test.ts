// A location shown to a customer is never exact.
//
// The live map on /track/<token> shows where the tech is, to a customer who
// holds a link that can be forwarded to anyone. So what it shows is a cell
// about 100 m across, never a fix: the database rounds to 3 decimal places
// inside public_visit_tracking, so the exact position never leaves it, and
// the app rounds again (approximatePosition), so a change to the SQL can
// never widen what the page draws.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { approximatePosition, publicTrackingView, PUBLIC_POSITION_DECIMALS } from "@/lib/live-tracking";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** Metres between two positions, on a sphere. Good to well under a metre at
 *  these distances. */
function metres(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const decimals = (x: number) => (String(x).split(".")[1] ?? "").length;

describe("approximatePosition", () => {
  it("rounds to three decimal places, about 100 m", () => {
    expect(PUBLIC_POSITION_DECIMALS).toBe(3);
    expect(approximatePosition({ lat: 41.9104567, lng: -87.6498765 })).toEqual({
      lat: 41.91,
      lng: -87.65,
    });
    expect(approximatePosition({ lat: 41.921734, lng: -87.648321 })).toEqual({
      lat: 41.922,
      lng: -87.648,
    });
  });

  it("never returns more precision than the cell, anywhere on earth", () => {
    // A deterministic walk over the globe, not Math.random: a failure here
    // has to be reproducible.
    let seed = 7;
    const next = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 5000; i++) {
      const p = { lat: next() * 170 - 85, lng: next() * 358 - 179 };
      const a = approximatePosition(p);
      expect(decimals(a.lat), `${p.lat} -> ${a.lat}`).toBeLessThanOrEqual(3);
      expect(decimals(a.lng), `${p.lng} -> ${a.lng}`).toBeLessThanOrEqual(3);
      // Never further than half a cell's diagonal from the truth, and so
      // never useless as an ETA...
      expect(metres(p, a)).toBeLessThan(80);
    }
  });

  it("puts every fix in the same cell at the same point, so none can be recovered", () => {
    const cell = new Set<string>();
    for (let dLat = 0; dLat < 10; dLat++) {
      for (let dLng = 0; dLng < 10; dLng++) {
        const a = approximatePosition({
          lat: 41.9096 + dLat * 0.00008,
          lng: -87.6504 + dLng * 0.00008,
        });
        cell.add(`${a.lat},${a.lng}`);
      }
    }
    // A hundred distinct fixes spread over ~80 m by ~60 m, all inside one
    // 0.001 degree cell: one answer.
    expect([...cell]).toEqual(["41.91,-87.65"]);
  });

  it("rounds halves the way Postgres rounds numerics, away from zero", () => {
    // round(-87.6485::numeric, 3) is -87.649 in Postgres; Math.round alone
    // would give -87.648, and the page and the database would disagree.
    expect(approximatePosition({ lat: 0.0005, lng: -0.0005 })).toEqual({ lat: 0.001, lng: -0.001 });
    expect(approximatePosition({ lat: 41.9215, lng: -87.6485 })).toEqual({ lat: 41.922, lng: -87.649 });
    expect(Object.is(approximatePosition({ lat: -0.0001, lng: 0 }).lat, -0)).toBe(false);
  });
});

describe("what the page is handed", () => {
  const base = {
    status: "en_route" as const,
    business_name: "Acme Scoop",
    tech_first_name: "Sam",
    timezone: "America/Chicago",
    eta_start: null,
    eta_end: null,
    sharing: true,
    tech_lat: 41.9104567,
    tech_lng: -87.6498765,
    tech_recorded_at: "2026-09-29T15:00:00Z",
    home_lat: 41.921734,
    home_lng: -87.648321,
  };

  it("rounds again, even if the database ever stopped rounding", () => {
    const v = publicTrackingView(base);
    if (!v.found) throw new Error("not found");
    expect(v.tech).toEqual({ lat: 41.91, lng: -87.65, recordedAt: "2026-09-29T15:00:00Z" });
    expect(v.home).toEqual({ lat: 41.922, lng: -87.648 });
    expect(JSON.stringify(v)).not.toContain("41.9104567");
  });

  it("shows no position once the tech has arrived, or after", () => {
    for (const status of ["arrived", "done", "ended"] as const) {
      const v = publicTrackingView({ ...base, status });
      if (!v.found) throw new Error("not found");
      expect(v.tech, status).toBeNull();
      expect(v.home, status).toBeNull();
      expect(v.eta, status).toBeNull();
    }
  });

  it("shows no tech while sharing is off, and nothing for no document", () => {
    const v = publicTrackingView({ ...base, sharing: false });
    if (!v.found) throw new Error("not found");
    expect(v.tech).toBeNull();
    expect(publicTrackingView(null)).toEqual({ found: false });
  });

  it("is rounded in the database too, before it leaves", () => {
    const sql = read("supabase/migrations/20260929100000_nobody-could-see-the-truck-coming.sql");
    const fn = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.public_visit_tracking"));
    expect(fn).toMatch(/round\(l\.lat::numeric, 3\), round\(l\.lng::numeric, 3\)/);
    expect(fn).toMatch(/round\(p\.latitude::numeric, 3\), round\(p\.longitude::numeric, 3\)/);
    // And nowhere in what it returns is a raw column.
    const ret = fn.slice(fn.indexOf("RETURN jsonb_build_object(\n    'status', _status,\n    'business_name', _org.name,\n    'tech_first_name', _tech_name,\n    'timezone'"));
    expect(ret).not.toMatch(/l\.lat|l\.lng|p\.latitude|p\.longitude|accuracy/);
  });
});
