// The one control in this app that is USED in a driveway had 30px rows.
//
// Address autocomplete exists because somebody is standing at a customer's
// house with a phone, adding the property they are looking at. The suggestion
// list is the whole feature: everything else is a text box. Its options were
// `px-2 py-1.5 text-sm` — about 30px tall, stacked with no separation, four of
// them inside a 256px popover hanging over a form column that is 328px wide on
// a 360px phone.
//
// CLAUDE.md puts the number at 44px and says the button, not the glyph. None
// of the four static checks that scan src/ can see this one: it is not a
// group-hover reveal, not a <table>, not a truncating flex row, and not
// ui/tabs.tsx. And the browser sweep in tests/viewports/ only loads PUBLIC
// routes — every form this control is now wired into is behind
// /_authenticated, and the dropdown only exists after three characters and a
// provider response, which no unconfigured deployment will ever produce. So
// this is checked here, against the source, deliberately.
//
// Three separate phone faults are pinned, because the fix for the first
// naturally invites the second and third:
//
//   - the tap target, 44px;
//   - the width — a fixed `w-80` popover is off the side of a 360px screen,
//     which CLAUDE.md names as the exact mistake, so the list tracks the
//     input's width and scrolls itself rather than the page;
//   - hover-only highlighting. Hover does not exist on a touchscreen and the
//     highlight also has to follow the arrow keys, so the selected row is
//     driven by `active` state, not by a `hover:` class.

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = readFileSync(join(ROOT, "src/components/AddressAutocomplete.tsx"), "utf8");

function element(tag: string, role: string): string {
  const start = SRC.indexOf(`role="${role}"`);
  expect(start, `a <${tag} role="${role}"> in the suggestion list`).toBeGreaterThan(-1);
  const open = SRC.lastIndexOf(`<${tag}`, start);
  return SRC.slice(open, SRC.indexOf(">", SRC.indexOf("className", start)) + 1);
}

/** Only what is inside className, with the // comments around it dropped.
 *  A comment that names `w-80` to say why it is not used must not read as a
 *  `w-80`; the first version of this file failed on its own explanation. */
function classesOf(el: string): string {
  const stripped = el.replace(/\/\/[^\n]*/g, "");
  return [...stripped.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{([\s\S]*?)\}\s*$)/g)]
    .map((m) => m[1] ?? m[2] ?? m[3] ?? "")
    .join(" ");
}

const optionElement = () => element("li", "option");
const listElement = () => element("ul", "listbox");

describe("a suggestion is a thumb-sized target", () => {
  it("each option is at least 44px tall", () => {
    // min-h-11 is 2.75rem is 44px. Padding alone does not do it: `py-2` on
    // 20px of line box is 36px, and the row has to survive a one-line address
    // as well as a wrapped one.
    expect(classesOf(optionElement()), 'the <li role="option"> className').toMatch(/\bmin-h-11\b/);
  });

  it("does not rely on a `md:` branch to be tappable", () => {
    // A phone is the small end. A 44px row that only exists above a
    // breakpoint is a 30px row on the device this feature is for.
    expect(classesOf(optionElement())).not.toMatch(/\b(sm|md|lg):min-h-/);
  });
});

describe("the list fits a 360px phone", () => {
  it("tracks the input's width instead of setting its own", () => {
    const ul = classesOf(listElement());
    expect(ul, "the listbox className").toMatch(/\bw-full\b/);
    // The exact mistake CLAUDE.md names: "A fixed `w-80` popover overflows a
    // 360px viewport."
    expect(ul, "no fixed width on the popover").not.toMatch(/\bw-(64|72|80|96|\[\d)/);
  });

  it("scrolls inside itself rather than growing the page", () => {
    const ul = classesOf(listElement());
    expect(ul).toMatch(/\bmax-h-\d+\b/);
    expect(ul).toMatch(/\boverflow-y-auto\b/);
  });

  it("lets a long address wrap instead of widening the row", () => {
    // The flex rule from CLAUDE.md, on the one row in this component that has
    // a pin beside text: without min-w-0 the row is laid out as wide as the
    // address and the pin goes over the edge.
    const li = classesOf(optionElement());
    expect(li, "the option row is a flex row").toMatch(/\bflex\b/);
    const text = SRC.slice(SRC.indexOf("</li>", SRC.indexOf('role="option"')) - 400);
    expect(text.slice(0, 400), "the text span beside the pin").toMatch(/min-w-0/);
  });
});

describe("nothing here is hover-only", () => {
  it("highlights the active row from state, not from a hover class", () => {
    const li = optionElement();
    expect(li, "highlight driven by `active`").toMatch(/i === active/);
    expect(classesOf(li), "no hover: class doing the highlighting").not.toMatch(/hover:bg-/);
  });

  it("the keyboard can reach and choose a suggestion", () => {
    // A touch user gets the row; a keyboard user gets these. Both need the
    // same `active`, which is why the highlight above is state and not CSS.
    for (const key of ["ArrowDown", "ArrowUp", "Enter", "Escape"]) {
      expect(SRC, `handles ${key}`).toMatch(new RegExp(`e\\.key === "${key}"`));
    }
    expect(SRC, "the active row is announced").toMatch(/aria-activedescendant=/);
  });
});
