// A trainer skipping a lesson picks from lesson reasons, not the scooper's.
//
// "Gate locked / no access" and "Dog was outside" are why a yard was not
// cleaned. A lesson is called off because the client canceled, the dog is
// unwell, nobody is home, or the weather. The product review of #476 found
// the yard list on the trainer's skip picker; this pins the lesson list and
// that each code has a translation in all four languages.

import { describe, expect, it } from "vitest";
import {
  LESSON_SKIP_REASON_CODES,
  LESSON_SKIP_REASON_LABELS,
  TECH_SKIP_REASON_CODES,
  WALK_SKIP_REASON_CODES,
  techSkipReasonCodes,
} from "@/lib/skip-rules.functions";
import en from "@/lib/i18n/locales/en";
import es from "@/lib/i18n/locales/es";
import ar from "@/lib/i18n/locales/ar";
import zh from "@/lib/i18n/locales/zh";

describe("the trainer's skip reasons", () => {
  it("are lesson reasons, with no gate or yard in them", () => {
    expect(techSkipReasonCodes("training")).toEqual(LESSON_SKIP_REASON_CODES);
    expect(LESSON_SKIP_REASON_CODES).not.toContain("gate_locked");
    expect(LESSON_SKIP_REASON_CODES).not.toContain("dog_outside");
    expect(LESSON_SKIP_REASON_CODES).not.toContain("access_blocked");
    expect(LESSON_SKIP_REASON_CODES).not.toContain("customer_requested");
  });

  it("leaves the walker's and the yard tech's lists as they were", () => {
    expect(techSkipReasonCodes("dog_walking")).toEqual(WALK_SKIP_REASON_CODES);
    expect(techSkipReasonCodes("pet_waste")).toEqual(TECH_SKIP_REASON_CODES);
    expect(techSkipReasonCodes(undefined)).toEqual(TECH_SKIP_REASON_CODES);
  });

  it("has a label for every code in every language", () => {
    for (const code of LESSON_SKIP_REASON_CODES) {
      expect(LESSON_SKIP_REASON_LABELS[code]).toBeTruthy();
      for (const locale of [en, es, ar, zh]) {
        expect((locale as any).lessonSkipReason[code]).toBeTruthy();
      }
    }
  });
});
