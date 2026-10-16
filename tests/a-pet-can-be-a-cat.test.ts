// A pet can be a cat (#411, part 1): species on public.dogs, care
// instructions per pet, and every count that means DOGS still counting dogs.
//
// The database half runs in tests/integration/stays.db.test.ts (RLS on care
// instructions, the species check). This file pins the migration's text, the
// pure rules in src/lib/pets.ts, and the places that count dogs.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  activeDogCount,
  careIsEmpty,
  cleanMeds,
  cleanSpeciesNote,
  isDog,
  medsProblem,
  petsHeading,
  readMeds,
  runsPetSitting,
  speciesLabel,
  type PetMed,
} from "@/lib/pets";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const MIGRATION = "supabase/migrations/20261016110000_a-pet-can-be-a-cat.sql";
const sql = read(MIGRATION);
const code = sql.replace(/--[^\n]*/g, "");

describe("the migration", () => {
  it("gives every pet a species, defaulting to dog, and keeps the table's name", () => {
    expect(code).toMatch(
      /ALTER TABLE public\.dogs ADD COLUMN IF NOT EXISTS species text NOT NULL DEFAULT 'dog'/,
    );
    expect(code).toMatch(/CHECK \(species IN \('dog', 'cat', 'other'\)\)/);
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS species_note text/);
    expect(code).toMatch(/char_length\(species_note\) <= 40/);
    expect(code).toMatch(/COMMENT ON TABLE public\.dogs IS\s*'Every pet a client has/);
    expect(code).not.toMatch(/ALTER TABLE public\.dogs RENAME/i);
  });

  it("adds care instructions, one row per pet, removed with the pet", () => {
    expect(code).toMatch(
      /pet_id uuid PRIMARY KEY REFERENCES public\.dogs\(id\) ON DELETE CASCADE/,
    );
    expect(code).toMatch(/char_length\(feeding\) <= 500/);
    expect(code).toMatch(/char_length\(other_care\) <= 1000/);
    expect(code).toMatch(/meds jsonb NOT NULL DEFAULT '\[\]'::jsonb/);
    expect(code).toMatch(/CHECK \(jsonb_typeof\(meds\) = 'array'\)/);
    expect(code).toMatch(/CHECK \(public\.pet_meds_are_valid\(meds\)\)/);
  });

  it("locks care instructions down: RLS, two-step, office writes, no anon", () => {
    expect(code).toMatch(/ALTER TABLE public\.pet_care_instructions ENABLE ROW LEVEL SECURITY/);
    expect(code).toMatch(/SELECT public\.require_mfa_policy\('public\.pet_care_instructions'\)/);
    expect(code).toMatch(/REVOKE ALL ON TABLE public\.pet_care_instructions FROM PUBLIC, anon/);
    const policies = code.match(/CREATE POLICY[\s\S]*?;/g) ?? [];
    const care = policies.filter((p) => /ON public\.pet_care_instructions/.test(p));
    expect(care).toHaveLength(4);
    for (const p of care.filter((p) => !/FOR SELECT/.test(p)))
      expect(p).toMatch(/can_write_org\(\(SELECT auth\.uid\(\)\), organization_id\)/);
    const select = care.find((p) => /FOR SELECT/.test(p))!;
    // The rule dogs read by: a member who may see the pet's property.
    expect(select).toMatch(/is_org_member/);
    expect(select).toMatch(/may_read_property_row\(d\.organization_id, d\.property_id\)/);
    expect(care.some((p) => /FOR ALL/.test(p))).toBe(false);
  });

  it("pins search_path on every function it creates", () => {
    const fns = code.match(/CREATE OR REPLACE FUNCTION[\s\S]*?AS \$function\$/g) ?? [];
    expect(fns.length).toBeGreaterThanOrEqual(4);
    for (const f of fns) expect(f).toMatch(/SET search_path TO/);
  });

  it("keeps the group-walk rules counting dogs", () => {
    const walks = code.slice(
      code.indexOf("CREATE OR REPLACE FUNCTION public.walk_dogs_on_visit"),
      code.indexOf("DO $check$"),
    );
    // Every read of public.dogs in the two restated bodies, up to the
    // parenthesis that closes its subquery.
    const counts = walks.match(/FROM public\.dogs d[^)]*\)/g) ?? [];
    expect(counts.length).toBe(4);
    for (const c of counts) expect(c).toMatch(/species = 'dog'/);
    expect(code).toMatch(/CREATE OR REPLACE FUNCTION public\.walk_dogs_on_visit\(_visit_id uuid\)/);
    expect(code).toMatch(/CREATE OR REPLACE FUNCTION public\.validate_walk_group_member\(\)/);
    expect(code).toMatch(
      /REVOKE ALL ON FUNCTION public\.validate_walk_group_member\(\) FROM PUBLIC, anon, authenticated/,
    );
  });

  it("ends by checking what it established", () => {
    const tail = code.slice(code.lastIndexOf("DO $check$"));
    expect(tail).toMatch(/RAISE EXCEPTION 'public\.dogs\.species/);
    expect(tail).toMatch(/pet_care_instructions lacks row level security/);
    expect(tail).toMatch(/pet_meds_are_valid does not hold the rule/);
    expect(tail).toMatch(/still count every pet as a dog/);
    expect(code).not.toMatch(/pg_get_functiondef/);
  });
});

describe("pets that are not dogs", () => {
  it("reads a row with no species as a dog", () => {
    expect(isDog({})).toBe(true);
    expect(isDog({ species: null })).toBe(true);
    expect(isDog({ species: "dog" })).toBe(true);
    expect(isDog({ species: "cat" })).toBe(false);
  });

  it("counts active dogs only", () => {
    expect(
      activeDogCount([
        { species: "dog" },
        { species: "dog", active: false },
        { species: "cat" },
        {},
        { species: "other" },
      ]),
    ).toBe(2);
  });

  it("names the kind of pet, and nothing for a dog", () => {
    expect(speciesLabel({ species: "dog" })).toBeNull();
    expect(speciesLabel({ species: "cat" })).toBe("Cat");
    expect(speciesLabel({ species: "other", species_note: "rabbit" })).toBe("Rabbit");
    expect(speciesLabel({ species: "other", species_note: "  " })).toBe("Other pet");
  });

  it("keeps the note only for other, within 40 characters", () => {
    expect(cleanSpeciesNote("cat", "rabbit")).toBeNull();
    expect(cleanSpeciesNote("other", "  bearded dragon ")).toBe("bearded dragon");
    expect(cleanSpeciesNote("other", "x".repeat(60))).toHaveLength(40);
    expect(cleanSpeciesNote("other", "")).toBeNull();
  });

  it("says Pets and offers care only to a business that runs pet sitting", () => {
    expect(runsPetSitting(["pet_waste"])).toBe(false);
    expect(runsPetSitting(["dog_walking"])).toBe(false);
    expect(runsPetSitting(["pet_waste", "pet_sitting"])).toBe(true);
    expect(petsHeading(["pet_waste"])).toBe("Dogs");
    expect(petsHeading(["dog_walking"])).toBe("Dogs");
    expect(petsHeading(["pet_sitting"])).toBe("Pets");
  });
});

describe("medications", () => {
  const insulin: PetMed = { name: "Insulin", dose: "2 units", times: ["08:00", "20:00"], notes: null };

  it("accepts the shape the database accepts", () => {
    expect(medsProblem([])).toBeNull();
    expect(medsProblem([insulin])).toBeNull();
    expect(medsProblem([{ name: "Fish oil", dose: null, times: [], notes: null }])).toBeNull();
  });

  it("refuses what pet_meds_are_valid refuses", () => {
    expect(medsProblem([{ ...insulin, name: " " }])).toMatch(/name/);
    expect(medsProblem([{ ...insulin, times: ["8am"] }])).toMatch(/HH:MM/);
    expect(medsProblem([{ ...insulin, times: ["24:00"] }])).toMatch(/HH:MM/);
    expect(medsProblem([{ ...insulin, times: Array(7).fill("08:00") }])).toMatch(/6 times/);
    expect(medsProblem(Array(21).fill(insulin))).toMatch(/20 medications/);
    expect(medsProblem([{ ...insulin, dose: "x".repeat(81) }])).toMatch(/dose/);
    expect(medsProblem([{ ...insulin, notes: "x".repeat(201) }])).toMatch(/notes/);
  });

  it("cleans a list before it is saved", () => {
    expect(
      cleanMeds([
        { name: " Insulin ", dose: " ", times: ["20:00", "08:00", "08:00", ""], notes: "" },
        { name: "", dose: null, times: [], notes: null },
      ]),
    ).toEqual([{ name: "Insulin", dose: null, times: ["08:00", "20:00"], notes: null }]);
  });

  it("reads a stored list defensively", () => {
    expect(readMeds(null)).toEqual([]);
    expect(readMeds({})).toEqual([]);
    expect(readMeds([{ name: "Pill", times: ["08:00", 7] }, "junk", { dose: "1" }])).toEqual([
      { name: "Pill", dose: null, times: ["08:00"], notes: null },
    ]);
    expect(careIsEmpty({ feeding: " ", meds: [], other_care: null })).toBe(true);
    expect(careIsEmpty({ feeding: "Half a cup", meds: [], other_care: null })).toBe(false);
  });
});

describe("what counts dogs", () => {
  it("filters species = 'dog' wherever a count means dogs", () => {
    for (const file of [
      "src/lib/estimate.server.ts",
      "src/lib/one-off-visit.server.ts",
      "src/lib/portal.functions.ts",
      "src/lib/quote-pricing.functions.ts",
      "src/lib/walk-groups.functions.ts",
    ])
      expect(read(file), file).toMatch(/\.eq\("species", "dog"\)/);
  });

  it("the client screens count dogs for plans, warnings and estimates", () => {
    const props = read("src/components/client-detail/PropertiesTab.tsx");
    expect(props).toMatch(/d\.active !== false && isDog\(d\)/);
    expect(props).toMatch(/const dogCount = activeDogCount\(dogs\)/);
    const services = read("src/components/client-detail/ServicesTab.tsx");
    expect(services).toMatch(
      /const dogs = useMemo\(\(\) => pets\.filter\(\(p: any\) => isDog\(p\)\),\s*\[pets\]\)/,
    );
    expect(read("src/components/client-detail/SummaryTab.tsx")).toMatch(
      /const activeDogTotal = activeDogCount\(dogs\)/,
    );
  });

  it("a new pet is a dog unless a sitting business says otherwise", () => {
    const dogs = read("src/lib/dogs.functions.ts");
    expect(dogs).toMatch(/species: data\.species \?\? "dog"/);
    const props = read("src/components/client-detail/PropertiesTab.tsx");
    expect(props).toMatch(
      /sitting\s*\?\s*\{\s*species,\s*speciesNote: cleanSpeciesNote\(species, speciesNote\)\s*\}\s*:\s*\{\}/,
    );
    expect(props).toMatch(/const sitting = known && runsPetSitting\(lines\)/);
    expect(read("src/lib/clients.functions.ts")).toMatch(/dna_status, species, species_note/);
  });
});
