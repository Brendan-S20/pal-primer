/**
 * The viewport fixture's "today" is the fixture organization's today, on
 * every runner, at every hour.
 *
 * ── WHAT THIS PINS ───────────────────────────────────────────────────────
 *
 * `tests/viewports/fixtures/dataset.ts` exports `day(offset)` and `TODAY`, and
 * every dated row the stub backend serves hangs off them. The pages those
 * rows land on decide what today is with `useOrgToday()` — the date in the
 * org's timezone, America/Chicago, which is also the zone
 * `playwright.config.ts` pins the browser to.
 *
 * Until 2026-10-09 `day()` said "org-local" in its comment and took the date
 * from the RUNNER's clock (`new Date()`, `setHours`, `getDate`). The runners
 * are in US Eastern, so for the hour after midnight Eastern the fixture's
 * TODAY was Chicago's tomorrow; a UTC runner would have had five such hours
 * (19:00 to midnight in Chicago). Inside that window /my-schedule loses its
 * Today badge, the Spanish sweep's /\bhoy\b/ fails, and anything comparing a
 * fixture date with `useOrgToday()` quietly takes its other branch — a
 * failure that exists for an hour a night and reproduces from nowhere else.
 *
 * ── HOW ──────────────────────────────────────────────────────────────────
 *
 * Node re-reads `process.env.TZ` when it is assigned, so this can BE the
 * runner in each zone that matters and walk the clock across two days in
 * half-hour steps. It asserts the property, not a sample: at every instant,
 * under every host zone, `day(0, now)` is `orgToday("America/Chicago", now)`.
 *
 * And it proves the walk can see the fault, by running the implementation
 * that shipped through the same walk and requiring it to FAIL under Eastern
 * — so a later refactor of the walk that stops covering the boundary hour
 * fails here instead of going quietly green.
 */
import { afterAll, describe, expect, it } from "vitest";

import { orgToday } from "@/lib/org-day";
import {
  day,
  FIXTURE_NOW,
  FIXTURE_TIMEZONE,
  ORGANIZATION,
  TODAY,
} from "./viewports/fixtures/dataset";
import { FIXTURE_NOON, orgInstant } from "./viewports/fixtures/fixture-clock";
import { BASE_STUBS, myUpcomingDays } from "./viewports/fixtures/stub-backend";

const ORIGINAL_TZ = process.env.TZ;
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

/** The day() that shipped until 2026-10-09, verbatim but for `now`. */
function dayAsItShipped(offset: number, now: Date) {
  const d = new Date(now.getTime());
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

/** Every half hour across two days that straddle a US date change, from
 *  2026-10-08T00:00Z: covers midnight Eastern (04:00Z), midnight Chicago
 *  (05:00Z) and midnight UTC, each twice. */
const INSTANTS = Array.from({ length: 96 }, (_, i) => new Date(Date.UTC(2026, 9, 8, 0, 30 * i)));

/** Where the runners are (Eastern), where a cloud runner is (UTC), the org's
 *  own zone, and two far enough away to be wrong for most of the day. */
const HOST_ZONES = ["America/New_York", "UTC", "America/Chicago", "Asia/Tokyo", "Pacific/Honolulu"];

function asHost(tz: string) {
  process.env.TZ = tz;
  // Prove the assignment took: a walk under a zone Node ignored would pass
  // without having tested anything.
  const probe = new Date(Date.UTC(2026, 0, 15, 12));
  const expected = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    hourCycle: "h23",
  }).format(probe);
  expect(probe.getHours(), `process.env.TZ=${tz} did not reach Date`).toBe(Number(expected) % 24);
}

describe("the viewport fixture's today", () => {
  it("is on the org's clock, and the org is the one the browser is pinned to", () => {
    expect(FIXTURE_TIMEZONE).toBe("America/Chicago");
    expect(ORGANIZATION.timezone).toBe(FIXTURE_TIMEZONE);
  });

  for (const tz of HOST_ZONES) {
    it(`is the org's today at every half hour, on a runner in ${tz}`, () => {
      asHost(tz);
      const wrong = INSTANTS.filter((now) => day(0, now) !== orgToday(FIXTURE_TIMEZONE, now)).map(
        (now) =>
          `${now.toISOString()}: fixture ${day(0, now)}, org ${orgToday(FIXTURE_TIMEZONE, now)}`,
      );
      expect(wrong).toEqual([]);
    });
  }

  it("counts its offsets in whole org days, across a DST change too", () => {
    asHost("America/New_York");
    // 2026-11-01 is the US fall-back Sunday; the offsets walk straight over it.
    const now = new Date("2026-10-31T17:00:00Z");
    expect([-1, 0, 1, 2, 3].map((n) => day(n, now))).toEqual([
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
    ]);
  });

  it("the version that shipped fails this walk in the hour after midnight Eastern", () => {
    asHost("America/New_York");
    const wrong = INSTANTS.filter(
      (now) => dayAsItShipped(0, now) !== orgToday(FIXTURE_TIMEZONE, now),
    ).map((now) => now.toISOString());
    // 04:00Z and 04:30Z on each of the two nights: midnight to 01:00 Eastern,
    // 23:00 to midnight in Chicago. Exactly the hour, and nothing else.
    expect(wrong).toEqual([
      "2026-10-08T04:00:00.000Z",
      "2026-10-08T04:30:00.000Z",
      "2026-10-09T04:00:00.000Z",
      "2026-10-09T04:30:00.000Z",
    ]);
  });

  // ── ONE INSTANT, NOT TWO (#941, 2026-11-16) ───────────────────────────────
  //
  // The zone was right and the run still crossed midnight: the fixture read
  // the clock when the worker imported it, the browser read it at render.
  // These pin the fixture's half of the fix; the browser's half is
  // the-technician-who-could-not-see-thursday.spec.ts, at 11:59 PM and
  // 12:01 AM Chicago.

  it("dates every row from one instant, read once, so a stub answering later cannot drift", () => {
    expect(day(0)).toBe(TODAY);
    expect(TODAY).toBe(orgToday(FIXTURE_TIMEZONE, FIXTURE_NOW));
    // A stub called at request time used to call day(1) on THAT clock.
    expect(day(1)).toBe(day(1, FIXTURE_NOW));
    expect((BASE_STUBS.getMyUpcomingDays as { days: { date: string }[] }).days[0].date).toBe(TODAY);
  });

  it("pins the browser to noon on the fixture's day, twelve hours from either midnight", () => {
    expect(orgToday(FIXTURE_TIMEZONE, FIXTURE_NOON)).toBe(TODAY);
    expect(FIXTURE_NOON.getTime()).toBe(orgInstant(TODAY, "12:00").getTime());
  });

  for (const tz of HOST_ZONES) {
    it(`builds the schedule's first day as the org's today at that instant, on a runner in ${tz}`, () => {
      asHost(tz);
      const wrong = INSTANTS.filter(
        (now) => myUpcomingDays(now).days[0].date !== orgToday(FIXTURE_TIMEZONE, now),
      ).map((now) => now.toISOString());
      expect(wrong).toEqual([]);
      // And the two pins the browser spec stands on, either side of midnight.
      const before = orgInstant("2026-11-15", "23:59");
      const after = orgInstant("2026-11-16", "00:01");
      expect(myUpcomingDays(before).days[0].date).toBe("2026-11-15");
      expect(myUpcomingDays(after).days[0].date).toBe("2026-11-16");
      expect(myUpcomingDays(after).days.map((d) => d.date)).toEqual([
        "2026-11-16",
        "2026-11-17",
        "2026-11-19",
      ]);
    });
  }
});
