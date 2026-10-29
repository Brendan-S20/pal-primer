import { describe, expect, it } from "vitest";
import {
  drawnZoneZips,
  leadServiceArea,
  zipFromLocation,
  zoneShape,
  type DrawnZoneZips,
} from "@/lib/lead-service-area";

const michigan = [
  { id: "a", zip_codes: ["48104", "48105"], geo_match_mode: "zip" },
  { id: "b", zip_codes: [], postal_prefix: "481", geo_match_mode: "zip" },
];

describe("zipFromLocation", () => {
  it("takes the ZIP after the street number", () => {
    expect(zipFromLocation("12345 Main St, New York NY 10001")).toBe("10001");
  });
  it("reads a bare ZIP and a ZIP+4", () => {
    expect(zipFromLocation("10024")).toBe("10024");
    expect(zipFromLocation("Ann Arbor MI 48104-1234")).toBe("48104");
  });
  it("does not read a five-digit house number as the ZIP", () => {
    expect(zipFromLocation("26000 Woodward Ave, Royal Oak")).toBeNull();
    expect(zipFromLocation("26000 Woodward Ave, Royal Oak MI 48067")).toBe("48067");
    expect(zipFromLocation("26000 Woodward Ave, Royal Oak, MI 48067, USA")).toBe("48067");
    expect(zipFromLocation("MI 48067, 26000 Woodward Ave")).toBe("48067");
    expect(leadServiceArea("26000 Woodward Ave, Royal Oak", michigan)).toBe("unknown");
  });
  it("is null when there is no ZIP", () => {
    expect(zipFromLocation("Ann Arbor")).toBeNull();
    expect(zipFromLocation(null)).toBeNull();
  });
});

describe("leadServiceArea (#439)", () => {
  it("flags the New York ZIPs the audit found against Michigan zones", () => {
    for (const zip of ["10001", "10003", "10024"]) {
      expect(leadServiceArea(`1 Broadway, New York NY ${zip}`, michigan)).toBe("outside");
    }
  });
  it("accepts a listed ZIP and a ZIP under a listed prefix", () => {
    expect(leadServiceArea("48104", michigan)).toBe("inside");
    expect(leadServiceArea("Ypsilanti MI 48197", michigan)).toBe("inside");
  });
  it("does not guess when the text has no ZIP or there are no zones", () => {
    expect(leadServiceArea("New York", michigan)).toBe("unknown");
    expect(leadServiceArea("10001", [])).toBe("unknown");
  });
  it("does not guess when a drawn zone's shape was never looked up", () => {
    const withRadius = [
      ...michigan,
      {
        id: "r",
        zip_codes: [],
        geo_match_mode: "radius",
        center_latitude: 42.49,
        center_longitude: -83.14,
        radius_meters: 5000,
      },
    ];
    expect(leadServiceArea("10001", withRadius)).toBe("unknown");
  });
});

// The live demo org, as Product read it on 2026-10-29: a main zone listing
// ZIPs, and zones drawn on the map (polygons and radii) listing none. Asked
// by ZIP alone, the drawn zones could never say no, and every lead read
// "unknown". With the shapes asked through each ZIP's Census center, a New
// York ZIP is outside every zone and a Royal Oak ZIP is inside the circle.
describe("leadServiceArea with zones drawn on the map (#439, live demo shape)", () => {
  const main = { id: "main", zip_codes: ["48009", "48015", "48017"], geo_match_mode: "zip" };
  const royalOakCircle = {
    id: "circle",
    zip_codes: [],
    geo_match_mode: "radius",
    center_latitude: 42.4895,
    center_longitude: -83.1446,
    radius_meters: 4000,
  };
  const berkleyBox = {
    id: "box",
    zip_codes: [],
    geo_match_mode: "polygon",
    boundary: {
      coordinates: [
        [
          [-83.2, 42.49],
          [-83.17, 42.49],
          [-83.17, 42.51],
          [-83.2, 42.51],
          [-83.2, 42.49],
        ],
      ],
    },
  };
  const zones = [main, royalOakCircle, berkleyBox];
  // Census centers near the shapes, as zip_centroids_in_box returns them.
  const near = [
    { zip: "48067", lat: 42.4895, lng: -83.1446, radiusM: 3000 }, // Royal Oak, in the circle
    { zip: "48072", lat: 42.4997, lng: -83.1857, radiusM: 2000 }, // Berkley, in the box
    { zip: "48073", lat: 42.53, lng: -83.14, radiusM: 4000 }, // just past both: edge
  ];
  const drawn = new Map<string, DrawnZoneZips | null>(
    [royalOakCircle, berkleyBox].map((z) => [z.id, drawnZoneZips(zoneShape(z)!, near, false)]),
  );

  it("calls the audit's New York ZIPs outside", () => {
    for (const zip of ["10001", "10003", "10024"]) {
      expect(leadServiceArea(`1 Broadway, New York NY ${zip}`, zones, drawn)).toBe("outside");
    }
  });
  it("keeps a ZIP the main zone lists, or a drawn shape holds, inside", () => {
    expect(leadServiceArea("48009", zones, drawn)).toBe("inside");
    expect(leadServiceArea("Royal Oak MI 48067", zones, drawn)).toBe("inside");
    expect(leadServiceArea("Berkley MI 48072", zones, drawn)).toBe("inside");
  });
  it("does not call an edge ZIP outside", () => {
    expect(leadServiceArea("48073", zones, drawn)).toBe("unknown");
  });
  it("does not call anything outside when a lookup failed or hit its cap", () => {
    const failed = new Map(drawn).set("circle", null);
    expect(leadServiceArea("10001", zones, failed)).toBe("unknown");
    const capped = new Map(drawn).set(
      "circle",
      drawnZoneZips(zoneShape(royalOakCircle)!, near, true),
    );
    expect(leadServiceArea("10001", zones, capped)).toBe("unknown");
  });
  it("treats a zone with no usable shape as ZIP-only", () => {
    expect(zoneShape(main)).toBeNull();
    expect(zoneShape({ id: "half", geo_match_mode: "radius", radius_meters: 4000 })).toBeNull();
  });
});
