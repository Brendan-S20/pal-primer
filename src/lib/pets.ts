// Pets that are not dogs, and how each one is looked after (#411).
//
// public.dogs holds every pet a client has since migration 20261024080000;
// `species` says which kind. Everything that counts DOGS (a plan's dog_count,
// the scooping estimate, group-walk places, the "services bill for N dogs"
// warning) counts rows whose species is dog, and a row without the column
// (an older read) is a dog. A pet-waste business never sees the species
// picker, so every count it reads is the count it read before.

import type { ServiceLine } from "@/lib/service-lines";

export const PET_SPECIES = ["dog", "cat", "other"] as const;
export type PetSpecies = (typeof PET_SPECIES)[number];

export const PET_SPECIES_LABEL: Record<PetSpecies, string> = {
  dog: "Dog",
  cat: "Cat",
  other: "Other",
};

/** dogs.species_note: "rabbit", "fish". */
export const SPECIES_NOTE_MAX = 40;

export function isPetSpecies(v: unknown): v is PetSpecies {
  return typeof v === "string" && (PET_SPECIES as readonly string[]).includes(v);
}

type PetLike = { species?: string | null; active?: boolean | null };

/** A row with no species (written before #411, or read without the column)
 *  is a dog. */
export function isDog(p: PetLike): boolean {
  return (p.species ?? "dog") === "dog";
}

/** Active dogs: the number a scooping or walking plan bills for. */
export function activeDogCount(pets: readonly PetLike[]): number {
  return pets.filter((p) => p.active !== false && isDog(p)).length;
}

/** What kind of pet, for a list: "Cat", "Rabbit", "Other pet". Null for a
 *  dog, whose breed already says it. */
export function speciesLabel(p: {
  species?: string | null;
  species_note?: string | null;
}): string | null {
  if (isDog(p)) return null;
  if (p.species === "other") {
    const note = (p.species_note ?? "").trim();
    return note ? note.charAt(0).toUpperCase() + note.slice(1) : "Other pet";
  }
  return PET_SPECIES_LABEL[isPetSpecies(p.species) ? p.species : "other"];
}

/** The note is kept only for "other", trimmed and no longer than the column. */
export function cleanSpeciesNote(
  species: PetSpecies,
  note: string | null | undefined,
): string | null {
  if (species !== "other") return null;
  const t = (note ?? "").trim();
  return t ? t.slice(0, SPECIES_NOTE_MAX) : null;
}

/** The species picker, Pets heading and care instructions show for a business
 *  that runs pet sitting. A pet-waste or walking business sees Dogs as before. */
export function runsPetSitting(lines: readonly ServiceLine[]): boolean {
  return lines.includes("pet_sitting");
}

export function petsHeading(lines: readonly ServiceLine[]): "Pets" | "Dogs" {
  return runsPetSitting(lines) ? "Pets" : "Dogs";
}

// ── Care instructions ────────────────────────────────────────────────────

export const FEEDING_MAX = 500;
export const OTHER_CARE_MAX = 1000;
export const MEDS_MAX = 20;
export const MED_NAME_MAX = 80;
export const MED_DOSE_MAX = 80;
export const MED_NOTES_MAX = 200;
export const MED_TIMES_MAX = 6;

export type PetMed = {
  name: string;
  dose: string | null;
  times: string[];
  notes: string | null;
};

export type PetCare = {
  feeding: string | null;
  meds: PetMed[];
  other_care: string | null;
};

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Why a medication list cannot be saved, or null. The same rule as
 *  public.pet_meds_are_valid (migration 20261024080000). */
export function medsProblem(meds: readonly PetMed[]): string | null {
  if (meds.length > MEDS_MAX) return `Up to ${MEDS_MAX} medications.`;
  for (const med of meds) {
    const name = (med.name ?? "").trim();
    if (!name) return "Give each medication a name.";
    if (name.length > MED_NAME_MAX) return `A medication name is up to ${MED_NAME_MAX} characters.`;
    if ((med.dose ?? "").length > MED_DOSE_MAX)
      return `A dose is up to ${MED_DOSE_MAX} characters.`;
    if ((med.notes ?? "").length > MED_NOTES_MAX)
      return `Medication notes are up to ${MED_NOTES_MAX} characters.`;
    if (med.times.length > MED_TIMES_MAX)
      return `Up to ${MED_TIMES_MAX} times a day for one medication.`;
    if (!med.times.every((t) => CLOCK.test(t))) return "Write each medication time as HH:MM.";
  }
  return null;
}

/** Trimmed, blanks as null, times sorted and once each, empty rows dropped. */
export function cleanMeds(meds: readonly PetMed[]): PetMed[] {
  return meds
    .map((m) => ({
      name: (m.name ?? "").trim(),
      dose: (m.dose ?? "").trim() || null,
      times: [...new Set(m.times.map((t) => t.trim()).filter(Boolean))].sort(),
      notes: (m.notes ?? "").trim() || null,
    }))
    .filter((m) => m.name || m.dose || m.notes || m.times.length);
}

/** A pet with nothing written down. */
export function careIsEmpty(c: PetCare | null | undefined): boolean {
  return !c || (!c.feeding?.trim() && !c.other_care?.trim() && c.meds.length === 0);
}

/** Reads a stored meds column defensively: anything not a list of named
 *  medications reads as no medications. */
export function readMeds(raw: unknown): PetMed[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
    .map((m) => ({
      name: typeof m.name === "string" ? m.name : "",
      dose: typeof m.dose === "string" ? m.dose : null,
      times: Array.isArray(m.times)
        ? m.times.filter((t): t is string => typeof t === "string")
        : [],
      notes: typeof m.notes === "string" ? m.notes : null,
    }))
    .filter((m) => m.name);
}

// ── How many dogs, the one way every screen counts them (#429) ───────────

/** A count of dogs and where it came from. "records" is the dog records;
 *  "plan" is what an active plan bills for, used only when there are no
 *  records, so a client imported with a plan and no dog names reads the
 *  same number on the Clients list, the client record, a quote and My Day. */
export type DogTally = { count: number; source: "records" | "plan" | "none" };

/** One property: its active dog records when it has any, otherwise the
 *  largest dog count an active residential plan on it bills for. The same
 *  rule as My Day's dogs line (dogsLine in src/lib/stop-facts.ts). */
export function propertyDogTally(
  records: number,
  planDogCounts: ReadonlyArray<number | null | undefined>,
): DogTally {
  if (records > 0) return { count: records, source: "records" };
  const billed = Math.max(
    0,
    ...planDogCounts.map((n) => (typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : 0)),
  );
  return billed > 0 ? { count: billed, source: "plan" } : { count: 0, source: "none" };
}

/** A client: the properties added up. "plan" when any of them is counted
 *  from a plan, because then some names are not on file. */
export function clientDogTally(perProperty: readonly DogTally[]): DogTally {
  const count = perProperty.reduce((n, t) => n + t.count, 0);
  if (count === 0) return { count: 0, source: "none" };
  return {
    count,
    source: perProperty.some((t) => t.source === "plan") ? "plan" : "records",
  };
}
