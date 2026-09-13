import { describe, expect, it } from "vitest";
import { dayAtAGlance } from "../src/lib/day-at-a-glance";

// My Day could say how far through the day was and draw where it went. It could
// not say when it ended, or what was still ahead that needed thinking about —
// that was on the cards, one at a time, several scrolls apart.
//
// `dayAtAGlance` is the arithmetic behind the summary row. It is a separate
// module from the component for one reason: every decision in it is a judgement
// about what a technician is asking, and each of those is worth pinning —
// including the ones about what NOT to count. A component test would pin the
// markup instead.

const visit = (over: Record<string, any> = {}) => ({
  status: "scheduled",
  eta_end: null,
  properties: {},
  ...over,
});

const prop = (over: Record<string, any> = {}) => ({ properties: { ...over } });

describe("the rest of the day, in three numbers", () => {
  it("counts what is ahead, not what the day held", () => {
    // The number that means something at stop 9 of 12 is the one still in front
    // of the tech. A summary that keeps counting the aggressive dog at stop 3,
    // three hours after it was dealt with, is a summary nobody reads twice.
    const day = [
      visit({ status: "completed", ...prop({ aggressive_dog: true, gate_code: "1234" }) }),
      visit({ status: "skipped", ...prop({ dog_in_yard_during_service: true }) }),
      visit({ status: "in_progress", ...prop({ gate_code: "9999" }) }),
      visit({ status: "scheduled", ...prop({ escape_risk: true }) }),
    ];
    expect(dayAtAGlance(day)).toMatchObject({ remaining: 2, warnings: 1 });
  });

  it("finishes at the last stop still ahead, not the last stop of the day", () => {
    const day = [
      visit({ status: "completed", eta_end: "2026-09-13T20:00:00Z" }),
      visit({ status: "scheduled", eta_end: "2026-09-13T15:00:00Z" }),
      visit({ status: "scheduled", eta_end: "2026-09-13T18:40:00Z" }),
    ];
    expect(dayAtAGlance(day).finishAt).toBe("2026-09-13T18:40:00Z");
  });

  it("reports no finish time rather than inventing one", () => {
    // eta_end comes from the route optimizer. A day assembled by hand has none,
    // and the honest answer is that there is no answer — the row renders a dash
    // and says "no ETAs", which tells the office something too.
    expect(dayAtAGlance([visit(), visit()]).finishAt).toBeNull();
    expect(dayAtAGlance([visit({ eta_end: "" })]).finishAt).toBeNull();
    expect(dayAtAGlance([visit({ eta_end: "not a date" })]).finishAt).toBeNull();
    expect(dayAtAGlance([visit({ eta_end: 1_700_000_000 })]).finishAt).toBeNull();
  });

  it("ignores an unparseable ETA without losing the parseable ones beside it", () => {
    const day = [
      visit({ eta_end: "not a date" }),
      visit({ eta_end: "2026-09-13T16:00:00Z" }),
      visit({ eta_end: null }),
    ];
    expect(dayAtAGlance(day).finishAt).toBe("2026-09-13T16:00:00Z");
  });

  it("counts only the hazards that change how you approach the door", () => {
    // All eight hazard flags are on the card. Promoting all eight here makes the
    // number meaningless, because on a real route nearly every property trips at
    // least one of the warn-level ones.
    const critical = [
      { do_not_enter_if_dog_out: true },
      { aggressive_dog: true },
      { escape_risk: true },
    ];
    for (const p of critical) {
      expect(dayAtAGlance([visit(prop(p))]).warnings, JSON.stringify(p)).toBe(1);
    }
    const warn = [
      { invisible_fence: true },
      { dog_in_yard_during_service: true },
      { bees_wasps: true },
      { sharp_objects: true },
      { slippery_surfaces: true },
    ];
    for (const p of warn) {
      expect(dayAtAGlance([visit(prop(p))]).warnings, JSON.stringify(p)).toBe(0);
    }
  });

  it("counts a stop once however many hazard flags it carries", () => {
    // The question is "how many stops need care", not "how many flags are on
    // file for this address".
    const all = visit(prop({ aggressive_dog: true, escape_risk: true, do_not_enter_if_dog_out: true }));
    expect(dayAtAGlance([all]).warnings).toBe(1);
  });

  it("has no number for the things that are only useful at the stop", () => {
    // An earlier draft counted codes, keys, parking notes and dogs-in-the-yard
    // too. They came out: the code is on the card, at the stop, which is where
    // it is needed, and six chips at 360px is a block to read rather than a
    // glance. This pins the shape so the row does not silently grow back.
    const busy = visit(
      prop({
        gate_code: "5521#",
        lock_box_code: "0000",
        key_location: "Under the planter",
        parking_notes: "Alley only",
        dog_in_yard_during_service: true,
        bees_wasps: true,
      }),
    );
    expect(Object.keys(dayAtAGlance([busy])).sort()).toEqual(["finishAt", "remaining", "warnings"]);
    expect(dayAtAGlance([busy]).warnings).toBe(0);
  });

  it("survives the shapes the API actually returns", () => {
    // `properties` is a join and can be null; a visit with no status at all is
    // not a visit this summary should crash on.
    expect(dayAtAGlance([])).toEqual({ remaining: 0, finishAt: null, warnings: 0 });
    expect(() => dayAtAGlance([{ status: "scheduled", properties: null }])).not.toThrow();
    expect(dayAtAGlance([{ status: "scheduled", properties: null }]).remaining).toBe(1);
    expect(dayAtAGlance([{}]).remaining).toBe(0);
  });
});
