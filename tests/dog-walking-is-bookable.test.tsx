// Dog walking is bookable (#530).
//
// The path is booking (with a time window), the walker's day, the portal's walk
// reports and access, the client's emails, the reports and the invoices
// (#410). It went live once walking QA passed: walking joined
// BOOKABLE_SERVICE_LINES here and public.bookable_service_lines() in
// 20261023120000. Pet sitting, grooming and training stay Coming soon until
// their own QA. tests/pet-waste-and-walking-can-be-turned-on.test.ts holds the
// picker and the server check.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BOOKABLE_SERVICE_LINES, OFFERED_SERVICE_LINES } from "@/lib/service-lines";
import { serviceLineChoices } from "@/lib/services";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("which lines can be booked", () => {
  it("walking is offered and bookable, beside pet waste", () => {
    for (const line of ["pet_waste", "dog_walking"] as const) {
      expect(OFFERED_SERVICE_LINES).toContain(line);
      expect(BOOKABLE_SERVICE_LINES).toContain(line);
    }
  });

  it("sitting, grooming and training are offered and still Coming soon", () => {
    for (const line of ["pet_sitting", "mobile_grooming", "training"] as const) {
      expect(OFFERED_SERVICE_LINES).toContain(line);
      expect(BOOKABLE_SERVICE_LINES).not.toContain(line);
    }
  });

  it("a scooper can put a service on the walking line, and not on the sitting line", () => {
    expect(serviceLineChoices(["pet_waste"])).toContain("dog_walking");
    expect(serviceLineChoices(["pet_waste"])).not.toContain("pet_sitting");
  });

  it("a business that already sits keeps the sitting line", () => {
    expect(serviceLineChoices(["pet_sitting"])).toContain("pet_sitting");
    expect(serviceLineChoices(["pet_waste"], "pet_sitting")).toContain("pet_sitting");
  });
});

describe("copy about walking", () => {
  it("Settings > Services says pet waste removal and dog walking are bookable", () => {
    const page = read("src/routes/_authenticated/settings.services.tsx");
    expect(page).toMatch(
      /Pet\s+waste\s+removal\s+and\s+dog\s+walking\s+are\s+bookable\s+today;\s+other\s+service\s+lines\s+are\s+Coming\s+soon/,
    );
    expect(page).not.toMatch(/Only\s+pet\s+waste\s+removal\s+is\s+bookable/);
  });
});
