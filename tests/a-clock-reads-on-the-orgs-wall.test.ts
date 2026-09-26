import { describe, expect, it } from "vitest";
import { readFileSync as readSrcFile } from "node:fs";
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

// The office half of the same sweep (the technician block above landed
// first). Every one of these shipped its own answer to "what day is it" —
// most of them the UTC day via `toISOString().slice(0, 10)`, which is
// TOMORROW from early evening on, US-wide. The two hand-rolled
// `${d.getFullYear()}-…` templates were the device's day, same fault in
// different spelling. Same rule as above: the forbidden pattern is the
// idiom that actually shipped, and each file must still call the hook.
describe("the office surfaces ask the org what day it is", () => {
  // Its own reader, deliberately not named like the technician block's from
  // the org-day PR: these two blocks land from separate branches, and two
  // top-level declarations of one name is a merge that compiles on each
  // branch and breaks on main. Scoped inside the describe for the same
  // reason.
  const src = (p: string) => readSrcFile(p, "utf8");
  const UTC_TODAY = /new Date\(\)\s*\.\s*toISOString\(\)\s*\.\s*slice\(0,\s*10\)/;
  const HANDROLLED_TODAY = /\$\{d\.getFullYear\(\)\}-/;

  for (const f of [
    "src/components/client-detail/ClientHeader.tsx",
    "src/components/client-detail/VacationHoldDrawer.tsx",
    "src/components/client-detail/billing-panels.tsx",
    "src/components/ai/AiPanels.tsx",
  ]) {
    it(`${f} reads the org's today, not the UTC day`, () => {
      const s = src(f);
      expect(s).toContain("useOrgToday(");
      expect(s).not.toMatch(UTC_TODAY);
    });
  }

  for (const f of [
    "src/components/client-detail/ServicesTab.tsx",
    "src/components/client-detail/SummaryTab.tsx",
    "src/routes/_authenticated/clients.$clientId.tsx",
  ]) {
    it(`${f} reads the org's today, not a hand-rolled device day`, () => {
      const s = src(f);
      expect(s).toContain("useOrgToday(");
      expect(s).not.toMatch(HANDROLLED_TODAY);
    });
  }

  it("the form builders take today from the caller instead of manufacturing it", () => {
    const s = src("src/lib/subscription-form.ts");
    expect(s).not.toMatch(/function (localTodayISO|todayLocalISO)/);
  });

  it("the two server call sites filter live services on the ORG's day", () => {
    // The server is a UTC worker: `liveServiceOrFilter(todayLocalISO())`
    // there meant every org's services flipped a day at 6-7pm US time.
    for (const f of ["src/lib/estimate.server.ts", "src/lib/portal.functions.ts"]) {
      const s = src(f);
      expect(s).toMatch(/liveServiceOrFilter\(orgToday\(/);
      expect(s).not.toMatch(/liveServiceOrFilter\(todayLocalISO/);
    }
  });

  it("weather day arithmetic anchors at noon, where every offset agrees", () => {
    expect(src("src/components/WeatherStrip.tsx")).toMatch(
      /nextDayISO[\s\S]{0,400}T12:00:00/,
    );
  });
});
