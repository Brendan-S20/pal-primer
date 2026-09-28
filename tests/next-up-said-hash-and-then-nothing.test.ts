// From the product review of 2026-09-27, My Day at 360px.
//
// The NEXT UP bar at the foot of My Day read "NEXT UP · #" and stopped. It
// printed `#{nextUp.sequence ?? ""}`, and `visits.sequence` is null for a
// visit the office added to the day after the route was built — a real and
// common case, since that is how a same-day extra or a re-clean lands on a
// tech's day. `?? ""` turned the missing number into a missing number with a
// hash in front of it.
//
// The card list below it falls back to the card's position, and the bar
// could have done the same. It omits the part instead: the client's name is
// the line directly under the label, and that is what identifies the stop. A
// position printed after "#" would pass for a stop number the office never
// assigned. No number, no "#".

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const src = readFileSync(ROOT + "src/routes/_authenticated/my-day.tsx", "utf8");
const code = src
  .split("\n")
  .filter((l) => {
    const t = l.trim();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("{/*");
  })
  .join("\n");

describe("the NEXT UP bar's stop number", () => {
  it("is printed only when there is one", () => {
    expect(code).toMatch(/\{nextUp\.sequence != null && ` · #\$\{nextUp\.sequence\}`\}/);
  });

  it("never prints the hash with an empty fallback after it", () => {
    // The shipped spelling, and the two ways of writing it again.
    expect(code).not.toMatch(/#\{nextUp\.sequence \?\? ""\}/);
    expect(code).not.toMatch(/#\{nextUp\.sequence \?\? ''\}/);
    expect(code).not.toMatch(/#\$\{nextUp\.sequence \?\? ""\}/);
  });

  it("still labels the bar whichever state it is in", () => {
    // The guard wraps only the number; the label beside it must not have gone
    // with it.
    expect(code).toMatch(/activeVisit \? t\("myDay\.inProgress"\) : t\("myDay\.nextUp"\)/);
  });
});
