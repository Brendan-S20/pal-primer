// The dispatch board's lanes stay in ONE row (#495).
//
// At 1032px, an iPad in landscape, the columns layout was a wrapping grid
// (`@min-[32rem]:grid-cols-2 @3xl:grid-cols-3 @5xl:grid-cols-4`). The board's
// container came out under 64rem, so it got three columns: Unassigned plus two
// techs, and the third tech wrapped onto a second grid row below the fold.
// The board never showed the whole crew at once, and dragging a visit from
// the first tech to the last meant dragging it off the bottom of the screen.
// Unassigned took a full lane's width even with nothing in it.
//
// Now every lane asks for at least 15rem and grows to share the row; when
// they do not all fit, the row scrolls sideways inside its own
// `overflow-x-auto`. An empty Unassigned is a narrow strip that is still the
// same drop target. The browser half, at the iPad sizes with touch on, is the
// one-row assertion in tests/viewports/one-list-for-the-evening-round.spec.ts.
//
// Deliberately silent on the rows layout (`boardLayout === "rows"`), which is
// a different mode with one lane per row on purpose, beyond checking it is
// still there and still that.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const ROUTES = readFileSync(join(ROOT, "src/routes/_authenticated/routes.tsx"), "utf8");

/** Comments stripped: the prose next to the board quotes the old class string
 *  it replaced, and a search that read it would pass with the fault back. */
const code = ROUTES.replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

/** The board: the one DndContext on the page, lanes and all. */
function board(): string {
  const start = code.indexOf("<DndContext");
  const end = code.indexOf("</DndContext>", start);
  expect(start, "routes.tsx no longer has a DndContext").toBeGreaterThan(-1);
  expect(end, "routes.tsx's DndContext never closes").toBeGreaterThan(start);
  return code.slice(start, end);
}

/** The lane row's className expression: the ternary between rows and columns. */
function laneRowClasses(): { rows: string; columns: string } {
  const m = board().match(
    /data-lane-row\s+className=\{\s*boardLayout === "rows"\s*\?\s*"([^"]*)"\s*:\s*"([^"]*)"\s*\}/,
  );
  expect(m, "the lane row lost its `data-lane-row` rows/columns ternary").not.toBeNull();
  return { rows: m![1], columns: m![2] };
}

/** The Column component's source, up to the next top-level function. */
function column(): string {
  const start = code.indexOf("function Column(");
  expect(start, "routes.tsx no longer defines Column").toBeGreaterThan(-1);
  const end = code.indexOf("\nfunction ", start + 1);
  return code.slice(start, end === -1 ? undefined : end);
}

describe("the columns layout never wraps a tech lane to a second row", () => {
  it("lays the lanes out as a row that scrolls, not as a grid that wraps", () => {
    const { columns } = laneRowClasses();
    const cls = columns.split(/\s+/);
    expect(cls).toContain("flex");
    expect(cls, "a row that cannot scroll pushes the last lanes off the page").toContain(
      "overflow-x-auto",
    );
    expect(cls, "flex-wrap is the second row by another name").not.toContain("flex-wrap");
    expect(columns).not.toMatch(/grid-cols-/);
  });

  it("has no wrapping grid-cols anywhere on the board", () => {
    // The exact string that shipped, and the general shape of it, so neither
    // the old breakpoints nor a new set of them can come back.
    const b = board();
    expect(b).not.toMatch(/@min-\[32rem\]:grid-cols-2/);
    expect(b).not.toMatch(/@3xl:grid-cols-3/);
    expect(b).not.toMatch(/@5xl:grid-cols-4/);
    expect(b).not.toMatch(/(^|[\s"`])(@[\w[\]-]+|sm|md|lg|xl|2xl):grid-cols-[2-9]\b/);
    expect(b).not.toMatch(/(^|[\s"`])grid-cols-[2-9]\b/);
  });

  it("gives each lane a floor and lets it grow, never shrink, in the columns layout", () => {
    // flex-[1_0_15rem]: grow to share the row, never shrink below 15rem (a
    // card with its header unbroken). Below that the row scrolls instead.
    expect(column()).toMatch(/layout === "columns" \? "flex-\[1_0_15rem\]" : ""/);
  });

  it("leaves the rows layout as it was", () => {
    expect(laneRowClasses().rows).toBe("grid gap-4 grid-cols-1");
  });

  it("keeps the board off phones, where MobileDayList draws the day", () => {
    expect(code).toMatch(/<div className="@container relative max-md:hidden">\s*<DndContext/);
    expect(code).toMatch(/<div className="md:hidden">\s*<MobileDayList /);
  });
});

describe("a lane that starts off-screen can still be reached", () => {
  it("scrolls the row while dragging, and a swipe does not start a drag", () => {
    // autoScroll scrolls the dragged card's scrollable ancestors, and the lane
    // row is one. The PointerSensor's distance is what lets a swipe that
    // begins on the grip be told apart from a tap; the card body has no drag
    // listeners at all.
    expect(board()).toMatch(/<DndContext[^>]*\bautoScroll\b/);
    expect(code).toMatch(
      /useSensor\(PointerSensor, \{ activationConstraint: \{ distance: \d+ \} \}\)/,
    );
    expect(code).toMatch(/cursor-grab touch-none/);
  });

  it("shows a fade at the end edge only while more lanes are there", () => {
    const b = board();
    expect(b).toMatch(/boardLayout === "columns" && moreLanesToTheEnd && \(/);
    expect(b).toMatch(/data-more-lanes[\s\S]*?pointer-events-none absolute inset-y-0 end-0/);
    expect(b).toMatch(/ref=\{setLaneRow\}/);
  });
});

describe("an empty Unassigned lane gives its width to the techs", () => {
  it("collapses when it holds nothing, in the columns layout only", () => {
    expect(code).toMatch(
      /const unassignedEmpty = \(columns\[UNASSIGNED\] \?\? \[\]\)\.length === 0;/,
    );
    expect(code).toMatch(
      /const unassignedCollapsed = boardLayout === "columns" && unassignedEmpty;/,
    );
    const unassigned = board().match(/<Column\s+id=\{UNASSIGNED\}[\s\S]*?\/>/);
    expect(unassigned, "the Unassigned lane is no longer the first Column").not.toBeNull();
    expect(unassigned![0]).toMatch(/collapsed=\{unassignedCollapsed\}/);
  });

  it("is still the same drop target when collapsed", () => {
    const c = column();
    const strip = c.slice(c.indexOf("if (collapsed)"));
    expect(c.indexOf("if (collapsed)"), "Column has no collapsed branch").toBeGreaterThan(-1);
    // The droppable is registered before the branch, and the strip carries
    // its ref, so the id a dropped visit lands on is UNASSIGNED either way.
    expect(c.indexOf("useDroppable(")).toBeLessThan(c.indexOf("if (collapsed)"));
    expect(strip).toMatch(/ref=\{setNodeRef\}/);
    expect(strip).toMatch(/data-lane-collapsed/);
    expect(strip).toMatch(/\bw-14\b/);
    expect(strip).toMatch(/\{items\.length\}/);
  });

  it("wins the drop when the pointer is on the strip", () => {
    // closestCenter alone measures the dragged card's centre, which sits over
    // the first tech lane while the pointer is on a 56px strip.
    expect(board()).toMatch(/collisionDetection=\{collisionDetection\}/);
    expect(code).toMatch(
      /if \(unassignedCollapsed\) \{\s*const onStrip = pointerWithin\(\{[\s\S]*?c\.id === UNASSIGNED/,
    );
  });
});
