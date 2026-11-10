// #774: on the new-client Plan step, switching the service from Pet waste
// removal to a 30-minute walk kept Weekly and preselected Monday to Friday
// (WORK_WEEK), so a plan the owner never chose was saved as five walks a
// week. The first visit also started tomorrow with no way to say "today"
// short of the date input, and nothing on the form said why.
//
// Now: every line's weekly plan starts on the first visit's weekday alone;
// a different service drops the days picked for the old one and says so;
// First visit has Today and Tomorrow one tap away, and states its default.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  defaultFirstVisit,
  defaultPlanWeekdays,
  firstVisitHint,
  nextDay,
  serviceSwitch,
} from "@/lib/new-client-plan";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

describe("a walk starts on one day, not a work week", () => {
  it("a 30-minute walk starts on the first visit's weekday alone", () => {
    expect(defaultPlanWeekdays("dog_walking", 3)).toEqual([3]);
    expect(defaultPlanWeekdays("dog_walking", 0)).toEqual([0]);
    expect(defaultPlanWeekdays("pet_waste", 2)).toEqual([2]);
  });

  it("no line starts on five days", () => {
    for (const line of [
      "dog_walking",
      "pet_waste",
      "pet_sitting",
      "mobile_grooming",
      "training",
      null,
    ] as const) {
      expect(defaultPlanWeekdays(line, 4)).toHaveLength(1);
    }
  });
});

describe("switching the service resets the days and says so", () => {
  it("pet waste to a walk, with days picked, resets them with a notice", () => {
    const sw = serviceSwitch({ from: "w", to: "k", hadDays: true, toName: "30-minute walk" });
    expect(sw.reset).toBe(true);
    expect(sw.notice).toBe(
      "Days reset for 30-minute walk. They start on the first visit's day again.",
    );
  });

  it("a switch with nothing picked still says what the days are", () => {
    const sw = serviceSwitch({ from: "w", to: "k", hadDays: false, toName: "30-minute walk" });
    expect(sw.reset).toBe(true);
    expect(sw.notice).toMatch(/^Days set for 30-minute walk: the first visit's day\./);
  });

  it("picking the same service changes nothing", () => {
    expect(serviceSwitch({ from: "k", to: "k", hadDays: true, toName: "x" })).toEqual({
      reset: false,
      notice: null,
    });
  });

  it("copy has no em dash", () => {
    const a = serviceSwitch({ from: "w", to: "k", hadDays: true, toName: "Walk" }).notice!;
    const b = serviceSwitch({ from: "w", to: "k", hadDays: false, toName: "Walk" }).notice!;
    expect(a + b).not.toMatch(/—/);
  });
});

describe("the first visit", () => {
  it("defaults to tomorrow on the business's calendar, across a month end", () => {
    expect(defaultFirstVisit("2026-11-10")).toBe("2026-11-11");
    expect(nextDay("2026-11-30")).toBe("2026-12-01");
    expect(nextDay("2026-12-31")).toBe("2027-01-01");
  });
});

describe("the First visit hint describes the day chosen, not the default", () => {
  const base = { orgToday: "2026-11-10", dayLabel: "Fri, Nov 13" };
  it("tomorrow says it is the default and why", () => {
    expect(firstVisitHint({ ...base, startedOn: "2026-11-11" })).toMatch(
      /^Starts tomorrow, the default, so a client added after today's route is not put on it\./,
    );
  });
  it("after Today is tapped it says today", () => {
    expect(firstVisitHint({ ...base, startedOn: "2026-11-10" })).toMatch(/^Starts today\./);
  });
  it("a lead's requested start says so, even when it is tomorrow", () => {
    expect(firstVisitHint({ ...base, startedOn: "2026-11-13", leadStart: "2026-11-13" })).toMatch(
      /^Starts Fri, Nov 13, the day the lead asked for\./,
    );
    expect(
      firstVisitHint({ ...base, startedOn: "2026-11-11", leadStart: "2026-11-11", dayLabel: "x" }),
    ).not.toMatch(/default/);
  });
  it("any other day names it, and never says tomorrow", () => {
    const h = firstVisitHint({ ...base, startedOn: "2026-11-13" });
    expect(h).toMatch(/^Starts Fri, Nov 13\./);
    expect(h).not.toMatch(/tomorrow/);
  });
  it("every branch keeps the moves-to-the-next-day sentence and no em dash", () => {
    for (const startedOn of ["2026-11-10", "2026-11-11", "2026-11-13"]) {
      const h = firstVisitHint({ ...base, startedOn });
      expect(h).toMatch(/it moves to the next one\.$/);
      expect(h).not.toMatch(/\u2014/);
    }
  });
});

describe("the wizard wires it", () => {
  const wizard = read("src/routes/_authenticated/clients.new.tsx");

  it("both service pickers go through chooseService, which clears the days", () => {
    expect(wizard).not.toMatch(/onChange=\{setServiceId\}/);
    expect(wizard.match(/onChange=\{chooseService\}/g)).toHaveLength(2);
    expect(wizard).toMatch(
      /const chooseService = [\s\S]*?setWeekdays\(null\);\s*setServiceDays\(null\);\s*setDaysNotice\(/,
    );
    expect(wizard).toMatch(/role="status"\s*data-days-reset/);
  });

  it("First visit offers Today and Tomorrow and states the default", () => {
    expect(wizard).toMatch(/\["Today", orgTodayStr\]/);
    expect(wizard).toMatch(/\["Tomorrow", orgTomorrowStr\]/);
    expect(wizard).toMatch(/aria-pressed=\{startedOn === day\}/);
    expect(wizard).toMatch(/firstVisitHint\(\{\s*startedOn,/);
    expect(wizard).not.toMatch(/Starts tomorrow unless you change it/);
    expect(wizard).toMatch(/defaultFirstVisit\(orgTodayStr\)/);
  });

  it("the quick-pick buttons are a thumb's size on touch and do not shrink", () => {
    const quick = wizard.slice(wizard.indexOf("data-first-visit-quick"));
    expect(quick.slice(0, 900)).toMatch(/shrink-0[^"`]*touch:min-h-11/);
  });

  it("the Days each week hint says where the default comes from", () => {
    expect(wizard).toMatch(/Starts on the first visit's day\. Tap more days/);
  });
});
