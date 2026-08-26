// The technician with no start address gets MORE of the day, not less.
//
// ── THE MEASUREMENT THIS IS BUILT ON ─────────────────────────────────────
//
// staff_start_point falls back for somebody with no start address, and its
// last tier is one of THEIR OWN stops. So their route begins at their work and
// costs nothing to reach. Measured against the demo day, three technicians,
// 21 stops:
//
//   Sam    has address    6 stops   206.6 min drive   107.6 min to first stop
//   Taylor has address    7 stops   200.4 min drive    27.9 min to first stop
//   Jordan NO address     8 stops   139.3 min drive     6.0 min to first stop
//
// The balancer evens out MEASURED minutes, drive included. A day built on a
// commute of zero looks cheap, so it attracts more work: the person with no
// address took 8 stops, the one with the longest real commute took 6.
//
// That is worth telling a dispatcher, and it is worth telling them accurately.
// The obvious phrasing -- "routes would be better if they had an address" --
// is misleading in the direction that matters: adding it usually makes that
// person's measured day LONGER, because a drive they were already doing
// finally appears in the numbers. The plan gets more honest, not shorter.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const panel = read("src/components/routes/AutoRoutingPanel.tsx");
const listStaff = read("src/lib/visits.functions.ts");

describe("the panel says who has no start address", () => {
  it("flags only the people this run will actually route", () => {
    // Not every technician on the org -- the ones chosen. A notice about
    // somebody who is not in the run is noise the dispatcher cannot act on.
    expect(panel).toMatch(/const noStart = techs\.filter\(/);
    expect(panel).toMatch(/chosen\.includes\(s\.id\)/);
    expect(panel).toMatch(/s\.start_latitude == null \|\| s\.start_longitude == null/);
  });

  it("says what is true, and does not promise a shorter day", () => {
    const flat = panel.replace(/\s+/g, " ");
    expect(flat).toMatch(/has no start address|technicians have no start address/);
    expect(flat).toMatch(/planned from their own first stop/);
    expect(flat).toMatch(/more of the day than they can really fit/);
    // The claim that would be wrong. Adding an address lengthens the measured
    // day; anything promising a shorter or faster route is a lie the numbers
    // above disprove.
    expect(
      /routes would be (better|faster|shorter)/i.test(flat),
      "the notice promises a better route, which the measurement contradicts",
    ).toBe(false);
  });

  it("is rendered before the buttons, not after the run", () => {
    // A toast after Apply is too late to change the decision, and this is a
    // decision -- whether to fix the address first or route anyway.
    const noticeAt = panel.indexOf("has no start address");
    const footerAt = panel.indexOf('<Button variant="ghost" size="sm" onClick={onClose}');
    expect(noticeAt).toBeGreaterThan(-1);
    expect(noticeAt).toBeLessThan(footerAt);
  });
});

describe("and the data it needs actually reaches it", () => {
  it("listStaff selects the start coordinates", () => {
    // Without these the notice fires for EVERYBODY, because `undefined == null`
    // is true. A silent inversion: the warning would appear on a fully
    // configured team and be ignored from then on.
    // Scoped to listStaff itself: this file has several .select() calls and a
    // match against any of them would pass while the one the panel reads had
    // dropped the column.
    const from = listStaff.indexOf("export const listStaff");
    expect(from, "listStaff is gone or renamed").toBeGreaterThan(-1);
    const next = listStaff.indexOf("export const", from + 10);
    const block = listStaff.slice(from, next === -1 ? undefined : next);
    expect(block, "listStaff no longer returns start_latitude").toMatch(/start_latitude/);
    expect(block, "listStaff no longer returns start_longitude").toMatch(/start_longitude/);
  });
});
