// Dog walking is built (#410) and waits for the owner's go-live approval.
//
// The path is booking (with a time window), the walker's day, the portal's walk
// reports and access, the client's emails, the reports and the invoices. It is
// all in, and walking still stays out of BOOKABLE_SERVICE_LINES until the owner
// approves it (#479). A business that already runs walking keeps every walk
// screen; a business that does not cannot pick it up from Settings → Services.
// tests/only-pet-waste-can-be-turned-on.test.ts holds the picker and the server
// check.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BOOKABLE_SERVICE_LINES, OFFERED_SERVICE_LINES } from "@/lib/service-lines";
import { serviceLineChoices } from "@/lib/services";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("which lines can be booked", () => {
  it("walking is offered and Coming soon, like sitting, grooming and training", () => {
    for (const line of ["dog_walking", "pet_sitting", "mobile_grooming", "training"] as const) {
      expect(OFFERED_SERVICE_LINES).toContain(line);
      expect(BOOKABLE_SERVICE_LINES).not.toContain(line);
    }
  });

  it("a scooper cannot put a service on the walking line", () => {
    expect(serviceLineChoices(["pet_waste"])).not.toContain("dog_walking");
  });

  it("a business that already walks keeps the walking line", () => {
    expect(serviceLineChoices(["dog_walking"])).toContain("dog_walking");
    expect(serviceLineChoices(["pet_waste"], "dog_walking")).toContain("dog_walking");
  });
});

describe("copy about walking", () => {
  it("Settings > Services says only pet waste removal is bookable", () => {
    const page = read("src/routes/_authenticated/settings.services.tsx");
    expect(page).toMatch(
      /Only\s+pet\s+waste\s+removal\s+is\s+bookable\s+today;\s+other\s+service\s+lines\s+are\s+Coming\s+soon/,
    );
    expect(page).not.toMatch(/dog walking are bookable/i);
  });
});
