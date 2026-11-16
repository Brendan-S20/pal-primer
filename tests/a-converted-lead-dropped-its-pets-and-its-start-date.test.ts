// A converted lead dropped its pets, its access note and its start date (#657).
//
// Audit round 2 (2026-10-30, R2-13). The booking link has asked for the pets
// by name, "Gate code or access notes" and a start date since #527, and stored
// all three on the lead. Converting the lead read none of them: the wizard
// opened on two unnamed dog rows for Waffles and Mochi, no access note, and a
// start of tomorrow for a lead that asked for November 9. And a grooming lead
// went through the recurring Plan step, which priced "Full groom, weekly,
// Mon-Fri, $80" where the size grid said $115 plus a $25 add-on.
//
// These pin the mapping (pure, src/lib/lead-conversion.ts) and the wiring that
// carries it to the property, the plan and Book a groom.

import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  leadBooksAGroom,
  leadPets,
  leadStartDate,
  leadToWizardPrefill,
  splitBreedAndSize,
  type ConvertibleLead,
} from "@/lib/lead-conversion";
import { petSize } from "@/lib/groom";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const LEAD: ConvertibleLead = {
  id: "7d0c5c4e-0000-4000-8000-000000000657",
  name: "Priya Shah",
  email: "priya@example.com",
  phone: "555-0100",
  company: null,
  location: "41 Birch Ln, Austin, TX 78704",
  dog_count: 2,
  frequency: null,
  message: "Both are nervous with clippers.",
  source: "booking_link",
  status: "new",
  converted_client_id: null,
  service_id: "11111111-1111-4111-8111-111111111111",
  pets: [
    { name: "Waffles", breed: "Goldendoodle, large" },
    { name: "Mochi", breed: "Small" },
  ],
  access_notes: "Side gate, code 4410. Ring twice.",
  preferred_start_date: "2026-11-09",
};

describe("the lead's pets become the wizard's dog rows", () => {
  it("names each row, in order, with its breed and size", () => {
    const p = leadToWizardPrefill(LEAD);
    expect(p.dogs.map((d) => [d.name, d.breed, d.weightClass])).toEqual([
      ["Waffles", "Goldendoodle", "large"],
      ["Mochi", "", "small"],
    ]);
    // The size is one the groom grid reads.
    expect(p.dogs.map((d) => petSize(d.weightClass))).toEqual(["large", "small"]);
  });

  it("adds a blank row for each dog counted but not named", () => {
    const p = leadToWizardPrefill({ ...LEAD, dog_count: 3 });
    expect(p.dogs.map((d) => d.name)).toEqual(["Waffles", "Mochi", ""]);
  });

  it("keeps every named pet when the count says fewer", () => {
    const p = leadToWizardPrefill({ ...LEAD, dog_count: 1 });
    expect(p.dogs).toHaveLength(2);
  });

  it("reads anything that is not an array of pets as no pets", () => {
    expect(leadPets(null)).toEqual([]);
    expect(leadPets("Waffles")).toEqual([]);
    expect(leadPets([{ name: " " }, { breed: "Lab" }, 7])).toEqual([{ name: "", breed: "Lab" }]);
    const p = leadToWizardPrefill({ ...LEAD, pets: null, dog_count: 2 });
    expect(p.dogs.map((d) => d.name)).toEqual(["", ""]);
  });

  it("splits a breed from a size without eating the breed", () => {
    expect(splitBreedAndSize("Labrador")).toEqual({ breed: "Labrador", weightClass: "" });
    expect(splitBreedAndSize("Large")).toEqual({ breed: "", weightClass: "large" });
    expect(splitBreedAndSize("Beagle (medium)")).toEqual({
      breed: "Beagle",
      weightClass: "medium",
    });
    expect(splitBreedAndSize("XL mastiff")).toEqual({ breed: "mastiff", weightClass: "xlarge" });
    expect(splitBreedAndSize("small dog")).toEqual({ breed: "", weightClass: "small" });
    // "Smallwood" is not "small".
    expect(splitBreedAndSize("Smallwood terrier").weightClass).toBe("");
  });
});

describe("the access note and the start date", () => {
  it("carries both", () => {
    const p = leadToWizardPrefill(LEAD);
    expect(p.accessNotes).toBe("Side gate, code 4410. Ring twice.");
    expect(p.startDate).toBe("2026-11-09");
  });

  it("starts on the asked day unless it has passed", () => {
    expect(leadStartDate("2026-11-09", "2026-11-02", "2026-11-03")).toBe("2026-11-09");
    expect(leadStartDate("2026-11-02", "2026-11-02", "2026-11-03")).toBe("2026-11-02");
    expect(leadStartDate("2026-10-31", "2026-11-02", "2026-11-03")).toBe("2026-11-03");
    expect(leadStartDate(null, "2026-11-02", "2026-11-03")).toBe("2026-11-03");
    expect(leadStartDate("Nov 9", "2026-11-02", "2026-11-03")).toBe("2026-11-03");
  });

  it("is empty for a lead from before the booking link asked", () => {
    const p = leadToWizardPrefill({
      ...LEAD,
      pets: undefined,
      access_notes: undefined,
      preferred_start_date: undefined,
    });
    expect(p.accessNotes).toBe("");
    expect(p.startDate).toBeNull();
  });
});

describe("a grooming lead books a groom", () => {
  it("is decided by the lead's service", () => {
    expect(leadBooksAGroom("mobile_grooming", ["pet_waste", "mobile_grooming"])).toBe(true);
    expect(leadBooksAGroom("pet_waste", ["pet_waste", "mobile_grooming"])).toBe(false);
    expect(leadBooksAGroom("dog_walking", ["mobile_grooming"])).toBe(false);
  });

  it("is a groom with no service only at a grooming-only business", () => {
    expect(leadBooksAGroom(null, ["mobile_grooming"])).toBe(true);
    expect(leadBooksAGroom(null, ["pet_waste", "mobile_grooming"])).toBe(false);
  });
});

describe("the wiring", () => {
  const wizard = read("src/routes/_authenticated/clients.new.tsx");
  const onboard = read("src/lib/clients.functions.ts");
  const server = read("src/lib/lead-conversion.server.ts");
  const client = read("src/routes/_authenticated/clients.$clientId.tsx");
  const visits = read("src/components/client-detail/VisitsTab.tsx");
  const dialog = read("src/components/BookGroomDialog.tsx");

  it("reads the three columns off the lead", () => {
    expect(server).toMatch(/lead\.pets\s*=/);
    expect(server).toMatch(/lead\.access_notes\s*=/);
    expect(server).toMatch(/lead\.preferred_start_date\s*=/);
  });

  it("saves the access note to the property", () => {
    expect(wizard).toMatch(/accessNotes:\s*\(accessNotes \?\? ""\)\.trim\(\)/);
    expect(onboard).toMatch(/access_notes:\s*data\.accessNotes/);
  });

  it("starts the plan on the lead's day", () => {
    expect(wizard).toMatch(/leadStartDate\(prefill\.startDate/);
  });

  it("drops the Plan step for a groom lead and writes no subscription", () => {
    expect(wizard).toMatch(/booksGroom && s === "Plan"/);
    expect(wizard).toMatch(/subscription:\s*planSkipped/);
  });

  it("lands on Book a groom with the lead's service and day", () => {
    expect(wizard).toMatch(/bookGroom:\s*true/);
    expect(client).toMatch(/setPendingGroom\(/);
    expect(visits).toMatch(/startFrom=\{groomStart\}/);
    // Without booking, the owner of the screen is told rather than left on
    // an empty Visits tab.
    expect(visits).toMatch(/Ask someone who can book to schedule the groom/);
    expect(visits).toMatch(/Grooming isn't turned on for this business/);
    expect(dialog).toMatch(/startFrom\?\.serviceId/);
    expect(dialog).toMatch(/notBeforeToday\(startFrom\.scheduledOn, today\)/);
  });
});
