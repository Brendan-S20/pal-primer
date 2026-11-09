// R2-44 (waste-r2-08): on the new-client wizard a weekly plan could be saved
// with Fri and Sat. Services read "Fri Sat"; only Fridays were generated,
// because a weekly plan lands on the first preferred day. A one-day cadence
// now picks one day, and what the chips show is what is saved.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pickServiceDay, serviceDaysFor, serviceDaysPerWeek } from "@/lib/weekday-set";

const FRI = 5;
const SAT = 6;

describe("pickServiceDay", () => {
  it("a weekly plan moves its day instead of adding a second", () => {
    expect(pickServiceDay([SAT], FRI, "weekly")).toEqual([FRI]);
    expect(pickServiceDay([SAT], FRI, "biweekly")).toEqual([FRI]);
    expect(pickServiceDay([SAT], FRI, "monthly")).toEqual([FRI]);
  });
  it("tapping the only day leaves it on", () => {
    expect(pickServiceDay([SAT], SAT, "weekly")).toEqual([SAT]);
  });
  it("twice weekly holds two days, and a third tap replaces one", () => {
    expect(pickServiceDay([1], 4, "twice_weekly")).toEqual([1, 4]);
    expect(pickServiceDay([1, 4], 4, "twice_weekly")).toEqual([1]);
    const three = pickServiceDay([1, 4], FRI, "twice_weekly");
    expect(three).toHaveLength(2);
    expect(three).toContain(FRI);
  });
});

describe("serviceDaysFor", () => {
  it("never saves more days than the cadence runs on", () => {
    expect(serviceDaysFor([FRI, SAT], "weekly")).toEqual([FRI]);
    expect(serviceDaysFor([1, 4, FRI], "twice_weekly")).toEqual([1, 4]);
    expect(serviceDaysPerWeek("weekly")).toBe(1);
    expect(serviceDaysPerWeek("twice_weekly")).toBe(2);
  });
});

describe("the wizard", () => {
  const src = readFileSync(
    join(process.cwd(), "src/routes/_authenticated/clients.new.tsx"),
    "utf8",
  );
  it("derives the shown and saved days through serviceDaysFor", () => {
    expect(src).toMatch(/const effectiveServiceDays = serviceDaysFor\(/);
    expect(src).toMatch(
      /preferredWeekdays:\s*\n?\s*frequency === "one_time" \|\| setDays \? undefined : effectiveServiceDays/,
    );
  });
  it("picks a day through pickServiceDay and says how many a week", () => {
    expect(src).toMatch(/setServiceDays\(pickServiceDay\(effectiveServiceDays, d, frequency\)\)/);
    expect(src).toMatch(/For more days a week, choose Twice weekly\./);
  });
});
