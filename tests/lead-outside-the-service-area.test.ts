import { describe, expect, it } from "vitest";
import { leadServiceArea, zipFromLocation } from "@/lib/lead-service-area";

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
  it("does not guess when a zone is drawn on a map with no ZIPs listed", () => {
    const withRadius = [
      ...michigan,
      { id: "r", zip_codes: [], geo_match_mode: "radius", radius_meters: 8000 },
    ];
    expect(leadServiceArea("10001", withRadius)).toBe("unknown");
  });
});
