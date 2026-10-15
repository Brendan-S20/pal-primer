// QA row 23, 2026-10-15, the schedule board on an iPad (820, 1024, 1366).
//
// The "Directions" link on each stop card was 25px tall, beside a Complete
// button already given 44px on touch. And the bulk-select checkbox, 13px,
// took its 44px from a `::before` on the <input> itself. A native checkbox
// is a replaced element: whether its pseudo-element is drawn, and takes the
// tap, is the browser's call, and WebKit, which is every iPad, does not draw
// it. The sweep credits the pseudo-element in Chromium, so it was green.
//
// The checkbox is now wrapped in a <label> that is the 44px box on a touch
// screen. A label's hit area is a box like any other, in every engine.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(
  join(import.meta.dirname, "..", "src/routes/_authenticated/routes.tsx"),
  "utf8",
);

/** The stop card's bulk-select control, from its guard to the drag grip. */
function selectControl(): string {
  const to = src.indexOf('aria-label="Drag to reorder this stop"');
  const from = src.lastIndexOf("{onToggleSelect && (", to);
  expect(from).toBeGreaterThan(0);
  expect(to).toBeGreaterThan(from);
  return src.slice(from, to);
}

describe("the stop card's bulk-select checkbox", () => {
  it("is inside a label that is 44px on a touch screen", () => {
    const c = selectControl();
    expect(c).toMatch(/<label[\s\S]*?className="[^"]*touch:min-h-11 touch:min-w-11[^"]*"/);
    expect(c).toMatch(/<label[\s\S]*<input[\s\S]*type="checkbox"[\s\S]*<\/label>/);
  });

  it("no longer leans on a pseudo-element of the input", () => {
    expect(selectControl()).not.toMatch(/touch:before:/);
  });

  it("does not toggle twice: the label's click and the one it forwards both stop at the label", () => {
    const c = selectControl();
    expect(c.match(/onClick=\{\(e\) => e\.stopPropagation\(\)\}/g)).toHaveLength(2);
  });
});

describe("the stop card's Directions link", () => {
  it("is 44px on a touch screen, like Complete beside it", () => {
    // The one on the stop card: the first after the card's drag grip.
    const grip = src.indexOf('aria-label="Drag to reorder this stop"');
    const at = src.indexOf('<Navigation className="h-3 w-3 shrink-0" /> Directions', grip);
    expect(at).toBeGreaterThan(0);
    const anchor = src.slice(src.lastIndexOf("<a", at), at);
    expect(anchor).toMatch(/className="[^"]*\btouch:min-h-11\b[^"]*"/);
  });
});
