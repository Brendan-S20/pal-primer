// #619: Cover moved a walker's whole future schedule, so a four-day absence
// reassigned work for weeks after they were back. It now moves the away
// dates, and later work only when the office ticks "also move later work".
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pickCoverWindow, splitLoad, spreadVisits } from "../src/lib/cover-window";

const root = join(__dirname, "..");
const fns = readFileSync(join(root, "src/lib/visits.functions.ts"), "utf8");
const page = readFileSync(join(root, "src/routes/_authenticated/routes.tsx"), "utf8");

const off = [{ starts_on: "2026-11-03", ends_on: "2026-11-06", reason: "Vacation" }];
const load = [
  { scheduled_on: "2026-11-02", visits: 4 },
  { scheduled_on: "2026-11-03", visits: 5 },
  { scheduled_on: "2026-11-04", visits: 5 },
  { scheduled_on: "2026-11-06", visits: 3 },
  { scheduled_on: "2026-11-07", visits: 2 },
  { scheduled_on: "2026-11-10", visits: 6 },
];

describe("the Cover window", () => {
  it("is the time off that covers the day on screen", () => {
    expect(pickCoverWindow(off, "2026-11-04", "2026-10-31")).toEqual({
      from: "2026-11-03",
      to: "2026-11-06",
      source: "time_off",
      reason: "Vacation",
    });
  });

  it("is the next time off when the day on screen is before it", () => {
    const w = pickCoverWindow(off, "2026-10-31", "2026-10-31");
    expect([w.from, w.to, w.source]).toEqual(["2026-11-03", "2026-11-06", "time_off"]);
  });

  it("never starts before today", () => {
    const w = pickCoverWindow(off, "2026-11-05", "2026-11-05");
    expect([w.from, w.to]).toEqual(["2026-11-05", "2026-11-06"]);
  });

  it("is the day on screen alone when no time off is recorded", () => {
    expect(pickCoverWindow([], "2026-11-04", "2026-10-31")).toEqual({
      from: "2026-11-04",
      to: "2026-11-04",
      source: "day",
      reason: null,
    });
  });

  it("ignores time off that has already ended", () => {
    const past = [{ starts_on: "2026-10-01", ends_on: "2026-10-03" }];
    expect(pickCoverWindow(past, "2026-11-04", "2026-11-04").source).toBe("day");
  });
});

describe("time off Nov 3-6", () => {
  const win = pickCoverWindow(off, "2026-11-03", "2026-10-31");

  it("moves only the Nov 3-6 visits by default", () => {
    const s = splitLoad(load, win);
    expect(s.inside.map((d) => d.scheduled_on)).toEqual(["2026-11-03", "2026-11-04", "2026-11-06"]);
    expect(s.insideTotal).toBe(13);
  });

  it("leaves visits after Nov 6 to the opt-in", () => {
    const s = splitLoad(load, win);
    expect(s.later.map((d) => d.scheduled_on)).toEqual(["2026-11-07", "2026-11-10"]);
    expect(s.laterTotal).toBe(8);
  });
});

describe("spreading the window's visits", () => {
  it("goes round-robin within each day and passes a refusal to the next tech", async () => {
    const calls: Array<[string, string]> = [];
    const moved = await spreadVisits(
      [
        { id: "a", scheduled_on: "2026-11-03" },
        { id: "b", scheduled_on: "2026-11-03" },
        { id: "c", scheduled_on: "2026-11-04" },
        { id: "d", scheduled_on: "2026-11-04" },
      ],
      ["t1", "t2"],
      async (v, t) => {
        calls.push([v, t]);
        if (v === "d") return "refused";
        if (v === "c" && t === "t1") return "refused";
        return "ok";
      },
    );
    expect(moved).toEqual(["a", "b", "c"]);
    expect(calls).toEqual([
      ["a", "t1"],
      ["b", "t2"],
      ["c", "t1"],
      ["c", "t2"],
      ["d", "t2"],
      ["d", "t1"],
    ]);
  });
});

describe("the wiring", () => {
  const body = fns.slice(fns.indexOf("export const redistributeStaffWork"));
  const handler = body.slice(0, body.indexOf("\nexport "));

  it("bounds the default move by the window's last day", () => {
    expect(handler).toMatch(/\.lte\("scheduled_on", data\.to!\)/);
    expect(handler).toMatch(/const windowed = Boolean\(data\.to\) && !data\.includeLater/);
  });

  it("sends the window and the opt-in from the Cover dialog, unticked on open", () => {
    expect(page).toMatch(/from: coverWindow\?\.from/);
    expect(page).toMatch(/to: coverWindow\?\.to/);
    expect(page).toMatch(/includeLater: coverLater/);
    expect(page).toMatch(/Also move later work/);
    expect(page).toMatch(/setCoverLater\(false\);\s*setCoverFor\(who\)/);
  });
});
