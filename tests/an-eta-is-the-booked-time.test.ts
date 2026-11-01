// #654, F-13: a groom booked for 09:00 read "Arriving 8:15 to 9:45" in the
// portal, and a 2:00 PM groom showed "ETA 8:05" beside "Starts 2:00 PM" on My
// Day. The route planner writes eta_start/eta_end from the workday's clock and
// never reads visits.start_time. A booked start now wins everywhere a visit's
// time is drawn: office (board, calendar, drawer, client Visits tab), groomer
// (My Day, lock screen) and portal.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { orgLocalTime } from "@/lib/org-day";
import { bookedStartInstant, visitEta } from "@/lib/visit-eta";
import { withBookedEta } from "@/lib/portal.functions";
import { stopWindow } from "@/lib/live-activity-state";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const TZ = "America/Chicago";
// What the audit saw: a 09:00 groom, routed to 8:15 to 9:45.
const GROOM = {
  scheduled_on: "2026-11-03",
  start_time: "09:00:00",
  duration_min: 90,
  eta_start: "2026-11-03T14:15:00Z", // 8:15 AM CST
  eta_end: "2026-11-03T15:45:00Z", // 9:45 AM CST
};

describe("visitEta", () => {
  it("returns the booked start and end, not the planner's estimate", () => {
    const eta = visitEta(GROOM, TZ);
    expect(eta.booked).toBe(true);
    expect(orgLocalTime(eta.start, TZ, "en-US")).toBe("9:00 AM");
    expect(orgLocalTime(eta.end, TZ, "en-US")).toBe("10:30 AM");
  });

  it("anchors the booked start on the business's clock, across a DST change", () => {
    // 2026-11-01 is the day Central leaves daylight time.
    expect(
      bookedStartInstant({ scheduled_on: "2026-10-31", start_time: "14:00" }, TZ)?.toISOString(),
    ).toBe("2026-10-31T19:00:00.000Z");
    expect(
      bookedStartInstant({ scheduled_on: "2026-11-02", start_time: "14:00" }, TZ)?.toISOString(),
    ).toBe("2026-11-02T20:00:00.000Z");
    expect(
      orgLocalTime(
        visitEta({ ...GROOM, start_time: "14:00" }, "America/Detroit").start,
        "America/Detroit",
        "en-US",
      ),
    ).toBe("2:00 PM");
  });

  it("keeps the planner's ETA when nothing was booked", () => {
    const eta = visitEta({ ...GROOM, start_time: null }, TZ);
    expect(eta).toEqual({ start: GROOM.eta_start, end: GROOM.eta_end, booked: false });
  });

  it("has no end when the booking has no duration", () => {
    const eta = visitEta({ ...GROOM, duration_min: null }, TZ);
    expect(eta.booked).toBe(true);
    expect(eta.end).toBeNull();
  });

  it("ignores a start_time that is not a clock", () => {
    expect(visitEta({ ...GROOM, start_time: "soon" }, TZ).booked).toBe(false);
    expect(visitEta({ ...GROOM, scheduled_on: null }, TZ).booked).toBe(false);
  });
});

describe("the portal", () => {
  it("replaces a booked visit's ETA with the booked window and leaves the rest alone", () => {
    const rows = [
      {
        visit_id: "g",
        scheduled_on: GROOM.scheduled_on,
        eta_start: GROOM.eta_start,
        eta_end: GROOM.eta_end,
      },
      {
        visit_id: "w",
        scheduled_on: GROOM.scheduled_on,
        eta_start: GROOM.eta_start,
        eta_end: GROOM.eta_end,
      },
    ];
    const out = withBookedEta(
      rows,
      [{ id: "g", scheduled_on: GROOM.scheduled_on, start_time: "09:00:00", duration_min: 90 }],
      TZ,
    );
    expect(orgLocalTime(out[0].eta_start, TZ, "en-US")).toBe("9:00 AM");
    expect(orgLocalTime(out[0].eta_end, TZ, "en-US")).toBe("10:30 AM");
    expect(out[1]).toBe(rows[1]);
  });

  it("reads start_time for the upcoming list", () => {
    expect(read("src/lib/portal.functions.ts")).toMatch(
      /loadPortalUpcomingVisits[\s\S]{0,1400}start_time, duration_min[\s\S]{0,600}withBookedEta\(/,
    );
  });
});

describe("the groomer's lock screen", () => {
  it("shows the booked window", () => {
    const t = (k: string, o?: Record<string, unknown>) =>
      k === "liveActivity.window" ? `${o?.start}–${o?.end}` : k;
    expect(
      stopWindow(
        { id: "g", status: "scheduled", ...GROOM },
        { t, tz: TZ, locale: "en-US", rtl: false },
      ),
    ).toBe("9:00 AM–10:30 AM");
  });
});

describe("every surface that draws a visit's time asks visitEta", () => {
  const surfaces = [
    "src/routes/_authenticated/my-day.tsx",
    "src/routes/_authenticated/routes.tsx",
    "src/components/VisitDetailDrawer.tsx",
    "src/components/schedule/MobileDayList.tsx",
    "src/components/schedule/ScheduleCalendar.tsx",
    "src/components/client-detail/VisitsTab.tsx",
    "src/lib/live-activity-state.ts",
  ];
  for (const f of surfaces) {
    it(f, () => {
      const src = read(f);
      expect(src).toContain('from "@/lib/visit-eta"');
      expect(src).toMatch(/visitEta\(/);
      // No label is drawn straight from eta_start any more.
      expect(src).not.toMatch(/orgLocalTime\(\s*(?:v|visit|nextVisit)\??\.eta_start/);
      expect(src).not.toMatch(/formatTime\(\s*v\.eta_start/);
    });
  }

  it("and the queries behind them carry start_time", () => {
    const visits = read("src/lib/visits.functions.ts");
    expect(visits).toMatch(/listVisitsForDay[\s\S]{0,900}start_time, duration_min/);
    expect(visits).toMatch(/getVisitDetail[\s\S]{0,900}start_time/);
    expect(read("src/lib/clients.functions.ts")).toMatch(/start_time, eta_start, eta_end/);
    expect(read("src/lib/push-liveactivity.server.ts")).toMatch(
      /start_time, duration_min, eta_start/,
    );
  });
});

describe("loose ends from review", () => {
  it("a booked window with no end draws no dangling dash in the portal", () => {
    expect(read("src/lib/portal-ui.tsx")).toContain(
      'v.eta_end ? `–${orgLocalTime(v.eta_end, tz)}` : ""',
    );
    expect(read("src/routes/portal.$slug.$token.index.tsx")).toContain(
      'nextVisit.eta_end ? `–${orgLocalTime(nextVisit.eta_end, tz)}` : ""',
    );
  });
  it("the tech's week summary reads the booked time too", () => {
    const src = read("src/lib/my-day.functions.ts");
    expect(src).toMatch(/start_time, duration_min, eta_start, eta_end, zones\(name\)/);
    expect(src).toMatch(/const eta = visitEta\(v, tz\);/);
  });
});
