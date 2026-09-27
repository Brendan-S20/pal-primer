import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Reported from the phone as inconsistency, and it was: the Concerns card
// read "Submitted 9/26/2026, 7:17:31 PM" while every other surface said
// "Sep 26, 7:17 PM". Thirty-five sites printed a date with a bare
// `new Date(x).toLocaleString()` or `.toLocaleDateString()` — numeric,
// with seconds, and no year rule — beside the formatDateTime / formatDay
// helpers in src/lib/format.ts that exist to be the one spelling.
//
// One of them was worse than cosmetic. `new Date("2026-09-26")` parses a
// DATE-ONLY string as UTC midnight, which is the previous evening anywhere
// in the US, so analytics' "last visit" column showed every date a day
// early. formatDay anchors date-only strings at local noon for exactly
// that reason; the bare call cannot know to.
//
// So this is a ratchet on the idiom that shipped. A line may opt out with
// `date-format-ok:` and a reason (the DNA notice letter does: a printed
// letter's date follows the reader's locale, not the app's style).
// Deliberately silent on numbers (`(1234).toLocaleString()` is thousands
// separators, which is right) and on `someDate.toLocaleDateString()` calls
// that do not construct from a raw value, which were not the fault.

const BARE = /new Date\([^()]+\)\.toLocale(Date)?String\(\)/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return p.endsWith(".tsx") && !p.includes(".server.") ? [p] : [];
  });
}

describe("dates are printed one way", () => {
  it("no UI file formats a date with a bare toLocaleString", () => {
    const offenders: string[] = [];
    for (const file of walk("src")) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (BARE.test(line) && !line.includes("date-format-ok:")) {
            offenders.push(`${file}:${i + 1}  ${line.trim()}`);
          }
        });
    }
    expect(offenders, "use formatDateTime / formatDay from @/lib/format").toEqual([]);
  });

  it("the date-only trap the helper exists for is real", async () => {
    const { formatDay } = await import("@/lib/format");
    // formatDay names the calendar day it was given, in every timezone the
    // suite runs in; the bare parse would name the 25th west of Greenwich.
    expect(formatDay("2026-09-26")).toContain("26");
  });
});
