// R2-30 (train-r2-04): moving a lesson onto the day of a late-canceled one
// showed the office `duplicate key value violates unique constraint
// "visits_subscription_id_scheduled_on_key"`. The rule stays; the sentence
// says what is in the way and how to book the make-up anyway.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { groomWriteError } from "@/lib/groom-clash.server";
import {
  SERIES_DAY_CONSTRAINT,
  isSeriesDayTaken,
  seriesDayTakenMessage,
} from "@/lib/series-day-taken";

const RAW = {
  code: "23505",
  message: `duplicate key value violates unique constraint "${SERIES_DAY_CONSTRAINT}"`,
};

describe("seriesDayTakenMessage", () => {
  it("names the day and the way to a make-up, and no database words", () => {
    const m = seriesDayTakenMessage("2026-10-30");
    expect(m).toContain("Fri, Oct 30");
    expect(m).toMatch(/canceled or skipped visit still holds its day/);
    expect(m).toMatch(/book a one-off visit on Fri, Oct 30/);
    expect(m).not.toMatch(/duplicate|constraint|key/i);
  });
  it("reads without a date", () => {
    expect(seriesDayTakenMessage(undefined)).toMatch(/on that day/);
  });
});

describe("isSeriesDayTaken", () => {
  it("recognises the constraint and nothing else", () => {
    expect(isSeriesDayTaken(RAW)).toBe(true);
    expect(isSeriesDayTaken({ code: "23505", message: 'unique constraint "other_key"' })).toBe(
      false,
    );
    expect(isSeriesDayTaken(null)).toBe(false);
  });
});

describe("groomWriteError, which every day move throws through", () => {
  it("turns the raw constraint into the sentence", async () => {
    const e = await groomWriteError({}, RAW, { visitIds: ["v"], toDate: "2026-10-30" });
    expect(e.message).toBe(seriesDayTakenMessage("2026-10-30"));
  });
  it("leaves any other error as the database said it", async () => {
    const e = await groomWriteError({}, { message: "permission denied" });
    expect(e.message).toBe("permission denied");
  });
  it("is the funnel for the office move, the bulk move and the weather moves", () => {
    const root = process.cwd();
    const visits = readFileSync(join(root, "src/lib/visits.functions.ts"), "utf8");
    const weather = readFileSync(join(root, "src/lib/weather.functions.ts"), "utf8");
    // rescheduleVisitFromOffice and bulkRescheduleVisits
    expect(visits.match(/throw await groomWriteError\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    // move for weather and its undo
    expect(weather.match(/await groomWriteError\(/g)?.length ?? 0).toBe(2);
  });
});
