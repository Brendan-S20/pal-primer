// What a groomer reads about each pet on a groom's My Day card: how to
// handle it, whether its vaccines are good on THIS groom's date, and what was
// done at its last few grooms. Pure, so the card and the tests share it.

import {
  groomVaccineFlag,
  vaccineStatus,
  type GroomVaccineFlag,
  type VaccineRecord,
  type VaccineRule,
} from "@/lib/vaccines";

/** How many earlier grooms the card shows for each pet. */
export const GROOM_HISTORY_PER_PET = 3;

export type GroomNote = {
  dog_id: string;
  visit_id: string;
  groomed_on: string;
  blade: string | null;
  style: string | null;
  problems: string | null;
};

export type GroomPetFacts = {
  dogId: string;
  vaccine: GroomVaccineFlag | null;
  /** This groom's own note, if one was saved. */
  current: Pick<GroomNote, "blade" | "style" | "problems"> | null;
  /** Earlier grooms, newest first. */
  history: Pick<GroomNote, "groomed_on" | "blade" | "style" | "problems">[];
};

export function groomPetFacts({
  dogIds,
  visitId,
  day,
  notes,
  vaccines,
  rule,
  required,
}: {
  dogIds: readonly string[];
  visitId: string;
  day: string;
  notes: readonly GroomNote[];
  vaccines: readonly (VaccineRecord & { dog_id: string })[];
  /** Null when vaccine checks are off or could not be read. */
  rule: VaccineRule | null;
  required: readonly string[];
}): GroomPetFacts[] {
  return dogIds.map((dogId) => {
    const mine = notes.filter((n) => n.dog_id === dogId);
    const current = mine.find((n) => n.visit_id === visitId) ?? null;
    const history = mine
      .filter((n) => n.visit_id !== visitId && n.groomed_on <= day)
      .sort((a, b) => b.groomed_on.localeCompare(a.groomed_on))
      .slice(0, GROOM_HISTORY_PER_PET)
      .map(({ groomed_on, blade, style, problems }) => ({ groomed_on, blade, style, problems }));
    const vaccine =
      rule && rule !== "off" && required.length > 0
        ? groomVaccineFlag(
            vaccineStatus(
              vaccines.filter((v) => v.dog_id === dogId),
              required,
              day,
            ),
          )
        : null;
    return {
      dogId,
      vaccine,
      current: current
        ? { blade: current.blade, style: current.style, problems: current.problems }
        : null,
      history,
    };
  });
}
