import { describe, expect, it } from "vitest";
import { canBook, expiresOnFor, holdsSession, packageState, sessionLabel, sessionsLeft, weeklySessionDates } from "@/lib/training-packages";

const pack = { sessions_count: 6, sessions_used: 2, expires_on: "2026-04-30", status: "active" as const };
describe("training package calendar and session rules", () => {
  it("keeps booked sessions in the entitlement and subtracts only usage", () => {
    expect(sessionsLeft(pack)).toBe(4);
    expect(sessionsLeft({ sessions_count: 6, sessions_used: 6 })).toBe(0);
    expect(sessionsLeft({ sessions_count: 6, sessions_used: 7 })).toBe(0);
    expect(sessionLabel(3, 6)).toBe("Session 3 of 6");
  });
  it("prioritizes cancellation and expiry, with expiry inclusive", () => {
    expect(packageState(pack, "2026-04-30")).toBe("active");
    expect(packageState(pack, "2026-05-01")).toBe("expired");
    expect(packageState({ ...pack, sessions_used: 6 }, "2026-04-30")).toBe("used_up");
    expect(packageState({ ...pack, status: "canceled" }, "2026-05-01")).toBe("canceled");
    expect(packageState({ ...pack, expires_on: null }, "2030-01-01")).toBe("active");
  });
  it("adds calendar days over year boundaries and leap days", () => {
    expect(expiresOnFor("2026-12-31", 1)).toBe("2027-01-01");
    expect(expiresOnFor("2028-02-28", 1)).toBe("2028-02-29");
    expect(expiresOnFor("2026-01-01", 90)).toBe("2026-04-01");
    expect(expiresOnFor("2026-01-01", null)).toBeNull();
  });
  it("makes weekly dates on or after the start, across daylight saving", () => {
    expect(weeklySessionDates("2026-03-01", 1, 6, null)).toEqual(["2026-03-02", "2026-03-09", "2026-03-16", "2026-03-23", "2026-03-30", "2026-04-06"]);
    expect(weeklySessionDates("2026-03-02", 1, 6, "2026-03-16")).toEqual(["2026-03-02", "2026-03-09", "2026-03-16"]);
    expect(weeklySessionDates("2026-03-02", 1, 0, null)).toEqual([]);
    expect(weeklySessionDates("2026-03-02", 2, 6, "2026-03-02")).toEqual([]);
    expect(() => weeklySessionDates("2026-02-30", 1, 6, null)).toThrow(/valid first date/);
    expect(() => weeklySessionDates("2026-03-02", 7, 6, null)).toThrow(/weekday/);
  });
  it("matches the database's refusal sentences and reserves future sessions", () => {
    expect(canBook(pack, 5, "2026-04-30")).toBeNull();
    expect(canBook(pack, 6, "2026-04-30")).toBe("No sessions left in this package: 6 of 6 are booked or used.");
    expect(canBook(pack, 0, "2026-05-01")).toBe("This package expired on 2026-04-30.");
    expect(canBook({ ...pack, status: "canceled" }, 0, "2026-04-01")).toBe("This package was canceled.");
    for (const status of ["scheduled", "in_progress", "completed"]) expect(holdsSession({ status, skip_billable: false })).toBe(true);
    for (const status of ["canceled", "missed", "skipped"]) expect(holdsSession({ status, skip_billable: false })).toBe(false);
    expect(holdsSession({ status: "skipped", skip_billable: true })).toBe(true);
  });
});
