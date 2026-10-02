import { describe, expect, it } from "vitest";
import { findRouteWarnings, DEFAULT_MAX_DRIVE_MINUTES } from "@/lib/route-plausibility";
import { zonedTimeToUtc } from "@/lib/route-window";

// The fixture org's declared zone, threaded to every call that carries an ETA.
// Stored ETAs are real instants now (the seed was the last naive writer, fixed
// in 20260919230000), so the fixtures build theirs the way production does —
// `zonedTimeToUtc(day, wall-clock, org zone)`, same as the viewport dataset —
// instead of local-naive strings, which parsed differently on every runner.
// Denver rather than the Chicago column default on purpose: an implementation
// that drops `opts.timezone` and falls back reads these wall clocks an hour
// later into the day, and the 09:55 case below goes green when it must flag.
const TZ = "America/Denver";
const at = (day: string, hhmm: string) => zonedTimeToUtc(day, hhmm, TZ).toISOString();

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
    // 3,708-min drive but a same-day 05:48 PM ETA (≈586 min into the org day).
    const w = findRouteWarnings(
      [
        {
          id: "v1",
          clientName: "Impossible",
          travel_km: 1854,
          travel_min: 3708,
          eta_start: at("2026-07-08", "17:48"),
          scheduled_on: "2026-07-08",
        },
      ],
      { timezone: TZ },
    );
    // Excessive-drive fires first (one warning per stop), which already covers it.
    expect(w).toHaveLength(1);
    expect(w[0].visitId).toBe("v1");
  });

  it("flags eta inconsistency when the drive is under the distance limit", () => {
    // 120-min drive from an 08:00 workday start can't arrive before 10:00.
    // A 09:55 ETA is five minutes short → flagged (drive is under the 240-min
    // limit). Five minutes on purpose: misread one zone EAST of the org — the
    // Chicago fallback, or any device-local reading from most of the country —
    // it becomes 10:55 and stops being a warning at all, so this case fails
    // for an implementation that measures on any clock but the org's.
    const w = findRouteWarnings(
      [
        {
          id: "v2",
          clientName: "Early Bird",
          travel_km: 80,
          travel_min: 120,
          eta_start: at("2026-07-08", "09:55"),
          scheduled_on: "2026-07-08",
        },
      ],
      { timezone: TZ },
    );
    expect(w).toHaveLength(1);
    expect(w[0].reason).toBe("eta_inconsistent");
  });

  it("does not flag a legitimate later stop with a short drive", () => {
    // A 3pm stop with a 20-min drive is plainly fine (lots of elapsed time).
    const w = findRouteWarnings(
      [
        {
          id: "v3",
          clientName: "Afternoon",
          travel_km: 12,
          travel_min: 20,
          eta_start: at("2026-07-08", "15:00"),
          scheduled_on: "2026-07-08",
        },
      ],
      { timezone: TZ },
    );
    expect(w).toHaveLength(0);
  });

  it("keeps an evening stop on the org's calendar day, not UTC's", () => {
    // 7 PM in Denver is 01:00 UTC the NEXT day. A day check done on the
    // device's (or UTC's) calendar says this ETA is not on 2026-07-08 at all
    // and either skips a real warning or measures against the wrong midnight.
    // On the org's calendar it is an ordinary, plausible last stop of the day.
    const w = findRouteWarnings(
      [
        {
          id: "v4",
          clientName: "Last Stop",
          travel_km: 10,
          travel_min: 15,
          eta_start: at("2026-07-08", "19:00"),
          scheduled_on: "2026-07-08",
        },
      ],
      { timezone: TZ },
    );
    expect(w).toHaveLength(0);
    // And the same instant five minutes short of its drive still flags, which
    // proves the evening stop is being MEASURED, not skipped as another day.
    const flagged = findRouteWarnings(
      [
        {
          id: "v5",
          clientName: "Last Stop",
          travel_km: 400,
          // 720-min drive vs 660 min elapsed since the 08:00 start — an hour
          // short. (Cap raised below so excessive-drive doesn't fire first.)
          travel_min: 720,
          eta_start: at("2026-07-08", "19:00"),
          scheduled_on: "2026-07-08",
        },
      ],
      { timezone: TZ, maxDriveMinutes: 1440 },
    );
    expect(flagged).toHaveLength(1);
    expect(flagged[0].reason).toBe("eta_inconsistent");
  });

  it("does not flag a first stop the planner rounded to the minute", () => {
    // What plan_visits writes for a first stop 10.4 minutes from the start:
    // the clock moves by the leg rounded to a whole minute, so the arrival is
    // 08:10 and travel_min is 10.4. Found by the routing trials on the first
    // stop of about half of all freshly optimized routes, each carrying a
    // "Re-optimize this route" warning that re-optimizing reproduces.
    // travel_min is also stored to one decimal while the clock used the
    // unrounded leg, so 13.46 is stored as 13.5 and driven as 13: same case.
    for (const [drive, eta] of [
      [10.4, "08:10"],
      [13.5, "08:13"],
      [0.6, "08:00"],
    ] as const) {
      const w = findRouteWarnings(
        [
          {
            id: "first",
            clientName: "First Stop",
            travel_km: 5,
            travel_min: drive,
            eta_start: at("2026-07-08", eta),
            scheduled_on: "2026-07-08",
          },
        ],
        { timezone: TZ },
      );
      expect(w, `${drive} min drive, arriving ${eta}`).toHaveLength(0);
    }
  });

  it("exposes a sane default threshold", () => {
    expect(DEFAULT_MAX_DRIVE_MINUTES).toBe(240);
  });
});
