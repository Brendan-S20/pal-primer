// A checklist the viewport sweep can see.
//
// CLAUDE.md: "A fixture of the wrong SHAPE measures the fallback, and looks
// exactly as green as one of the right shape." My Day draws the checklist from
// `getMyOrg().organization.visit_checklist` through `parseChecklist`, which
// drops anything that is not `{id, label, required}` rather than drawing a
// blank row a tech cannot satisfy. So a fixture with, say, `{ name, mandatory }`
// items would draw NO checklist, and the sweep would measure a card without
// one at 320px and pass.
//
// This runs the fixture through the parser the page uses, and pins the two
// things that make it worth measuring: a label as long as the database allows,
// and a word with no break in it.

import { describe, expect, it } from "vitest";
import { ORGANIZATION, VISIT_CHECKLIST } from "./viewports/fixtures/dataset";
import {
  MAX_CHECKLIST_LABEL,
  checklistProblem,
  missingRequired,
  parseChecklist,
} from "@/lib/visit-checklist";

describe("the sweep's organization has a checklist My Day will draw", () => {
  it("survives the parser the page reads it through, every item", () => {
    const drawn = parseChecklist(ORGANIZATION.visit_checklist);
    expect(drawn).toHaveLength(VISIT_CHECKLIST.length);
    expect(drawn.length).toBeGreaterThanOrEqual(3);
    // And would be accepted by the database, so it is a state production can hold.
    expect(checklistProblem(drawn)).toBeNull();
  });

  it("is awkward: a label at the database's limit, and an unbreakable word", () => {
    const drawn = parseChecklist(ORGANIZATION.visit_checklist);
    expect(Math.max(...drawn.map((i) => i.label.length))).toBe(MAX_CHECKLIST_LABEL);
    // Split on every break opportunity a browser takes unasked (spaces and
    // hyphens), so a hyphenated "long word" cannot satisfy this.
    expect(drawn.some((i) => i.label.split(/[\s-]+/).some((w) => w.length >= 40))).toBe(true);
  });

  it("holds Complete, so the hint under the button is drawn and measured too", () => {
    // The in-progress card starts with nothing ticked.
    expect(
      missingRequired(parseChecklist(ORGANIZATION.visit_checklist), []).length,
    ).toBeGreaterThan(0);
  });
});
