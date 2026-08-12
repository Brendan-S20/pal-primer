// A 61-hour drive, and nobody was told.
//
// `findRouteWarnings` was written for QA finding #10: the optimizer would
// schedule a stop 1,850 km / 61 h from the technician's depot without saying
// anything, and could show an arrival time that its own drive figure does not
// allow. The helper is pure, it has seven tests, it catches both — and no
// screen ever called it, so the dispatcher went on getting no warning.
//
// Nothing found it for months. `tsc` does not flag an unimported module, the
// bundler simply never includes it, and its tests passed the whole time,
// proving the machinery works when called while saying nothing about whether
// anything calls it. Rule 6 of the dead-machinery check found it on its first
// run, and it was recorded as a KNOWN GAP rather than deleted, because deleting
// tested safety work to make a check go green is the mute button that file's
// header warns about. This clears it properly.
//
// ── THRESHOLDS COME FROM THE ORG, NOT THE DEFAULTS ────────────────────────
//
// The helper defaults to a 240-minute cap and an 08:00 workday start. Handing
// it those regardless would measure an org whose day starts at 06:00, or whose
// cap is 90 minutes, against numbers it never chose — warning far too much or
// not at all. The board reads the same `getDispatchSettings` that Settings →
// Scheduling writes, so the warning and the setting can never disagree.
//
// `workday_start` arrives as "08:00:00". The parse is guarded with
// Number.isFinite rather than a truthiness check on purpose: a midnight start
// is 0, and `0 || default` would silently substitute 08:00 for it.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findRouteWarnings } from "@/lib/route-plausibility";

const root = join(import.meta.dirname, "..");
const routes = readFileSync(join(root, "src/routes/_authenticated/routes.tsx"), "utf8");
const baseline = JSON.parse(
  readFileSync(join(root, "scripts/dead-machinery-baseline.json"), "utf8"),
);

/** The parse as the board does it, extracted so the edge cases are testable
 *  rather than asserted about by reading the source. */
const workdayStartMinutes = (ws: string | null | undefined): number | undefined => {
  const [h, m] = (ws ?? "").split(":");
  const mins = Number(h) * 60 + Number(m);
  return Number.isFinite(mins) ? mins : undefined;
};

describe("the board parses the org's workday start", () => {
  it("reads the Postgres time format", () => {
    expect(workdayStartMinutes("08:00:00")).toBe(480);
    expect(workdayStartMinutes("06:30:00")).toBe(390);
  });

  it("keeps midnight as 0 instead of falling back", () => {
    // The bug a truthiness check would introduce: 0 is a real start time.
    expect(workdayStartMinutes("00:00:00")).toBe(0);
  });

  it("falls back to undefined — not 0 — when the value is missing or junk", () => {
    // undefined lets the helper apply its own default. 0 would mean "the day
    // starts at midnight", and every stop would look impossibly early.
    expect(workdayStartMinutes(null)).toBeUndefined();
    expect(workdayStartMinutes(undefined)).toBeUndefined();
    expect(workdayStartMinutes("")).toBeUndefined();
    expect(workdayStartMinutes("garbage")).toBeUndefined();
    expect(workdayStartMinutes("08")).toBeUndefined();
  });
});

describe("the org's thresholds actually change the answer", () => {
  const stop = [
    {
      id: "v1",
      clientName: "Far Away Co",
      travel_km: 120,
      travel_min: 150,
      scheduled_on: "2026-08-07",
    },
  ];

  it("a 150-minute drive is fine under the 240 default", () => {
    expect(findRouteWarnings(stop)).toHaveLength(0);
  });

  it("and is flagged for an org that caps drives at 90", () => {
    const w = findRouteWarnings(stop, { maxDriveMinutes: 90 });
    expect(w).toHaveLength(1);
    expect(w[0].reason).toBe("excessive_drive");
  });

  it("an early start changes what counts as an impossible arrival", () => {
    // Arrives 07:00, 60-minute drive. Against an 08:00 start that is
    // impossible; against a 06:00 start it is an hour of driving from open.
    const early = [
      {
        id: "v2",
        clientName: "Early Bird",
        travel_min: 60,
        eta_start: "2026-08-07T07:00:00",
        scheduled_on: "2026-08-07",
      },
    ];
    expect(findRouteWarnings(early, { workdayStartMinutes: 8 * 60 })).toHaveLength(1);
    expect(findRouteWarnings(early, { workdayStartMinutes: 6 * 60 })).toHaveLength(0);
  });
});

describe("the routes board renders them", () => {
  it("calls the helper that had no caller", () => {
    expect(routes).toMatch(/import \{ findRouteWarnings \} from "@\/lib\/route-plausibility";/);
    expect(routes).toMatch(/const routeWarnings = useMemo\(/);
  });

  it("feeds it the org's settings, not the helper's defaults", () => {
    expect(routes).toMatch(/getDispatchSettings/);
    expect(routes).toMatch(/maxDriveMinutes: s\?\.max_drive_minutes \?\? undefined/);
    expect(routes).toMatch(/workdayStartMinutes: startMin/);
  });

  it("guards the parse with isFinite, so midnight survives", () => {
    expect(routes).toMatch(/Number\.isFinite\(mins\) \? mins : undefined/);
  });

  it("shows nothing when there is nothing wrong", () => {
    // A banner that renders empty is a banner people learn to scroll past.
    expect(routes).toMatch(/\{routeWarnings\.length > 0 && \(/);
  });

  it("is not collapsible, unlike the panels beside it", () => {
    // Weather and tech load are questions you choose to ask. This is the board
    // telling you something is wrong with what it just drew — putting it behind
    // a toggle is how it stayed invisible in the first place.
    const banner = routes.slice(routes.indexOf("{routeWarnings.length > 0 && ("));
    const upToWeather = banner.slice(0, banner.indexOf("Show weather"));
    expect(upToWeather).not.toMatch(/localStorage/);
  });

  it("each warning opens the visit it is about", () => {
    // "Re-optimize this route" is not actionable from a paragraph.
    expect(routes).toMatch(/onClick=\{\(\) => setDetailVisitId\(w\.visitId\)\}/);
  });

  it("keys on visit AND reason, since one stop can trip both checks", () => {
    expect(routes).toMatch(/key=\{`\$\{w\.visitId\}-\$\{w\.reason\}`\}/);
  });

  it("says where the thresholds come from", () => {
    expect(routes).toMatch(/Thresholds come from/);
    expect(routes).toMatch(/to="\/settings\/scheduling"/);
  });
});

describe("the gap it was recorded as is closed", () => {
  it("route-plausibility is out of the baseline", () => {
    expect(baseline.unreachable_modules?.["src/lib/route-plausibility.ts"]).toBeUndefined();
  });

  it("and the baseline carries no known gaps at all now", () => {
    const gaps: string[] = [];
    for (const key of Object.keys(baseline)) {
      if (key === "_readme") continue;
      for (const [name, reason] of Object.entries(baseline[key] as Record<string, string>)) {
        if (String(reason).startsWith("KNOWN GAP")) gaps.push(`${key}:${name}`);
      }
    }
    expect(gaps).toEqual([]);
  });
});
