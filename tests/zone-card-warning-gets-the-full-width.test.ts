// The zone card's ZIP warning gets the full width of the card on a phone (#493).
//
// The card's top row is `flex flex-wrap justify-between`: the zone's content on
// one side, the price block on the other. The content column was
// `min-w-0 flex-1`, and `flex-1` is a ZERO basis, so a wrapping row never
// wraps it: at 390px the price block stayed beside it and the amber
// "No ZIPs listed..." warning was squeezed into a word per line. A real basis
// below sm (`basis-full sm:basis-0`) puts the price block on the next line and
// keeps today's layout from sm up. The warning paragraph inside it has the same
// fault beside the "Fill ZIPs from the area" button, and the same fix.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const SOURCE = readFileSync(join(ROOT, "src/routes/_authenticated/zones.tsx"), "utf8");

const ROW = '<div className="flex flex-wrap items-start justify-between gap-3">';

function classesOf(tag: string): string[] {
  const m = tag.match(/className="([^"]*)"/);
  return m ? m[1].split(/\s+/).filter(Boolean) : [];
}

function hasSmallScreenBasis(classes: string[]): boolean {
  return classes.includes("basis-full") && classes.includes("sm:basis-0");
}

/** The zone card's row: the one whose children include the zone name heading. */
function zoneCardRow(): string {
  let from = 0;
  for (;;) {
    const at = SOURCE.indexOf(ROW, from);
    if (at < 0) throw new Error("zone card row not found in zones.tsx");
    const tail = SOURCE.slice(at + ROW.length);
    if (tail.slice(0, 2000).includes("{zone.name}</h3>")) return tail;
    from = at + ROW.length;
  }
}

describe("the zone card at 390px", () => {
  it("gives the content column a real basis below sm, so the price block wraps under it", () => {
    const tail = zoneCardRow();
    // The first element in the row (the Checkbox sits inside it, so it stays
    // beside the zone name rather than taking a line of its own).
    const firstDiv = tail.match(/<div\b[^>]*>/);
    expect(firstDiv, "no element found in the zone card row").not.toBeNull();
    const classes = classesOf(firstDiv![0]);
    expect(
      hasSmallScreenBasis(classes),
      `the zone card's content column is "${classes.join(" ")}". With only a zero basis ` +
        "(flex-1) the row never wraps and the ZIP warning is squeezed beside the price " +
        "block at 390px. Give it `basis-full sm:basis-0`.",
    ).toBe(true);
    expect(classes).toContain("min-w-0");
    const opened = tail.indexOf(firstDiv![0]);
    const checkbox = tail.indexOf("<Checkbox");
    const heading = tail.indexOf("{zone.name}</h3>");
    expect(checkbox, "the bulk select checkbox has left the content column").toBeGreaterThan(
      opened,
    );
    expect(checkbox).toBeLessThan(heading);
  });

  it("lets the no-ZIPs warning take a full line above the fill button below sm", () => {
    const at = SOURCE.indexOf('"No ZIPs listed, so the signup page');
    expect(at, "the no-ZIPs warning is no longer in zones.tsx").toBeGreaterThan(0);
    const before = SOURCE.slice(0, at);
    const pOpen = before.slice(before.lastIndexOf("<p "));
    const tag = pOpen.match(/<p\b[^>]*>/);
    expect(tag).not.toBeNull();
    const classes = classesOf(tag![0]);
    expect(
      hasSmallScreenBasis(classes),
      `the ZIP warning is "${classes.join(" ")}". Beside the fill button with a zero ` +
        "basis it wraps a word or two per line at 390px. Give it `basis-full sm:basis-0`.",
    ).toBe(true);
  });
});
