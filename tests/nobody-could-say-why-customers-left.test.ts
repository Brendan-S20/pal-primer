import { describe, expect, it } from "vitest";
import { CHURN_REASONS, churnReasonBucket, tallyChurnReasons } from "@/lib/churn-reasons";

// Ending a service stored a free-text reason and nothing read it back, so
// "why are customers leaving?" had no answer short of opening every ended
// service. New endings pick a reason; old free text is sorted into the same
// buckets by its words so the report covers the past too.

describe("old free-text reasons land in the right bucket", () => {
  it.each([
    ["Moving to Ohio", "Moving away"],
    ["moved", "Moving away"],
    ["Too expensive", "Price"],
    ["cost", "Price"],
    ["Missed two visits in a row", "Service quality"],
    ["Going to do it myself", "Doing it themselves"],
    ["Dog passed", "Dog passed away or rehomed"],
    ["Winter pause", "Seasonal"],
    ["Went with a competitor", "Switched to another company"],
    ["", "Other"],
    ["no idea", "Other"],
  ])("%s → %s", (text, bucket) => {
    expect(churnReasonBucket(text)).toBe(bucket);
  });

  it("a reason picked from the list is kept exactly", () => {
    for (const r of CHURN_REASONS) expect(churnReasonBucket(r)).toBe(r);
  });
});

describe("the report", () => {
  it("counts, most common first, only reasons that happened", () => {
    expect(tallyChurnReasons(["Price", "too expensive", "Moving away", null])).toEqual([
      { reason: "Price", count: 2 },
      { reason: "Moving away", count: 1 },
      { reason: "Other", count: 1 },
    ]);
  });
});
