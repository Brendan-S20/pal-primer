import { describe, expect, it } from "vitest";
import {
  visitDurationMinutes,
  formatVisitDuration,
  isMissedVisitCandidate,
} from "@/lib/visit-lifecycle";

// QA round 3, finding B6.

describe("visitDurationMinutes / formatVisitDuration (I13 #10)", () => {
  it("computes the duration from real start and completion timestamps", () => {
    const started = "2026-07-16T06:05:00.000Z";
    const completed = "2026-07-16T06:47:00.000Z";
    expect(visitDurationMinutes(started, completed)).toBe(42);
    expect(formatVisitDuration(started, completed)).toBe("42 min");
  });

  it("shows a computed duration for the identical 6:05/6:05 repro, not 'Not recorded'", () => {
    // The B6 backfill artifact: start == completion to the millisecond. This
    // used to blank to "Not recorded"; now it reads as a computed 0.
    const t = "2026-07-16T06:05:00.000Z";
    expect(visitDurationMinutes(t, t)).toBe(0);
    expect(formatVisitDuration(t, t)).toBe("Under a minute");
  });

  it("returns null / 'Not recorded' when a timestamp is missing", () => {
    expect(visitDurationMinutes(null, "2026-07-16T06:47:00Z")).toBeNull();
    expect(visitDurationMinutes("2026-07-16T06:05:00Z", null)).toBeNull();
    expect(visitDurationMinutes(null, null)).toBeNull();
    expect(formatVisitDuration("2026-07-16T06:05:00Z", null)).toBe("Not recorded");
  });

  it("returns null when completion precedes start (invalid ordering)", () => {
    expect(
      visitDurationMinutes("2026-07-16T07:00:00Z", "2026-07-16T06:00:00Z"),
    ).toBeNull();
  });

  it("rounds to the nearest minute", () => {
    expect(visitDurationMinutes("2026-07-16T06:00:00Z", "2026-07-16T06:00:40Z")).toBe(1);
    expect(visitDurationMinutes("2026-07-16T06:00:00Z", "2026-07-16T06:00:20Z")).toBe(0);
  });
});

describe("isMissedVisitCandidate (I13 #8)", () => {
  const TODAY = "2026-07-17";

  it("flags a past scheduled visit that was never started", () => {
    expect(
      isMissedVisitCandidate({ status: "scheduled", scheduled_on: "2026-07-09" }, TODAY),
    ).toBe(true);
    expect(
      isMissedVisitCandidate({ status: "scheduled", scheduled_on: "2026-07-16" }, TODAY),
    ).toBe(true);
  });

  it("leaves today's scheduled visit alone (ambiguous — may still be serviced)", () => {
    expect(
      isMissedVisitCandidate({ status: "scheduled", scheduled_on: TODAY }, TODAY),
    ).toBe(false);
  });

  it("leaves a future scheduled visit alone", () => {
    expect(
      isMissedVisitCandidate({ status: "scheduled", scheduled_on: "2026-07-20" }, TODAY),
    ).toBe(false);
  });

  it("leaves a past scheduled visit that has a partial start (in-flight anomaly)", () => {
    expect(
      isMissedVisitCandidate(
        { status: "scheduled", scheduled_on: "2026-07-09", started_at: "2026-07-09T13:00:00Z" },
        TODAY,
      ),
    ).toBe(false);
  });

  it("never touches completed, skipped, canceled, in_progress, or already-missed visits", () => {
    for (const status of ["completed", "skipped", "canceled", "in_progress", "missed"]) {
      expect(
        isMissedVisitCandidate({ status, scheduled_on: "2026-07-09" }, TODAY),
      ).toBe(false);
    }
  });
});
