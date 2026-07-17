import { describe, expect, it } from "vitest";
import {
  nextStationNumber,
  renumberStations,
  stationDisplayName,
  lastServicedByStation,
} from "@/lib/dna-linkage";

// I13 #20 — station numbering + per-station service history.
describe("station numbering (C1/G7)", () => {
  it("starts at 1 for a property with no stations (not 0)", () => {
    expect(nextStationNumber([])).toBe(1);
  });

  it("returns a stable integer sequence, never a padded string", () => {
    expect(nextStationNumber([1, 2, 3])).toBe(4);
    // Null / undefined historical rows are ignored, not concatenated.
    expect(nextStationNumber([1, null, 2, undefined])).toBe(3);
  });

  it("renumbers to a clean 1..n sequence preserving order", () => {
    const out = renumberStations([
      { sortOrder: 5, createdAt: "2026-01-03" },
      { sortOrder: 1, createdAt: "2026-01-01" },
      { sortOrder: 3, createdAt: "2026-01-02" },
    ]);
    expect(out.map((s) => s.stationNumber)).toEqual([1, 2, 3]);
    // The row that sorted first (sortOrder 1) becomes station 1.
    expect(out[0].sortOrder).toBe(1);
  });

  it("displays an integer station id, not the old '0'/'01' label", () => {
    expect(stationDisplayName(1, "Building A")).toBe("Station 1 · Building A");
    expect(stationDisplayName(2, null)).toBe("Station 2");
    expect(stationDisplayName(0, "North lot")).toBe("North lot");
  });
});

describe("per-station service history (last serviced)", () => {
  it("takes the most recent service date per station", () => {
    const last = lastServicedByStation([
      { wasteStationId: "s1", servicedAt: "2026-07-01" },
      { wasteStationId: "s1", servicedAt: "2026-07-15" },
      { wasteStationId: "s2", servicedAt: "2026-07-10" },
    ]);
    expect(last.s1).toBe("2026-07-15");
    expect(last.s2).toBe("2026-07-10");
  });

  it("reports nothing for a station that was never serviced", () => {
    const last = lastServicedByStation([]);
    expect(last.s1).toBeUndefined();
  });
});
