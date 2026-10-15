// QA row 31, 2026-10-15, /reports. The Tech productivity table carried
// `min-w-[720px]` inside a half-width card, so even at 1440px only two of
// its four columns showed, and at 390px only the names did. And every visit
// was counted under "No zone", because a visit copies its zone from the
// service with no fallback to the property's zone (#437).
//
// The table has no width floor now, its counts are right aligned, and below
// `sm` each tech is one stacked row. Zones fall back from the visit to its
// property's chosen zone, then to the one detected from the address.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NO_ZONE, reportZoneId } from "@/lib/report-zone";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** The Tech productivity card's markup, from its title to the next card. */
function techCard(): string {
  const src = read("src/routes/_authenticated/reports.tsx");
  const from = src.indexOf("<CardTitle>Tech productivity</CardTitle>");
  const to = src.indexOf("<CardTitle>Zone activity</CardTitle>");
  expect(from).toBeGreaterThan(0);
  expect(to).toBeGreaterThan(from);
  return src.slice(from, to).replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

describe("the Tech productivity table", () => {
  it("has no width floor, so the card is as wide as the card", () => {
    expect(techCard()).not.toMatch(/min-w-\[\d+px\]/);
  });

  it("right-aligns every count, header and cell, on one baseline", () => {
    const card = techCard();
    expect(card.match(/<th className="whitespace-nowrap ps-3 text-end font-medium">/g)).toHaveLength(3);
    expect(card.match(/<td className="ps-3 text-end tabular-nums">/g)).toHaveLength(3);
    // The name gives way with an ellipsis rather than widening the card.
    expect(card).toMatch(/<td className="w-full max-w-0 truncate py-1"/);
  });

  it("is stacked rows below sm, and the table from sm up", () => {
    const card = techCard();
    expect(card).toMatch(/data-tech-productivity="stacked" className="[^"]*\bsm:hidden\b/);
    expect(card).toMatch(/className="hidden w-full text-sm sm:table"/);
    // Each stacked row shows the counts, not only the name.
    for (const label of ["Completed", "Skipped", "Total"]) {
      expect(card).toContain(`<dt>${label}</dt>`);
    }
  });

  it("still scrolls inside its card if it ever has to, never the page", () => {
    // tests/wide-things-that-set-the-width-of-the-page.test.ts asks this of
    // every four-column table; said here too, because the floor is gone and
    // the container is now the only guard.
    expect(techCard()).toMatch(/<CardContent className="overflow-x-auto">/);
  });
});

describe("which zone a visit is counted under (#437)", () => {
  it("is the visit's own zone when it has one", () => {
    expect(reportZoneId({ zone_id: "z-visit", properties: { zone_id: "z-prop" } })).toBe("z-visit");
  });

  it("falls back to the property's chosen zone, then its detected one", () => {
    expect(reportZoneId({ zone_id: null, properties: { zone_id: "z-prop", auto_zone_id: "z-auto" } })).toBe(
      "z-prop",
    );
    expect(reportZoneId({ zone_id: null, properties: { zone_id: null, auto_zone_id: "z-auto" } })).toBe(
      "z-auto",
    );
  });

  it("is No zone only when none of the three exists", () => {
    expect(reportZoneId({ zone_id: null, properties: { zone_id: null, auto_zone_id: null } })).toBe(NO_ZONE);
    expect(reportZoneId({ zone_id: null, properties: null })).toBe(NO_ZONE);
    expect(reportZoneId({ zone_id: null })).toBe(NO_ZONE);
    expect(NO_ZONE).toBe("no_zone");
  });

  it("accepts the embed as a one-element array too", () => {
    expect(reportZoneId({ zone_id: null, properties: [{ zone_id: "z-prop" }] })).toBe("z-prop");
    expect(reportZoneId({ zone_id: null, properties: [] })).toBe(NO_ZONE);
  });

  it("is what getReports groups by, with the property's zones in its select", () => {
    const fn = read("src/lib/reports.functions.ts");
    expect(fn).toMatch(/properties\(zone_id, auto_zone_id\)"/);
    expect(fn).toMatch(/const zid = reportZoneId\(v\);/);
    expect(fn).not.toMatch(/v\.zone_id \?\? "no_zone"/);
    // The name lookup still leaves the sentinel out.
    expect(fn).toMatch(/x !== "no_zone"/);
  });
});
