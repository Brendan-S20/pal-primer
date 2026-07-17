import { describe, expect, it } from "vitest";
import {
  zonedTimeToUtc,
  workdayStartInstant,
  DEFAULT_TIMEZONE,
  DEFAULT_WORKDAY_START,
} from "@/lib/route-window";

// QA round 3, finding B6 part 2 (I13 #9): route windows/ETAs must anchor at the
// org's LOCAL workday start, in the org's timezone — not at 08:00 UTC, which
// renders as 3-4 AM in US timezones (the "route ends 04:24 AM / ETA 04:00 AM"
// bug). optimize_route_v2 does `(day + workday_start) AT TIME ZONE org.timezone`
// in SQL; these tests lock the same contract.

/** What local hour does this instant show in the given zone? */
function localHour(instant: Date, timeZone: string): number {
  const h = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    hour12: false,
  }).format(instant);
  return Number(h) % 24;
}

describe("zonedTimeToUtc (workday anchoring)", () => {
  it("anchors an 08:00 Central workday start at 13:00 UTC in summer (CDT)", () => {
    const inst = zonedTimeToUtc("2026-07-22", "08:00", "America/Chicago");
    expect(inst.toISOString()).toBe("2026-07-22T13:00:00.000Z");
    // The bug stored 08:00 UTC; the fix must NOT.
    expect(inst.getUTCHours()).not.toBe(8);
  });

  it("respects DST: 08:00 Central in winter (CST) is 14:00 UTC", () => {
    const inst = zonedTimeToUtc("2026-01-15", "08:00", "America/Chicago");
    expect(inst.toISOString()).toBe("2026-01-15T14:00:00.000Z");
  });

  it("anchors an 08:00 Eastern workday start at 12:00 UTC in summer (EDT)", () => {
    const inst = zonedTimeToUtc("2026-07-22", "08:00", "America/New_York");
    expect(inst.toISOString()).toBe("2026-07-22T12:00:00.000Z");
  });

  it("round-trips to the same local wall clock in every US zone (never 3-4 AM)", () => {
    for (const tz of [
      "America/New_York",
      "America/Chicago",
      "America/Denver",
      "America/Los_Angeles",
    ]) {
      const inst = zonedTimeToUtc("2026-07-22", "08:00", tz);
      expect(localHour(inst, tz)).toBe(8);
    }
  });

  it("handles the workday end too", () => {
    const inst = zonedTimeToUtc("2026-07-22", "17:00", "America/Chicago");
    expect(inst.toISOString()).toBe("2026-07-22T22:00:00.000Z");
    expect(localHour(inst, "America/Chicago")).toBe(17);
  });
});

describe("workdayStartInstant defaults", () => {
  it("exposes sane defaults (Central, 08:00, 17:00)", () => {
    expect(DEFAULT_TIMEZONE).toBe("America/Chicago");
    expect(DEFAULT_WORKDAY_START).toBe("08:00");
  });

  it("tolerates a Postgres time string with seconds", () => {
    const inst = workdayStartInstant("2026-07-22", "08:00:00", "America/Chicago");
    expect(inst.toISOString()).toBe("2026-07-22T13:00:00.000Z");
  });

  it("falls back to the Central default when no zone is given", () => {
    const inst = workdayStartInstant("2026-07-22");
    expect(localHour(inst, DEFAULT_TIMEZONE)).toBe(8);
  });
});
