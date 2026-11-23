// #1022. A training lesson (and a walk, drop-in, house sit or groom) showed
// pet waste tools: "Medium property" on the My day card, and "Boundary map"
// and "+ DNA" in the visit drawer. They belong to pet waste visits only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isYardVisit } from "@/lib/walk-concerns";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

describe("which visits are yard visits", () => {
  it("only pet waste is, whatever the business runs", () => {
    for (const line of ["training", "walking", "pet_sitting", "grooming", "other"]) {
      expect(isYardVisit(line, true), line).toBe(false);
    }
    expect(isYardVisit("pet_waste", true)).toBe(true);
  });
});

describe("the pet waste tools sit behind that check", () => {
  const drawer = read("src/components/VisitDetailDrawer.tsx");
  const myDay = read("src/routes/_authenticated/my-day.tsx");

  it("Boundary map is a yard-visit link in the drawer", () => {
    expect(drawer).toMatch(
      /\{p\?\.id && yardVisit && \(\s*<Link\s+to="\/properties\/\$propertyId\/boundary"/,
    );
  });

  it("the DNA control is drawn only when the drawer says it is a yard visit", () => {
    expect(drawer).toContain("showDna={yardVisit}");
    expect(drawer).toContain("{showDna && <DogDnaControl");
    expect(drawer.match(/<DogDnaControl/g)).toHaveLength(1);
  });

  it("the yard size on a My day card needs a pet waste visit", () => {
    expect(myDay).toContain("(windowLabel || (petWaste && p?.yard_size))");
    expect(myDay).toContain("{petWaste && p?.yard_size && (");
    expect(myDay).toContain("const petWaste = isYardVisit(visit.services?.service_line");
  });
});
