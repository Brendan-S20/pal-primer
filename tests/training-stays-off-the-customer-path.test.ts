import { describe, expect, it } from "vitest";
import { customerCanRequestService } from "../src/lib/service-lines";
import { oneOffServiceOptions } from "../src/lib/one-off-booking";
import { publicServiceChoices } from "../src/lib/public-services";
import { bookVisit, getOpenSlots, listServices } from "../src/lib/receptionist-booking";
import type { ReceptionistStore } from "../src/lib/receptionist-booking";
import { progressText, scoreProblem } from "../src/lib/training-progress";

const lesson = {
  id: "lesson",
  name: "Private lesson (60 min)",
  service_line: "training" as const,
  active: true,
  price_unit: "visit" as const,
  base_price_cents: 8000,
  extra_pet_cents: 0,
  default_duration_min: 60,
};

const walk = {
  id: "walk",
  name: "30-minute walk",
  service_line: "dog_walking" as const,
  active: true,
  price_unit: "visit" as const,
  base_price_cents: 2500,
  extra_pet_cents: 0,
  default_duration_min: 30,
};

describe("customers cannot request training", () => {
  it("keeps the line off the portal, the public form and the receptionist", async () => {
    expect(customerCanRequestService("training")).toBe(false);
    expect(customerCanRequestService("dog_walking")).toBe(true);
    expect(oneOffServiceOptions([lesson, walk], null).map((s) => s.id)).toEqual(["walk"]);
    expect(publicServiceChoices([lesson, walk]).map((s) => s.id)).toEqual(["walk"]);

    const store = {
      org: async () => ({
        timezone: "America/Chicago",
        work_days: [1, 2, 3, 4, 5],
        one_off_price_cents: 4500,
        portal_auto_accept_bookings: true,
        route_windows: null,
      }),
      services: async () => [lesson, walk],
    } as unknown as ReceptionistStore;
    const caller = { orgId: "org", fromNumber: "+15555550100", clientId: null };
    const listed = await listServices(store, caller);
    expect(listed).toMatchObject({
      services: [{ service_id: "walk", kind: "dog_walking" }],
    });
    expect(JSON.stringify(listed)).not.toMatch(/lesson|training/);
    await expect(getOpenSlots(store, caller, { service_id: "lesson" })).resolves.toEqual({
      available: false,
      reason: "service_not_offered",
    });
    await expect(
      bookVisit(store, caller, { date: "2026-10-20", service_id: "lesson" }),
    ).resolves.toEqual({ booked: false, reason: "service_not_offered" });
  });
});

describe("a lesson score is 1 to 5, and a long note is refused rather than stored", () => {
  it("names a score that is not a whole number from 1 to 5", () => {
    expect(scoreProblem(3)).toBeNull();
    expect(scoreProblem(0)).toMatch(/1 to 5/);
    expect(scoreProblem(1.5)).toMatch(/1 to 5/);
    expect(scoreProblem("3")).toMatch(/1 to 5/);
  });

  it("returns the text and the problem apart, so the error sentence is never the note", () => {
    expect(progressText("  Sit twice  ", 20, "session note")).toEqual({
      text: "Sit twice",
      problem: null,
    });
    expect(progressText("   ", 20, "session note")).toEqual({ text: null, problem: null });
    const tooLong = progressText("x".repeat(21), 20, "session note");
    expect(tooLong.text).toBeNull();
    expect(tooLong.problem).toMatch(/20 characters/);
    expect(tooLong.problem).not.toBe("x".repeat(21));
  });
});
