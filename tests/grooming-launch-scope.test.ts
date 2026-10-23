import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  BOOKABLE_SERVICE_LINES,
  customerCanRequestService,
  serviceLinesAdditionProblem,
} from "@/lib/service-lines";
import { DEFAULT_GROOM_BUFFER_MIN, groomHoldMinutes } from "@/lib/groom";
import {
  PORTAL_VACCINE_UPLOADS_ENABLED,
  groomVaccineDecision,
  vaccineStatus,
} from "@/lib/vaccines";
import { techSkipReasonCodes } from "@/lib/skip-rules.functions";

describe("grooming first customer scope", () => {
  it("keeps pet waste bookable and grooming Coming soon in every customer check", () => {
    expect(BOOKABLE_SERVICE_LINES).toEqual(["pet_waste"]);
    expect(customerCanRequestService("pet_waste")).toBe(true);
    expect(customerCanRequestService("mobile_grooming")).toBe(false);
    expect(serviceLinesAdditionProblem(["pet_waste"], ["pet_waste", "mobile_grooming"])).toMatch(
      /coming soon/,
    );
    expect(
      serviceLinesAdditionProblem(["mobile_grooming"], ["mobile_grooming", "pet_waste"]),
    ).toBeNull();
  });
  it("holds 30 minutes for setup, cleanup and travel", () => {
    expect(DEFAULT_GROOM_BUFFER_MIN).toBe(30);
    expect(groomHoldMinutes(90, DEFAULT_GROOM_BUFFER_MIN)).toBe(120);
  });
  it("requires proof seen on office records and evaluates the appointment date", () => {
    const record = {
      vaccine: "rabies",
      expires_on: "2027-03-01",
      source: "office",
      verified_at: null,
    };
    expect(groomVaccineDecision("warn", vaccineStatus([record], ["rabies"], "2027-02-01"))).toBe(
      "warn",
    );
    const verified = { ...record, verified_at: "2026-10-23T12:00:00Z" };
    expect(groomVaccineDecision("block", vaccineStatus([verified], ["rabies"], "2027-02-01"))).toBe(
      "allow",
    );
    expect(groomVaccineDecision("block", vaccineStatus([verified], ["rabies"], "2027-03-02"))).toBe(
      "block",
    );
    expect(PORTAL_VACCINE_UPLOADS_ENABLED).toBe(false);
  });
  it("offers grooming reasons without changing the pet waste picker", () => {
    expect(techSkipReasonCodes(false, true)).toEqual([
      "dog_outside",
      "no_one_home",
      "access_blocked",
      "unsafe_conditions",
      "weather",
      "other",
    ]);
    expect(techSkipReasonCodes(false)).toContain("gate_locked");
    expect(techSkipReasonCodes(false, true)).not.toContain("gate_locked");
  });
  it("seeds only missing grooming prices, never overwrites a business's prices", () => {
    const sql = readFileSync(
      "supabase/migrations/20261023180000_grooming-launch-defaults.sql",
      "utf8",
    );
    expect(sql).toContain("ON CONFLICT DO NOTHING");
    expect(sql).not.toMatch(/UPDATE public\.(services|service_size_rules)|DELETE FROM/);
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION public.tg_org_grooming_defaults() FROM PUBLIC, anon, authenticated",
    );
  });
});
