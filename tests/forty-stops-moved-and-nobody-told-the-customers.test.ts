import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A rained-out day is moved in one action, and the customers are emailed that
// their visit changed. Both halves matter, and only one of them was reported.
//
// The notification loop used to sit inside a single try/catch that logged and
// returned. Two faults, and the second is the one that hurt:
//
//   1. SILENT. The caller got `moved` and nothing else, so WeatherStrip said
//      "Moved 14 visits" whether fourteen customers were told or none were.
//   2. ALL-OR-NOTHING. The `await` was inside the try rather than the loop
//      body, so a throw on the SECOND customer skipped every remaining one.
//      Fourteen moved visits, one notified customer, no signal anywhere.
//
// In this trade that is not a missed nicety. A customer who was not told is a
// locked gate, and a dog in the yard, on a day nobody is coming.

const FN = readFileSync(join(process.cwd(), "src/lib/weather.functions.ts"), "utf8");
const STRIP = readFileSync(join(process.cwd(), "src/components/WeatherStrip.tsx"), "utf8");

/** The notification loop, comments stripped so prose cannot satisfy a check. */
function notifyBlock(): string {
  const code = FN.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  const start = code.indexOf("let notifyFailed");
  expect(start, "the notifyFailed counter is gone").toBeGreaterThan(-1);
  const end = code.indexOf("return { moved", start);
  expect(end).toBeGreaterThan(start);
  return code.slice(start, end);
}

describe("one bad address does not silence the round", () => {
  const block = notifyBlock();

  it("catches per customer, inside the loop", () => {
    // The shape that matters: the try opens AFTER `for (const m of moves)`.
    // A try wrapping the loop is the bug this replaced.
    const forIdx = block.indexOf("for (const m of moves)");
    const tryIdx = block.indexOf("try {");
    expect(forIdx).toBeGreaterThan(-1);
    expect(tryIdx).toBeGreaterThan(forIdx);
  });

  it("keeps going after a failure rather than returning", () => {
    const cat = block.slice(block.indexOf("} catch"));
    expect(cat).toMatch(/notifyFailed\+\+/);
    expect(cat).not.toMatch(/\breturn\b/);
    expect(cat).not.toMatch(/\bbreak\b/);
  });

  it("counts every customer that was not reached", () => {
    expect(block).toMatch(/notifyFailed\+\+/);
  });
});

describe("and the number reaches the dispatcher", () => {
  it("is returned, not only logged", () => {
    const code = FN.replace(/^[ \t]*\/\/.*$/gm, "");
    expect(code).toMatch(/return \{ moved, errors, moves, notifyFailed \}/);
  });

  it("the strip says how many were not told", () => {
    expect(STRIP).toMatch(/r\.notifyFailed/);
    expect(STRIP).toMatch(/not emailed about the change/);
  });

  it("tells the dispatcher what to do about it", () => {
    // "Call them before the day" is the point. The visits have already moved;
    // what is still recoverable is the phone call, and only if somebody knows.
    expect(STRIP).toMatch(/Call [\s\S]{0,80}before the day/);
  });

  it("warns before it congratulates", () => {
    // A warning under a green "Moved 14 visits" is a warning nobody reads.
    const warn = STRIP.indexOf("not emailed about the change");
    const success = STRIP.indexOf("toast.success(`Moved ${r.moved}");
    expect(warn).toBeGreaterThan(-1);
    expect(success).toBeGreaterThan(-1);
    expect(warn).toBeLessThan(success);
  });

  it("holds it on screen longer than the success toast", () => {
    const i = STRIP.indexOf("not emailed about the change");
    expect(STRIP.slice(i, i + 300)).toMatch(/duration:\s*15000/);
  });
});

describe("what is deliberately unchanged", () => {
  it("still dedupes per recipient and target date", () => {
    // A property contact and the account contact are distinct recipients, and
    // one customer with three moved visits on the same day gets one email.
    expect(notifyBlock()).toMatch(/seen\.has\(key\)/);
  });

  it("still does not fail the move because an email failed", () => {
    // The visits are already moved and the rows are correct. Throwing here
    // would turn a notification problem into a scheduling one.
    const block = notifyBlock();
    expect(block.slice(block.indexOf("} catch"))).not.toMatch(/\bthrow\b/);
  });
});
