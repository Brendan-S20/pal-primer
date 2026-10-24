// From the product review of 2026-09-27: three faults in the new-client
// wizard, all found at phone width.
//
// ── 1. "Prop" ─────────────────────────────────────────────────────────────
//
// The step bar is five dots, five names and four chevrons, about 645px with
// touch-sized dots. It was made to scroll sideways in August rather than
// push the page wider, which was right, but a scroller's edge falls wherever
// it falls: at 360px it cut a step name in half with nothing to say more was
// there. Below `lg` the names and chevrons are now hidden and the current
// step's name is a line of its own underneath, which truncates with an
// ellipsis instead of being cut. `lg`, not `md`, because the docked sidebar
// takes 256px from 768 and the full row only fits the 672px column once that
// column exists.
//
// ── 2. EVERY STEP OPENED AT ITS BUTTONS ──────────────────────────────────
//
// Next and Back are at the foot of the card. The step is swapped in place and
// the window keeps its scroll offset, so each new step opened at the bottom
// with its first field a screen above.
//
// ── 3. "CLEAR SAVED", WITH NOTHING SAVED ─────────────────────────────────
//
// BoundarySketch's save button saves whatever polygon is on the map, and with
// none it saves null — clearing a boundary — so its label switched to "Clear
// saved". On a new client's Yard step nothing had ever been saved, and the
// first thing the step offered was to clear it.

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(ROOT + p, "utf8");
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return (
        !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("{/*")
      );
    })
    .join("\n");

const wizard = codeOnly(read("src/routes/_authenticated/clients.new.tsx"));
const sketch = codeOnly(read("src/components/BoundarySketch.tsx"));

/** The stepper: from the map over the steps to the first step's card.
 *  `steps`, not `STEPS`, since 2026-10-08: the list comes from
 *  newClientWizardSteps (lib/service-lines), which drops the Yard step for a
 *  business that does not run pet waste. */
function stepper(): string {
  const start = wizard.indexOf("{steps.map(");
  const end = wizard.indexOf("<Card", start);
  expect(start, "the stepper's steps.map was not found").toBeGreaterThan(-1);
  return wizard.slice(start, end);
}

describe("the step bar on a phone", () => {
  const bar = stepper();

  it("hides every step's name in the row below lg", () => {
    // The span that holds `{label}` inside the map.
    expect(bar).toMatch(/className=\{`hidden lg:inline /);
    expect(bar).not.toMatch(/<span className=\{state === "current" \? "font-medium"/);
  });

  it("hides the chevrons below lg too, so five dots fit a 320px phone", () => {
    expect(bar).toMatch(/<ChevronRight className="[^"]*\bhidden\b[^"]*\blg:block\b/);
  });

  it("names the current step on its own line, truncating rather than cut", () => {
    expect(bar).toMatch(/<p className="[^"]*\btruncate\b[^"]*\blg:hidden\b[^"]*">/);
    // A sitting business calls the Dogs step "Pets"; the line still names
    // the current step, only under the word that business uses.
    expect(bar).toMatch(
      /Step \{step \+ 1\} of \{steps\.length\}: \{current === "Dogs" && sitting \? "Pets" : current\}/,
    );
  });

  it("gives each dot its name, since the name beside it is hidden", () => {
    expect(bar).toMatch(/aria-label=\{`Step \$\{i \+ 1\}: \$\{label\}`\}/);
    expect(bar).toMatch(/aria-current=\{state === "current" \? "step" : undefined\}/);
  });

  it("keeps the touch floor on the dots", () => {
    expect(bar).toMatch(/touch:h-11 touch:w-11/);
  });
});

describe("a new step opens at its top", () => {
  it("scrolls the window to the top whenever the step changes", () => {
    expect(wizard).toMatch(
      /useEffect\(\(\) => \{[\s\S]{0,200}?window\.scrollTo\(\{ top: 0 \}\);\s*\}, \[step\]\);/,
    );
  });

  it("but not on mount, which is the router's scroll to decide", () => {
    const start = wizard.indexOf("const stepMounted");
    expect(start, "the mount guard was not found").toBeGreaterThan(-1);
    const effect = wizard.slice(start, wizard.indexOf("}, [step]);", start) + 1);
    expect(effect).toMatch(/if \(!stepMounted\.current\) \{\s*stepMounted\.current = true;\s*return;/);
  });
});

describe("the boundary sketch offers to clear only what was saved", () => {
  it("renders the save button only with a polygon drawn or one saved", () => {
    expect(sketch).toMatch(/\{!hideSave && \(currentPolygon \|\| initial\) && \(/);
  });

  it("still says Clear saved when there IS a saved boundary to clear", () => {
    // The label is unchanged; only when it can appear. Removing the option
    // outright would leave no way to take a boundary off a property.
    expect(sketch).toMatch(/currentPolygon \? "Save boundary" : "Clear saved"/);
  });

  it("the wizard feeds its saved boundary back in as `initial`", () => {
    // What makes `initial` mean "saved" on the Yard step: onSave writes the
    // state, and the state is what `initial` reads.
    expect(wizard).toMatch(/initial=\{boundary\}/);
    expect(wizard).toMatch(/onSave=\{\(poly\) => \{\s*setBoundary\(poly\);/);
  });
});
