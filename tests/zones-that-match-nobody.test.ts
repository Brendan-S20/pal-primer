import { describe, it, expect } from "vitest";
import {
  computeZoneCoverage,
  describeCoverageProblem,
  type CoverageProperty,
  type CoverageZone,
} from "@/lib/zone-coverage";

// The demo organization's real zones, copied from production on 2026-09-08.
// Both are scoped to New York; every one of its 110 active properties is in
// Michigan. That is the case this module exists to notice.
const NY_ZONES: CoverageZone[] = [
  {
    id: "z-west",
    name: "Westside Suburb",
    priority: 0,
    account_type: null,
    postal_prefix: null,
    zip_codes: ["10023", "10024"],
    geo_match_mode: "polygon",
    boundary: {
      coordinates: [
        [
          [-73.978, 40.777],
          [-73.9775, 40.777],
          [-73.9775, 40.7775],
          [-73.978, 40.7775],
          [-73.978, 40.777],
        ],
      ],
    },
    center_latitude: null,
    center_longitude: null,
    radius_meters: null,
    drive_time_minutes: null,
  },
  {
    id: "z-down",
    name: "Downtown Core",
    priority: 0,
    account_type: null,
    postal_prefix: null,
    zip_codes: ["10001", "10002", "10003"],
    geo_match_mode: "zip",
    boundary: null,
    center_latitude: null,
    center_longitude: null,
    radius_meters: null,
    drive_time_minutes: null,
  },
];

/** Real Michigan addresses from the demo organization. */
function michigan(over: Partial<CoverageProperty> = {}): CoverageProperty {
  return {
    id: "p1",
    postalCode: "48067",
    point: { lat: 42.4895, lng: -83.1446 },
    accountType: "residential",
    storedZoneId: null,
    ...over,
  };
}

function manhattan(over: Partial<CoverageProperty> = {}): CoverageProperty {
  return {
    id: "p-ny",
    postalCode: "10001",
    point: { lat: 40.7506, lng: -73.9971 },
    accountType: "residential",
    storedZoneId: null,
    ...over,
  };
}

describe("zones that match nobody", () => {
  it("reports zero coverage when every property is outside every zone", () => {
    const props = [
      michigan({ id: "a" }),
      michigan({ id: "b", postalCode: "48072", point: { lat: 42.5031, lng: -83.1838 } }),
      michigan({ id: "c", postalCode: "48237", point: { lat: 42.4595, lng: -83.1827 } }),
    ];
    const c = computeZoneCoverage(NY_ZONES, props);
    expect(c.covered).toBe(0);
    expect(c.uncovered).toBe(3);
    expect(c.perZone.every((z) => z.wouldMatch === 0)).toBe(true);
  });

  it("says so in one sentence, naming the scale", () => {
    const c = computeZoneCoverage(NY_ZONES, [michigan({ id: "a" }), michigan({ id: "b" })]);
    expect(describeCoverageProblem(c)).toContain("None of your 2 properties");
    expect(describeCoverageProblem(c)).toContain("applies to nobody");
  });

  it("counts a property that still carries a zone the rules would not give it", () => {
    // The 54 real rows: stored zone set, matcher says none.
    const c = computeZoneCoverage(NY_ZONES, [michigan({ storedZoneId: "z-west" })]);
    expect(c.rows[0].verdict).toBe("orphaned");
    expect(c.orphaned).toBe(1);
    expect(c.stale).toBe(1);
    expect(c.uncovered).toBe(1);
  });
});

describe("the three ways data and rules disagree", () => {
  it("orphaned: stored a zone, matcher says none", () => {
    const c = computeZoneCoverage(NY_ZONES, [michigan({ storedZoneId: "z-down" })]);
    expect(c.orphaned).toBe(1);
    expect(c.reassigned).toBe(0);
    expect(c.unassigned).toBe(0);
  });

  it("unassigned: stored nothing, matcher says a zone", () => {
    const c = computeZoneCoverage(NY_ZONES, [manhattan({ storedZoneId: null })]);
    expect(c.rows[0].matchedZoneId).toBe("z-down");
    expect(c.unassigned).toBe(1);
    expect(c.stale).toBe(1);
  });

  it("reassigned: stored one zone, matcher says a different one", () => {
    const c = computeZoneCoverage(NY_ZONES, [manhattan({ storedZoneId: "z-west" })]);
    expect(c.rows[0].matchedZoneId).toBe("z-down");
    expect(c.reassigned).toBe(1);
    expect(c.stale).toBe(1);
  });

  it("agrees: stored zone equals the matcher's answer", () => {
    const c = computeZoneCoverage(NY_ZONES, [manhattan({ storedZoneId: "z-down" })]);
    expect(c.rows[0].verdict).toBe("agrees");
    expect(c.stale).toBe(0);
  });

  it("treats both-null as consistent but still uncovered", () => {
    // The mutation this guards: calling a property with no stored zone and no
    // match "stale". It is not a disagreement -- data and rules say the same
    // thing -- and counting it as drift would report the healthy half of a
    // badly configured org as broken data.
    const c = computeZoneCoverage(NY_ZONES, [michigan({ storedZoneId: null })]);
    expect(c.rows[0].verdict).toBe("uncovered");
    expect(c.stale).toBe(0);
    expect(c.uncovered).toBe(1);
  });
});

describe("recomputing rather than trusting the stored answer", () => {
  it("finds the drift even when the row looks internally consistent", () => {
    // auto_zone_id would equal zone_id on all of these, so a check that
    // compared those two columns would report a clean bill of health. Only
    // running the matcher now finds it.
    const props = Array.from({ length: 5 }, (_, i) =>
      michigan({ id: `p${i}`, storedZoneId: "z-west" }),
    );
    const c = computeZoneCoverage(NY_ZONES, props);
    expect(c.orphaned).toBe(5);
    expect(c.covered).toBe(0);
  });
});

describe("per-zone counts", () => {
  it("names a zone that would win nothing", () => {
    const c = computeZoneCoverage(NY_ZONES, [manhattan()]);
    const west = c.perZone.find((z) => z.zoneId === "z-west");
    const down = c.perZone.find((z) => z.zoneId === "z-down");
    expect(down?.wouldMatch).toBe(1);
    expect(west?.wouldMatch).toBe(0);
    expect(describeCoverageProblem(c)).toContain("Westside Suburb matches no properties");
  });

  it("pluralizes rather than listing every dead zone", () => {
    const c = computeZoneCoverage(NY_ZONES, [
      manhattan({ storedZoneId: "z-down" }),
      // A third zone nobody is in, so two are dead.
      // (Westside is already dead against a Downtown-only property.)
    ]);
    const withThird = computeZoneCoverage(
      [...NY_ZONES, { ...NY_ZONES[1], id: "z-third", name: "Third", zip_codes: ["99999"] }],
      [manhattan({ storedZoneId: "z-down" })],
    );
    expect(describeCoverageProblem(c)).toContain("Westside Suburb matches no properties");
    expect(describeCoverageProblem(withThird)).toContain("2 zones match no properties");
  });
});

describe("when not to interrupt", () => {
  it("says nothing for an organization with no properties yet", () => {
    expect(describeCoverageProblem(computeZoneCoverage(NY_ZONES, []))).toBeNull();
  });

  it("says nothing for an organization with no zones yet", () => {
    expect(describeCoverageProblem(computeZoneCoverage([], [michigan()]))).toBeNull();
  });

  it("says nothing when everything agrees and every zone is used", () => {
    const c = computeZoneCoverage([NY_ZONES[1]], [manhattan({ storedZoneId: "z-down" })]);
    expect(describeCoverageProblem(c)).toBeNull();
  });
});
