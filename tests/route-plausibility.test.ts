import { describe, expect, it } from "vitest";
import { findRouteWarnings, DEFAULT_MAX_DRIVE_MINUTES } from "@/lib/route-plausibility";

describe("findRouteWarnings (finding #10)", () => {
  // The stored figure is still 1854.2 km — only the sentence changed units.
  // 1854.2 km is 1152 miles, and the dispatcher reading this warning measures
  // their patch in miles.
  it("flags the 1,152 mile / 3,708 min repro as an excessive drive", () => {
    const w = findRouteWarnings([
      {
        id: "v1",
        clientName: "Far Away Co",
        travel_km: 1854.2,
        travel_min: 3708,
        scheduled_on: "2026-07-08",
      },
    ]);
    expect(w).toHaveLength(1);
    expect(w[0].reason).toBe("excessive_drive");
    expect(w[0].message).toMatch(/1152 mi/);
    // The unit is spelled out, not implied. "1152" alone is the bug this
    // replaces, one order of magnitude quieter.
    expect(w[0].message).not.toMatch(/\bkm\b/);
  });

  it("passes a normal in-town stop", () => {
    const w = findRouteWarnings([
      { id: "v1", clientName: "Local", travel_km: 8, travel_min: 14, scheduled_on: "2026-07-08" },
    ]);
    expect(w).toHaveLength(0);
  });

  it("respects a configured lower threshold", () => {
    const stop = {
      id: "v1",
      clientName: "X",
      travel_km: 60,
      travel_min: 90,
      scheduled_on: "2026-07-08",
    };
    expect(findRouteWarnings([stop])).toHaveLength(0); // under the 240-min default
    expect(findRouteWarnings([stop], { maxDriveMinutes: 60 })).toHaveLength(1);
  });

  it("flags an ETA that is earlier than the drive time allows", () => {
    // 3,708-min drive but a same-day 05:48 PM ETA (≈586 min into the day).
    const w = findRouteWarnings([
      {
        id: "v1",
        clientName: "Impossible",
        travel_km: 1854,
        travel_min: 3708,
        eta_start: "2026-07-08T17:48:00",
        scheduled_on: "2026-07-08",
      },
    ]);
    // Excessive-drive fires first (one warning per stop), which already covers it.
    expect(w).toHaveLength(1);
    expect(w[0].visitId).toBe("v1");
  });

  it("flags eta inconsistency when the drive is under the distance limit", () => {
    // 120-min drive from an 08:00 workday start can't arrive before 10:00.
    // An 08:30 ETA is impossible → flagged (drive is under the 240-min limit).
    const w = findRouteWarnings([
      {
        id: "v2",
        clientName: "Early Bird",
        travel_km: 80,
        travel_min: 120,
        eta_start: "2026-07-08T08:30:00",
        scheduled_on: "2026-07-08",
      },
    ]);
    expect(w).toHaveLength(1);
    expect(w[0].reason).toBe("eta_inconsistent");
  });

  it("does not flag a legitimate later stop with a short drive", () => {
    // A 3pm stop with a 20-min drive is plainly fine (lots of elapsed time).
    const w = findRouteWarnings([
      {
        id: "v3",
        clientName: "Afternoon",
        travel_km: 12,
        travel_min: 20,
        eta_start: "2026-07-08T15:00:00",
        scheduled_on: "2026-07-08",
      },
    ]);
    expect(w).toHaveLength(0);
  });

  it("exposes a sane default threshold", () => {
    expect(DEFAULT_MAX_DRIVE_MINUTES).toBe(240);
  });
});
