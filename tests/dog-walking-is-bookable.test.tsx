// Dog walking is bookable (#530).
//
// The path is booking (with a time window), the walker's day, the portal's walk
// reports and access, the client's emails, the reports and the invoices
// (#410). It went live once walking QA passed, in 20261024230000; since #531
// it is a row of the platform switch (platform_service_lines), seeded on by
// 20261025200000 and mirrored by LAUNCH_DEFAULT. Pet sitting joined it in
// 20261026200000 (#547); grooming and training stay Coming soon until their
// own QA. tests/pet-waste-and-walking-can-be-turned-on.test.ts holds the
// picker and the server check.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OFFERED_SERVICE_LINES } from "@/lib/service-lines";
import { serviceLineChoices } from "@/lib/services";
import { LAUNCH_DEFAULT } from "./support/service-line-availability";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("which lines can be booked", () => {
  it("walking is offered and bookable, beside pet waste and pet sitting", () => {
    for (const line of ["pet_waste", "dog_walking", "pet_sitting"] as const) {
      expect(OFFERED_SERVICE_LINES).toContain(line);
      expect(LAUNCH_DEFAULT.bookable).toContain(line);
    }
  });

  it("grooming and training are offered and still Coming soon", () => {
    for (const line of ["mobile_grooming", "training"] as const) {
      expect(OFFERED_SERVICE_LINES).toContain(line);
      expect(LAUNCH_DEFAULT.bookable).not.toContain(line);
    }
  });

  it("a scooper can put a service on the walking or sitting line, and not on grooming or training", () => {
    expect(serviceLineChoices(["pet_waste"], LAUNCH_DEFAULT)).toContain("dog_walking");
    expect(serviceLineChoices(["pet_waste"], LAUNCH_DEFAULT)).toContain("pet_sitting");
    expect(serviceLineChoices(["pet_waste"], LAUNCH_DEFAULT)).not.toContain("mobile_grooming");
    expect(serviceLineChoices(["pet_waste"], LAUNCH_DEFAULT)).not.toContain("training");
  });

  it("a business that already runs a Coming soon line keeps it", () => {
    expect(serviceLineChoices(["training"], LAUNCH_DEFAULT)).toContain("training");
    expect(serviceLineChoices(["pet_waste"], LAUNCH_DEFAULT, "training")).toContain("training");
  });
});

describe("copy about walking", () => {
  it("Settings > Services says pet waste removal, dog walking and pet sitting are bookable", () => {
    const page = read("src/routes/_authenticated/settings.services.tsx");
    expect(page).toMatch(
      /Pet\s+waste\s+removal,\s+dog\s+walking\s+and\s+pet\s+sitting\s+are\s+bookable\s+today;\s+other\s+service\s+lines\s+are\s+Coming\s+soon/,
    );
    expect(page).not.toMatch(/Only\s+pet\s+waste\s+removal\s+is\s+bookable/);
  });
});
