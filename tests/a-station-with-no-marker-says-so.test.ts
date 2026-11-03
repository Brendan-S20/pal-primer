// R2-43 (waste-r2-07) was already fixed on main by #332 (7fd8ff2b): Add
// station with no map marker marks the location field and says what is
// missing. Until now only a browser spec checked it; this pins it in the unit
// suite so a refactor cannot quietly bring back the silent submit.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const panel = readFileSync(
  join(process.cwd(), "src/components/client-detail/stations-panel.tsx"),
  "utf8",
);

describe("Add station with no marker", () => {
  it("a new station needs a marker, an edited legacy one does not", () => {
    expect(panel).toMatch(/const needsMarker = !draft\.position && !draft\.id;/);
  });
  it("the submit stops, marks the fields and moves focus to the first", () => {
    expect(panel).toMatch(
      /if \(labelError \|\| needsMarker\) \{[\s\S]{0,200}setShowErrors\(true\);\s*focusFirstInvalid\(formRef\.current\);\s*return;/,
    );
  });
  it("the location field says what is missing", () => {
    expect(panel).toMatch(/aria-invalid=\{showMarkerError\}/);
    expect(panel).toMatch(/A new station needs one\./);
  });
});
