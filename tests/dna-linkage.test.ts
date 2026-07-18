import { describe, expect, it } from "vitest";
import {
  isValidEntityName,
  isValidLabel,
  assertValidDogName,
  assertValidUnitLabel,
  dogNeedsUnitReview,
  resolveResponsibleParty,
} from "@/lib/dna-linkage";

// I13 #14 — unit-keyed DNA registration + existing-dog lookup / name validation.
describe("dog name validation (B8)", () => {
  it("rejects the placeholders QA caught being accepted", () => {
    for (const bad of ["1", "01", "12", "Ew", "ew", "  ", "", "test", "n/a", "."]) {
      expect(isValidEntityName(bad)).toBe(false);
    }
  });

  it("allows legitimate short and normal dog names", () => {
    // "Na" was a false positive of the original blacklist (QA phase-6 F2) — a
    // plausible real short name that must pass alongside the other short names.
    for (const good of ["Bo", "Al", "Ax", "Na", "CJ", "Jo", "Ty", "Ed", "Rex", "Luna", "Mr. Peanutbutter"]) {
      expect(isValidEntityName(good)).toBe(true);
    }
  });

  it("accepts non-Latin names (Unicode letters), still rejects number-only (QA phase-9)", () => {
    for (const good of ["北京宠物", "Мухтар", "Müller", "Café", "O'Brien"]) {
      expect(isValidEntityName(good)).toBe(true);
    }
    for (const bad of ["12", "01", "123", " 45 "]) {
      expect(isValidEntityName(bad)).toBe(false);
    }
  });

  it("assertValidDogName trims and throws a human-readable message", () => {
    expect(assertValidDogName("  Rex ")).toBe("Rex");
    expect(() => assertValidDogName("1")).toThrow(/real dog name/i);
  });
});

describe("unit label validation", () => {
  it("allows numeric unit labels but rejects blanks/placeholders", () => {
    expect(isValidLabel("101")).toBe(true);
    expect(isValidLabel("B-12")).toBe(true);
    expect(isValidLabel("")).toBe(false);
    expect(isValidLabel("   ")).toBe(false);
    expect(isValidLabel("n/a")).toBe(false);
    expect(assertValidUnitLabel(" 204 ")).toBe("204");
  });
});

// I5 — orphan dogs go to management review, never a silent guess.
describe("dog → property → unit reconciliation", () => {
  it("flags a dog on a unit-bearing property with no unit", () => {
    expect(dogNeedsUnitReview({ unitId: null, propertyHasUnits: true })).toBe(true);
  });

  it("does not flag an assigned dog", () => {
    expect(dogNeedsUnitReview({ unitId: "u1", propertyHasUnits: true })).toBe(false);
  });

  it("does not flag a dog whose property has no units (residential model)", () => {
    expect(dogNeedsUnitReview({ unitId: null, propertyHasUnits: false })).toBe(false);
  });
});

// I13 #15 — sample → unit / responsible-party match.
describe("resolveResponsibleParty (sample → unit → responsible party)", () => {
  it("resolves to the unit's resident when the dog is assigned to a unit", () => {
    const r = resolveResponsibleParty({
      id: "d1",
      name: "Rex",
      unitId: "u214",
      propertyId: "p1",
      clientId: "c1",
      residentName: "Jamie Chen",
    });
    expect(r.unitResolved).toBe(true);
    expect(r.unitId).toBe("u214");
    expect(r.responsible).toBe("Jamie Chen");
  });

  it("falls back to the dog owner and marks unresolved when no unit", () => {
    const r = resolveResponsibleParty({
      id: "d2",
      name: "Luna",
      unitId: null,
      propertyId: "p1",
      clientId: "c1",
    });
    expect(r.unitResolved).toBe(false);
    expect(r.responsible).toBe("Luna");
  });
});
