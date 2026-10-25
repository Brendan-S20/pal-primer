// A sitter knows who to call when a pet is sick (#411 review, blocker 3).
// The warning the office sees, what the sit card reads, and the shape of the
// migration. The database half is tests/integration/stay-contacts.db.test.ts.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stayContactGapsFor, stayContactGapsSentence } from "@/lib/stays";
import { sitEmergency, sitPets } from "@/lib/sit-day";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const sql = read("supabase/migrations/20261024080600_a-sitter-knows-who-to-call.sql");

const ready = {
  emergency_contact_name: "Sam",
  emergency_contact_phone: "512-555-0100",
  vet_treatment_limit_cents: 30000,
};
const vetted = { vet_clinic_name: "Eastside Animal Hospital", vet_clinic_phone: "512-555-0199" };

describe("what a stay is missing", () => {
  it("nothing when the contact, every pet's vet and the limit are on file", () => {
    expect(stayContactGapsFor(ready, [vetted, vetted])).toEqual([]);
    expect(stayContactGapsSentence([])).toBeNull();
  });

  it("names each gap, the way stay_contact_gaps does", () => {
    expect(stayContactGapsFor({ ...ready, emergency_contact_phone: "  " }, [vetted])).toEqual([
      "emergency_contact",
    ]);
    expect(stayContactGapsFor(ready, [vetted, { vet_clinic_name: "Eastside" }])).toEqual(["vet"]);
    expect(stayContactGapsFor({ ...ready, vet_treatment_limit_cents: null }, [vetted])).toEqual([
      "treatment_limit",
    ]);
    // A limit of $0 is a limit: call first.
    expect(stayContactGapsFor({ ...ready, vet_treatment_limit_cents: 0 }, [vetted])).toEqual([]);
    expect(stayContactGapsFor(null, [{}])).toEqual(["emergency_contact", "vet", "treatment_limit"]);
  });

  it("the office reads one sentence, and an unknown code is ignored", () => {
    expect(stayContactGapsSentence(["treatment_limit"])).toBe(
      "Missing: a vet treatment limit. The sitter needs this if a pet is sick.",
    );
    expect(stayContactGapsSentence(["vet", "emergency_contact", "later"])).toBe(
      "Missing: an emergency contact with a phone, a vet clinic and phone for every pet. The sitter needs these if a pet is sick.",
    );
    expect(stayContactGapsSentence(["later"])).toBeNull();
  });
});

describe("the sit card", () => {
  it("reads the emergency contact and limit from the client", () => {
    expect(
      sitEmergency({ ...ready, emergency_contact_name: " Sam ", emergency_contact_may_approve_vet: true }),
    ).toEqual({ name: "Sam", phone: "512-555-0100", mayApproveVet: true, limitCents: 30000 });
    expect(sitEmergency(null)).toEqual({
      name: null,
      phone: null,
      mayApproveVet: false,
      limitCents: null,
    });
  });

  it("each pet carries its vet, or none", () => {
    const [luna, max] = sitPets(
      [
        { id: "a", name: "Luna", species: "cat", ...vetted },
        { id: "b", name: "Max", species: "dog", vet_clinic_name: " " },
      ],
      null,
    );
    expect(luna.vet).toEqual({ name: "Eastside Animal Hospital", phone: "512-555-0199" });
    expect(max.vet).toBeNull();
  });

  it("My Day asks for the columns and draws the block on a sit card", () => {
    const fn = read("src/lib/my-day.functions.ts");
    expect(fn).toMatch(/emergency_contact_name, emergency_contact_phone, emergency_contact_may_approve_vet, vet_treatment_limit_cents/);
    expect(fn).toMatch(/vet_clinic_name, vet_clinic_phone/);
    expect(read("src/routes/_authenticated/my-day.tsx")).toMatch(
      /<SitEmergencyFacts emergency=\{sitEmergency\(visit\.clients\)\}/,
    );
  });
});

describe("the migration", () => {
  it("warns through stay_contact_gaps and leaves confirm_stay alone", () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.stay_contact_gaps\(_stay_id uuid\)/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.stay_contact_gaps\(uuid\) FROM PUBLIC, anon;/);
    expect(sql).toMatch(/public\.can_write_org\(\(SELECT auth\.uid\(\)\), st\.organization_id\)/);
    expect(sql).not.toMatch(/FUNCTION public\.confirm_stay/);
  });
});
