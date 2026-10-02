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

  // Found by the routing trials (scripts/routing-trials): the offset was read
  // once, at the wall-clock time taken as UTC, which in US zones is hours
  // before the real instant -- so on the two days a year the clocks change it
  // read the offset from the wrong side of the 2 AM transition. The planner's
  // `AT TIME ZONE` was right both days; this TypeScript twin was an hour off.
  it("is right on the fall-back Sunday, when 08:00 is PST again", () => {
    const inst = zonedTimeToUtc("2026-11-01", "08:00", "America/Los_Angeles");
    expect(inst.toISOString()).toBe("2026-11-01T16:00:00.000Z");
    expect(localHour(inst, "America/Los_Angeles")).toBe(8);
  });

  it("is right on the spring-forward Sunday, when 07:30 is already PDT", () => {
    const inst = zonedTimeToUtc("2026-03-08", "07:30", "America/Los_Angeles");
    expect(inst.toISOString()).toBe("2026-03-08T14:30:00.000Z");
  });

  it("is right in every US zone on both change days, Arizona and Hawaii included", () => {
    for (const tz of [
      "America/New_York",
      "America/Chicago",
      "America/Denver",
      "America/Phoenix",
      "America/Los_Angeles",
      "America/Anchorage",
      "Pacific/Honolulu",
    ]) {
      for (const day of ["2026-03-08", "2026-11-01"]) {
        for (const at of ["06:00", "08:00", "12:00", "17:00"]) {
          const inst = zonedTimeToUtc(day, at, tz);
          expect(localHour(inst, tz), `${tz} ${day} ${at}`).toBe(Number(at.slice(0, 2)));
        }
      }
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
