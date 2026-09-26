import { describe, expect, it } from "vitest";
import { orgLocalDayTime, orgLocalMinutes, orgLocalTime } from "@/lib/org-day";

// Until 2026-09-19 every visit-time label rendered on the DEVICE's clock —
// three private copies of `toLocaleTimeString([])` and several inline calls,
// none passing a timeZone. A Chicago org viewed from an Eastern browser showed
// every ETA an hour late; the demo org showed 3:30 AM. These tests pin the
// replacement the way tests/route-window.test.ts pins the write side: the
// same instant must read as the ORG's wall clock whatever machine runs this
// suite, on both sides of a DST boundary, in more than one org zone.
//
// Node's Intl output varies one way that matters to string equality: newer ICU
// puts U+202F (narrow no-break space) before AM/PM. The normalizer below makes
// the assertions about the CLOCK, not about which space ICU chose this year.

const plain = (s: string) => s.replace(/[\u202f\u00a0]/g, " ");

describe("orgLocalTime reads an instant on the organization's wall clock", () => {
  it("winter (CST, UTC-6): 14:00Z is 8:00 AM in Chicago", () => {
    expect(plain(orgLocalTime("2026-01-15T14:00:00Z", "America/Chicago"))).toBe("8:00 AM");
  });

  it("summer (CDT, UTC-5): 13:00Z is 8:00 AM in Chicago — DST is the org's problem, not the caller's", () => {
    expect(plain(orgLocalTime("2026-07-15T13:00:00Z", "America/Chicago"))).toBe("8:00 AM");
  });

  it("the same instant reads differently for an org in another zone", () => {
    expect(plain(orgLocalTime("2026-07-15T13:00:00Z", "America/New_York"))).toBe("9:00 AM");
  });

  it('returns "" for garbage and for nothing, because every caller branches on falsiness', () => {
    expect(orgLocalTime("not a date", "America/Chicago")).toBe("");
    expect(orgLocalTime(null, "America/Chicago")).toBe("");
    expect(orgLocalTime(undefined, "America/Chicago")).toBe("");
    expect(orgLocalTime("", "America/Chicago")).toBe("");
  });
});

describe("orgLocalMinutes buckets an instant into the org's day", () => {
  it("8:15 AM in Chicago is 495 minutes, from a UTC instant", () => {
    expect(orgLocalMinutes("2026-07-15T13:15:00Z", "America/Chicago")).toBe(495);
  });

  it("midnight is 0, not 1440 — en-GB under hour12:false can print hour 24", () => {
    // 05:00Z on a July night is exactly midnight CDT.
    expect(orgLocalMinutes("2026-07-15T05:00:00Z", "America/Chicago")).toBe(0);
  });

  it("null for garbage, because null is the Anytime group and 0 is midnight", () => {
    expect(orgLocalMinutes("nope", "America/Chicago")).toBeNull();
    expect(orgLocalMinutes(null, "America/Chicago")).toBeNull();
  });
});

describe("orgLocalDayTime carries the weekday for close-out copy", () => {
  it("names the org-local weekday, which can differ from the UTC one", () => {
    // 03:00Z Sunday is still Saturday evening in Chicago.
    const label = plain(orgLocalDayTime("2026-07-19T03:00:00Z", "America/Chicago"));
    expect(label).toContain("Sat");
    expect(label).toContain("10:00 PM");
  });
});

// ── THE DAY, NOT JUST THE TIME ─────────────────────────────────────────────
//
// The 2026-09-19 conversion above fixed what o'clock a visit label reads. It
// did not fix which DAY the technician surfaces open on: my-day.tsx kept a
// private device-clock todayISO(), my-schedule.tsx asked
// `new Date().toLocaleDateString("en-CA")`, and WeatherPopover anchored its
// week on the UTC day — three different answers to "what is today" on one
// screen whose time labels had just been moved to a fourth (the org's). A
// tech whose phone sits in another timezone opened tomorrow's list under
// org-time labels; the weather window started a day late every US evening.
//
// useOrgToday() exists for exactly this, shares the ["my-org"] query the
// shell already loaded, and its own doc block quotes the setting's promise:
// the org timezone "decides what counts as 'today' everywhere". These pins
// scan the source because the fault is a spelling with many bodies: the
// forbidden patterns below are the three idioms that actually shipped, and
// each file must also still call the hook. WeatherPopover is allowed
// `getTimezoneOffset` — its plusDaysIso does plain-date arithmetic, where the
// offset shift is the fix, not the fault.
import { readFileSync } from "node:fs";

const src = (p: string) => readFileSync(p, "utf8");

describe("the technician surfaces ask the org what day it is", () => {
  const DEVICE_TODAY =
    /new Date\(\)\s*\.\s*toISOString|getTimezoneOffset|toLocaleDateString\("en-CA"\)/;

  it("my-day derives its default day from useOrgToday", () => {
    const s = src("src/routes/_authenticated/my-day.tsx");
    expect(s).toContain("useOrgToday(");
    expect(s).not.toMatch(DEVICE_TODAY);
  });

  it("my-schedule badges Today on the org's today", () => {
    const s = src("src/routes/_authenticated/my-schedule.tsx");
    expect(s).toContain("useOrgToday(");
    expect(s).not.toMatch(DEVICE_TODAY);
  });

  it("the weather window opens on the org's today, not the UTC day", () => {
    const s = src("src/components/WeatherPopover.tsx");
    expect(s).toContain("useOrgToday(");
    expect(s).not.toMatch(/new Date\(\)\s*\.\s*toISOString/);
  });
});
