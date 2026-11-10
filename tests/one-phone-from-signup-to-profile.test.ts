// The rules for handing one phone number between sign-up, setup step 1, the
// client portal and Profile (#787), in src/lib/phone-handoff.ts. The round
// trips through the real server functions are in
// what-onboarding-saves-settings-shows.test.ts.
import { describe, expect, it } from "vitest";
import {
  MIN_PHONE_DIGITS,
  handoffPhone,
  phoneDigits,
  setupBusinessPhonePrefill,
} from "@/lib/phone-handoff";

describe("handoffPhone", () => {
  it("hands on a whole number, trimmed, as typed", () => {
    expect(handoffPhone("  555-010-0199 ")).toBe("555-010-0199");
    expect(handoffPhone("+1 (555) 010-0199")).toBe("+1 (555) 010-0199");
  });

  it("does not hand on a blank or a fragment", () => {
    expect(handoffPhone(undefined)).toBeNull();
    expect(handoffPhone(null)).toBeNull();
    expect(handoffPhone("")).toBeNull();
    expect(handoffPhone("   ")).toBeNull();
    expect(handoffPhone("555-")).toBeNull();
    expect(handoffPhone("5".repeat(MIN_PHONE_DIGITS - 1))).toBeNull();
    expect(handoffPhone("5".repeat(MIN_PHONE_DIGITS))).toBe("5".repeat(MIN_PHONE_DIGITS));
  });
});

describe("phoneDigits", () => {
  it("keeps digits and drops punctuation", () => {
    expect(phoneDigits("(555) 010-0199")).toBe("5550100199");
    expect(phoneDigits(null)).toBe("");
  });
});

describe("setupBusinessPhonePrefill", () => {
  it("starts from the stored phone (the sign-up mobile) when nothing is typed", () => {
    expect(setupBusinessPhonePrefill(null, "555-010-0199")).toBe("555-010-0199");
    expect(setupBusinessPhonePrefill(undefined, null)).toBe("");
  });

  it("keeps a whole number typed on this device over the stored one", () => {
    expect(setupBusinessPhonePrefill("313-555-0142", "555-010-0199")).toBe("313-555-0142");
  });

  it("keeps a field the owner deliberately cleared", () => {
    expect(setupBusinessPhonePrefill("", "555-010-0199")).toBe("");
  });

  it("does not let a kept fragment cover the stored whole number", () => {
    expect(setupBusinessPhonePrefill("555-", "555-010-0199")).toBe("555-010-0199");
  });

  it("keeps a fragment when there is nothing better to show", () => {
    expect(setupBusinessPhonePrefill("555-", null)).toBe("555-");
  });
});
