import { describe, expect, it } from "vitest";
import { contactProblems, looksLikePhone } from "@/lib/form-errors";

// #1010: step 1 of the new-client wizard let "not-an-email" through, and the
// save failed three steps later with no field named.
describe("new-client contact checks", () => {
  it("lets both fields be empty", () => {
    expect(contactProblems("", "")).toEqual({});
    expect(contactProblems("  ", "  ")).toEqual({});
  });
  it("rejects a malformed email and says so next to the email", () => {
    expect(contactProblems("not-an-email", "").email).toBeTruthy();
    expect(contactProblems("bob@", "").email).toBeTruthy();
    expect(contactProblems("bob@example.com", "").email).toBeUndefined();
  });
  it("rejects a text-only or too-short phone", () => {
    expect(contactProblems("", "abc").phone).toBeTruthy();
    expect(contactProblems("", "12").phone).toBeTruthy();
  });
  it("accepts ordinary phone formats", () => {
    for (const p of ["555-010-0199", "(555) 010-0199", "+1 555 010 0199", "555.010.0199 x12"]) {
      expect(looksLikePhone(p)).toBe(true);
    }
  });
});
