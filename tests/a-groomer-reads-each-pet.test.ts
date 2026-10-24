// In a two-dog home the groomer used to see one note for both: the last
// completed groom note for the client (withPriorGroomNotes). Each pet now has
// its own handling flags, its own vaccine status on the groom's date, and its
// own last few grooms.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { groomPetFacts, GROOM_HISTORY_PER_PET, type GroomNote } from "@/lib/groom-pets";
import { petGroomNoteSchema } from "@/lib/pet-groom-notes.functions";

const sql = readFileSync(
  new URL(
    "../supabase/migrations/20261024100300_grooming-repeat-stamp-start-time.sql",
    import.meta.url,
  ),
  "utf8",
);
const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

const note = (dog_id: string, visit_id: string, groomed_on: string, blade: string): GroomNote => ({
  dog_id,
  visit_id,
  groomed_on,
  blade,
  style: null,
  problems: null,
});

describe("each pet's own history", () => {
  const notes = [
    note("rex", "v1", "2026-05-01", "#10"),
    note("rex", "v2", "2026-06-12", "#7"),
    note("rex", "v3", "2026-07-24", "#7F"),
    note("rex", "v4", "2026-09-04", "#5"),
    note("bella", "v4", "2026-09-04", "#4"),
    note("rex", "today", "2026-10-16", "#5F"),
  ];

  it("keeps two dogs apart, newest first, and stops at the last few", () => {
    const [rex, bella] = groomPetFacts({
      dogIds: ["rex", "bella"],
      visitId: "today",
      day: "2026-10-16",
      notes,
      vaccines: [],
      rule: null,
      required: [],
    });
    expect(GROOM_HISTORY_PER_PET).toBe(3);
    expect(rex.history.map((h) => h.blade)).toEqual(["#5", "#7F", "#7"]);
    expect(rex.current).toEqual({ blade: "#5F", style: null, problems: null });
    expect(bella.history.map((h) => h.blade)).toEqual(["#4"]);
    expect(bella.current).toBeNull();
  });

  it("checks vaccines on this groom's date and flags an unverified upload", () => {
    const vaccines = [
      {
        dog_id: "rex",
        vaccine: "rabies",
        expires_on: "2026-10-01",
        source: "office",
        verified_at: "2025-01-01T00:00:00Z",
      },
      {
        dog_id: "bella",
        vaccine: "rabies",
        expires_on: "2027-10-01",
        source: "portal",
        verified_at: null,
      },
    ];
    const facts = groomPetFacts({
      dogIds: ["rex", "bella", "milo"],
      visitId: "today",
      day: "2026-10-16",
      notes: [],
      vaccines,
      rule: "warn",
      required: ["rabies"],
    });
    expect(facts.map((f) => f.vaccine)).toEqual(["expired", "unverified", "missing"]);
    const off = groomPetFacts({
      dogIds: ["rex"],
      visitId: "today",
      day: "2026-10-16",
      notes: [],
      vaccines,
      rule: "off",
      required: ["rabies"],
    });
    expect(off[0].vaccine).toBeNull();
  });
});

describe("a groom note is saved per pet", () => {
  const ids = {
    visitId: "11111111-1111-4111-8111-111111111111",
    dogId: "22222222-2222-4222-8222-222222222222",
  };
  it("needs one of blade, style or problems, within the column limits", () => {
    expect(
      petGroomNoteSchema.safeParse({ ...ids, blade: "#7F", style: null, problems: null }).success,
    ).toBe(true);
    expect(
      petGroomNoteSchema.safeParse({ ...ids, blade: " ", style: "", problems: null }).success,
    ).toBe(false);
    expect(
      petGroomNoteSchema.safeParse({ ...ids, blade: "x".repeat(121), style: null, problems: null })
        .success,
    ).toBe(false);
  });

  it("stores one row per visit and pet, tenant and date from the visit, writes by office or assigned groomer", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.pet_groom_notes/);
    expect(sql).toMatch(/CONSTRAINT pet_groom_notes_visit_dog_key UNIQUE \(visit_id, dog_id\)/);
    expect(sql).toMatch(
      /NEW\.organization_id := _visit\.organization_id;\s+NEW\.groomed_on := _visit\.scheduled_on;/,
    );
    expect(sql).toMatch(/AND d\.property_id = _visit\.property_id/);
    expect(sql).toMatch(
      /NOT public\.can_write_org\(auth\.uid\(\), _visit\.organization_id\)[\s\S]*?s\.user_id = auth\.uid\(\)/,
    );
    expect(sql).toMatch(/require_mfa_policy\('public\.pet_groom_notes'\)/);
    expect(sql).toMatch(/public\.may_read_property\(d\.property_id\)/);
    expect(sql).toMatch(/REVOKE ALL ON public\.pet_groom_notes FROM PUBLIC, anon, authenticated/);
  });

  it("adds the handling flags to each pet", () => {
    for (const col of [
      "muzzle_required boolean NOT NULL DEFAULT false",
      "bite_history boolean NOT NULL DEFAULT false",
      "senior_or_medical boolean NOT NULL DEFAULT false",
      "handling_notes text",
    ])
      expect(sql).toContain(`ADD COLUMN IF NOT EXISTS ${col}`);
  });
});

describe("My Day shows each pet at the top of a groom's card", () => {
  const myDay = read("src/routes/_authenticated/my-day.tsx");
  const loader = read("src/lib/my-day.functions.ts");
  const panel = read("src/components/my-day/GroomPetPanel.tsx");

  it("loads the flags, the start time and each pet's facts", () => {
    expect(loader).toContain("muzzle_required, bite_history, senior_or_medical, handling_notes");
    expect(loader).toContain("start_time");
    expect(loader).toMatch(/withGroomPets\(/);
    expect(loader).toMatch(/\.from\("pet_groom_notes"\)/);
  });

  it("puts the pet panel first in the expanded card, before the gate reply and the dogs line", () => {
    const panelAt = myDay.indexOf("<GroomPetPanel");
    expect(panelAt).toBeGreaterThan(0);
    expect(panelAt).toBeLessThan(myDay.indexOf("{visit.gate_reply && !done && !skipped"));
    expect(panelAt).toBeLessThan(myDay.indexOf("<DogsLine"));
    for (const key of ["groom.muzzle", "groom.bite", "groom.senior", "groom.history"])
      expect(panel).toContain(`t("${key}")`);
    expect(panel).toContain("t(`groom.vaccines.${facts.vaccine}`)");
  });

  it("no longer folds coat and behavior into one household note", () => {
    expect(myDay).not.toContain("composeGroomNote");
    expect(read("src/lib/groom.ts")).not.toContain("composeGroomNote");
  });
});
