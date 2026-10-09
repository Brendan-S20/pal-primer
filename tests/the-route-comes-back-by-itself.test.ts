// The lock-screen route comes back by itself.
//
// Until 2026-10-08 the route went on the lock screen only on a transition
// seen on My Day (Clock in, or the first Start) and never on opening the
// app, so a tech who swiped it away did not get it back that day. The owner
// asked for the opposite: open the app mid-day and it is there. The
// Preferences switch is the one way to say no. src/lib/live-activity-
// autostart.ts is the decision; src/components/my-day/RouteLockScreen.tsx
// asks it on opening, on every return to the front, and on every change to
// the day, from the signed-in layout rather than from My Day.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shouldStartRouteActivity, type RouteAutoStartInput } from "@/lib/live-activity-autostart";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const v = (...statuses: string[]) => statuses.map((status) => ({ status }));

const base: RouteAutoStartInput = {
  supported: true,
  preferenceOn: true,
  visits: v("scheduled", "scheduled"),
  onClock: true,
  clockedOutToday: false,
  showing: false,
  busy: false,
};

describe("whether the route goes back on the lock screen", () => {
  it.each<[string, Partial<RouteAutoStartInput>, boolean]>([
    ["on the clock, stops left, nothing showing", {}, true],
    [
      "off the clock but a stop under way",
      { onClock: false, visits: v("in_progress", "scheduled") },
      true,
    ],
    [
      "no clock at all, and stops already done",
      { onClock: null, visits: v("completed", "scheduled") },
      true,
    ],
    ["a skipped stop counts as begun", { onClock: null, visits: v("skipped", "scheduled") }, true],
    [
      "the morning, untouched, off the clock",
      { onClock: false, visits: v("scheduled", "scheduled") },
      false,
    ],
    [
      "clocked out at lunch with stops left",
      { onClock: false, clockedOutToday: true, visits: v("completed", "scheduled") },
      false,
    ],
    [
      "clocked back in after lunch",
      { onClock: true, clockedOutToday: false, visits: v("completed", "scheduled") },
      true,
    ],
    ["the day is finished", { visits: v("completed", "skipped") }, false],
    ["nothing on the day at all", { visits: [] }, false],
    ["every stop canceled", { visits: v("canceled", "canceled") }, false],
    ["the Preferences switch is off", { preferenceOn: false }, false],
    ["the switch not read yet", { preferenceOn: null }, false],
    ["Live Activities off in iPhone Settings, or iOS 16.1", { supported: false }, false],
    ["already showing", { showing: true }, false],
    ["a start already in flight", { busy: true }, false],
  ])("%s", (_why, over, want) => {
    expect(shouldStartRouteActivity({ ...base, ...over })).toBe(want);
  });
});

describe("where it is asked", () => {
  const hook = codeOnly(read("src/components/my-day/RouteLockScreen.tsx"));

  it("by the signed-in layout, from whatever page the app opens on, not by My Day", () => {
    const layout = read("src/routes/_authenticated/route.tsx");
    expect(layout).toMatch(/<RouteLockScreenHost \/>/);
    expect(read("src/routes/_authenticated/my-day.tsx")).not.toMatch(/useRouteLiveActivity\(/);
    // My Day's own query for today, so the two share one fetch and one cache.
    expect(hook).toMatch(/queryKey: \["my-day", today, ""\]/);
  });

  it("on every return to the front", () => {
    expect(hook).toMatch(/document\.addEventListener\("visibilitychange", onVisible\)/);
    expect(hook).toMatch(/\[can, stateKey, stopsLeft, resumed\]/);
  });

  it("as a state, through the one decision, not as a transition", () => {
    expect(hook).toMatch(/shouldStartRouteActivity\(\{/);
    expect(hook).not.toMatch(/firstStart|prev\.begun === 0/);
  });

  it("still ends on clock-out and on the last stop, and the switch still ends it", () => {
    expect(hook).toMatch(/void stop\("clocked_out", false\)/);
    expect(hook).toMatch(/void stop\("finished", stateRef\.current\.total > 0\)/);
    expect(hook).toMatch(/if \(!pref\.on && showing\) void stop\("hidden", false\)/);
  });

  it("does nothing off the iPhone app", () => {
    expect(hook).toMatch(
      /export function RouteLockScreenHost\(\) \{\s*if \(!liveActivityAvailable\(\)\) return null;/,
    );
  });

  it("the switch on Preferences is the only control: My Day draws no lock-screen toggle", () => {
    expect(hook).not.toMatch(/RouteLockScreenToggle/);
    expect(read("src/routes/_authenticated/my-day.tsx")).not.toMatch(
      /RouteLockScreenToggle|data-route-lock-screen/,
    );
  });
});
