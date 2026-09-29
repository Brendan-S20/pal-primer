// An edited quote could lose its lines.
//
// Saving a draft deleted every line and then inserted the new ones, as two
// separate calls. When the insert failed (a line the database refused, a
// dropped connection), the draft was left with no lines at all, and the
// office's work was gone. Now the new lines go in first and the old ones are
// removed by id afterwards, so a failed insert changes nothing.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dirname, "../src/lib/quotes.functions.ts"), "utf8");
const code = src.replace(/\/\/[^\n]*/g, "");
const save = code.slice(
  code.indexOf("export const saveQuoteDraft"),
  code.indexOf("export const deleteQuoteDraft"),
);

describe("saving a draft", () => {
  it("inserts the new lines before it deletes any old ones", () => {
    const insertAt = save.search(/\.from\("quote_line_items"\)\s*\.insert\(/);
    const deleteAt = save.search(/\.delete\(\)\s*\.in\("id", oldLineIds\)/);
    expect(insertAt, "the insert moved").toBeGreaterThan(-1);
    expect(deleteAt, "the delete of old lines moved").toBeGreaterThan(-1);
    expect(insertAt).toBeLessThan(deleteAt);
  });

  it("never deletes a draft's lines wholesale by quote id", () => {
    expect(save).not.toMatch(/\.delete\(\)\s*\.eq\("quote_id"/);
  });

  it("throws on a failed insert before reaching the delete", () => {
    const failed = save.slice(save.indexOf("if (lErr) {"), save.indexOf("if (oldLineIds.length)"));
    expect(failed).toMatch(/throw new Error\(lErr\.message\)/);
  });

  it("takes the new lines back out if the old ones could not be removed", () => {
    const tail = save.slice(save.indexOf("if (oldLineIds.length)"));
    expect(tail).toMatch(/if \(dErr\) \{[\s\S]*?\.delete\(\)\.in\("id", newIds\)[\s\S]*?throw/);
  });
});
