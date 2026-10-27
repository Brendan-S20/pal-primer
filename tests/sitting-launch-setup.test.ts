import { describe, expect, it } from "vitest";
import en from "@/lib/i18n/locales/en";
import es from "@/lib/i18n/locales/es";
import ar from "@/lib/i18n/locales/ar";
import zh from "@/lib/i18n/locales/zh";
import { techSkipReasonCodes } from "@/lib/skip-rules.functions";
import {
  customerCanRequestStay,
  addOnExampleFor,
  serviceLinesAdditionProblem,
} from "@/lib/service-lines";
import { LAUNCH_DEFAULT, withoutBookable } from "./support/service-line-availability";

describe("sitting is bookable (#547)", () => {
  it("offers sitter reasons in every worker language", () => {
    const codes = techSkipReasonCodes("pet_sitting");
    expect(codes).toEqual(["pet_hiding", "key_failed", "client_home", "access_blocked", "other"]);
    for (const locale of [en, es, ar, zh]) {
      expect(Object.keys(locale.sitSkipReason)).toEqual(codes);
      for (const value of Object.values(locale.sitSkipReason))
        expect(value.length).toBeGreaterThan(0);
    }
    expect(techSkipReasonCodes("pet_waste")).not.toContain("pet_hiding");
    expect(techSkipReasonCodes("dog_walking")).not.toContain("client_home");
  });
  it("offers an extra pet add-on and lets an owner turn sitting on", () => {
    expect(addOnExampleFor(["pet_sitting"])).toEqual({ code: "extra_pet", name: "Extra pet" });
    expect(LAUNCH_DEFAULT.bookable).toContain("pet_sitting");
    expect(customerCanRequestStay(LAUNCH_DEFAULT)).toBe(true);
    expect(customerCanRequestStay(withoutBookable("pet_sitting"))).toBe(false);
    expect(
      serviceLinesAdditionProblem(["pet_waste"], ["pet_waste", "pet_sitting"], LAUNCH_DEFAULT),
    ).toBeNull();
    expect(
      serviceLinesAdditionProblem(
        ["pet_waste"],
        ["pet_waste", "pet_sitting"],
        withoutBookable("pet_sitting"),
      ),
    ).toBe("That service is coming soon.");
  });
  it("uses neutral fallback words without a service line", () => {
    expect([
      en.term.service,
      en.term.site,
      en.term.complete,
      en.term.notes,
      en.term.access,
      en.term.photo,
    ]).toEqual(["Visit", "Home", "Mark done", "Notes", "Access", "Photo"]);
    expect(en.term.service_pet_waste).toBe("Cleanup");
  });
});
