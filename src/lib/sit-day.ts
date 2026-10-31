/** How a pet sitting visit reads on the sitter's day (#411). Pure, so My Day's
 *  card, the care log and the tests share one copy of the rules.
 *
 *  The visit list comes from getMyDay. What a tech cannot read for themselves
 *  (the stay, the plan's window, which visit of the stay this is) comes from
 *  sit_visit_facts (migration 20261024080200) as `sit_facts` on the visit. */

import { readMeds, type PetCare, type PetSpecies, isPetSpecies } from "@/lib/pets";

export const CARE_KINDS = ["feed", "meds", "litter", "walk", "water", "other"] as const;
export type CareKind = (typeof CARE_KINDS)[number];
export type CareStatus = "done" | "missed";

/** care_log.missed_reason and care_log.note. */
export const MISSED_REASON_MAX = 300;
export const CARE_NOTE_MAX = 300;

/** A med is due at a drop-in when its time is within this many minutes of
 *  the visit's window: a sitter booked 8 to 10 gives the 7:30 dose. */
export const DUE_SLACK_MIN = 60;
/** An overnight covers the evening from the arrival window and the morning up
 *  to this time, when the sitter checks out. */
export const OVERNIGHT_MORNING_END_MIN = 10 * 60;

export function isCareKind(v: unknown): v is CareKind {
  return typeof v === "string" && (CARE_KINDS as readonly string[]).includes(v);
}

type ServiceRef = { service_line?: string | null } | null;
const one = <T>(v: T | T[] | null | undefined): T | null =>
  Array.isArray(v) ? (v[0] ?? null) : (v ?? null);

/** A stop whose service is pet sitting. Every other stop keeps its card. */
export function isSitVisit(
  v: { services?: ServiceRef | ServiceRef[] } | null | undefined,
): boolean {
  return one(v?.services ?? null)?.service_line === "pet_sitting";
}

/** One row of sit_visit_facts. */
export type SitFacts = {
  visit_id: string;
  stay_id: string;
  kind: string;
  starts_on: string;
  ends_on: string;
  pet_ids: string[] | null;
  visit_number: number | null;
  visit_total: number | null;
  window_earliest: string | null;
  window_latest: string | null;
};

export function isOvernight(facts: Pick<SitFacts, "kind"> | null | undefined): boolean {
  return facts?.kind === "overnight";
}

/** "Night 2 of 5" or "Visit 3 of 10", as numbers. Null when the visit is not
 *  part of a stay, or is not counted (canceled). */
export function stayProgress(
  facts: SitFacts | null | undefined,
): { unit: "night" | "visit"; n: number; total: number } | null {
  if (!facts || facts.visit_number == null || facts.visit_total == null) return null;
  if (facts.visit_number < 1 || facts.visit_total < facts.visit_number) return null;
  return {
    unit: isOvernight(facts) ? "night" : "visit",
    n: facts.visit_number,
    total: facts.visit_total,
  };
}

/** Minutes after midnight for "HH:MM" or "HH:MM:SS"; null for anything else. */
export function clockMinutes(v: string | null | undefined): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/.exec((v ?? "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export type VisitWindow = { earliest: string | null; latest: string | null } | null;

/** Whether a med given at `times` is due at this visit. A drop-in: a time
 *  within DUE_SLACK_MIN of its window. An overnight: a time from an hour
 *  before the arrival window through the next morning. A med with no times
 *  (as needed) is never due, and with no window nothing is: a warning the
 *  card cannot back up is noise. */
export function medDueAtVisit(
  times: readonly string[],
  window: VisitWindow,
  overnight: boolean,
): boolean {
  const start = clockMinutes(window?.earliest);
  const end = clockMinutes(window?.latest);
  if (start == null) return false;
  return times.some((t) => {
    const at = clockMinutes(t);
    if (at == null) return false;
    if (overnight) return at >= start - DUE_SLACK_MIN || at <= OVERNIGHT_MORNING_END_MIN;
    return at >= start - DUE_SLACK_MIN && at <= (end ?? start) + DUE_SLACK_MIN;
  });
}

/** A pet as the sit card draws it. */
export type SitPet = {
  id: string;
  name: string;
  species: PetSpecies;
  speciesNote: string | null;
  care: PetCare | null;
  /** When the care came from a client's portal edit, applied when the office
   *  confirmed their stay request (#611). Null once the office edits it. */
  clientUpdatedAt: string | null;
  /** The pet's vet (#411), or null when neither is on file. */
  vet: { name: string | null; phone: string | null } | null;
};

type CareRow = {
  feeding?: string | null;
  meds?: unknown;
  other_care?: string | null;
  client_updated_at?: string | null;
};

type PetRow = {
  id?: string | null;
  name?: string | null;
  species?: string | null;
  species_note?: string | null;
  active?: boolean | null;
  vet_clinic_name?: string | null;
  vet_clinic_phone?: string | null;
  pet_care_instructions?: CareRow | CareRow[] | null;
};

/** The pets this visit is for: the stay's pets when it names them, otherwise
 *  every active pet at the home. Each with its care instructions. */
export function sitPets(
  rows: readonly PetRow[] | null | undefined,
  facts: SitFacts | null | undefined,
): SitPet[] {
  const onStay = new Set(facts?.pet_ids ?? []);
  return (rows ?? [])
    .filter((r): r is PetRow & { id: string } => !!r?.id)
    .filter((r) => (onStay.size > 0 ? onStay.has(r.id) : r.active !== false))
    .map((r) => {
      const c = one(r.pet_care_instructions ?? null);
      const vetName = (r.vet_clinic_name ?? "").trim() || null;
      const vetPhone = (r.vet_clinic_phone ?? "").trim() || null;
      return {
        vet: vetName || vetPhone ? { name: vetName, phone: vetPhone } : null,
        id: r.id,
        name: (r.name ?? "").trim(),
        species: isPetSpecies(r.species) ? r.species : "dog",
        speciesNote: (r.species_note ?? "").trim() || null,
        care: c
          ? {
              feeding: (c.feeding ?? "").trim() || null,
              meds: readMeds(c.meds),
              other_care: (c.other_care ?? "").trim() || null,
            }
          : null,
        clientUpdatedAt: c?.client_updated_at ?? null,
      };
    });
}

/** Who the sitter calls when a pet is sick, from the visit's client row. */
export type SitEmergency = {
  name: string | null;
  phone: string | null;
  mayApproveVet: boolean;
  limitCents: number | null;
};

export function sitEmergency(
  client:
    | {
        emergency_contact_name?: string | null;
        emergency_contact_phone?: string | null;
        emergency_contact_may_approve_vet?: boolean | null;
        vet_treatment_limit_cents?: number | null;
      }
    | null
    | undefined,
): SitEmergency {
  return {
    name: (client?.emergency_contact_name ?? "").trim() || null,
    phone: (client?.emergency_contact_phone ?? "").trim() || null,
    mayApproveVet: !!client?.emergency_contact_may_approve_vet,
    limitCents: client?.vet_treatment_limit_cents ?? null,
  };
}

/** A care log entry, as the card holds it. `queued` is an entry still in the
 *  device's queue. */
export type CareEntry = {
  id: string;
  pet_id: string | null;
  kind: CareKind;
  med_name: string | null;
  status: CareStatus;
  missed_reason: string | null;
  note?: string | null;
  at: string;
  given_by_name?: string | null;
  queued?: boolean;
};

const sameMed = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

/** The entry that logged this pet's med at this visit, given or missed. */
export function medEntry(
  entries: readonly CareEntry[],
  petId: string,
  medName: string,
): CareEntry | undefined {
  return entries.find(
    (e) => e.kind === "meds" && e.pet_id === petId && sameMed(e.med_name, medName),
  );
}

export type DueMed = { petId: string; petName: string; medName: string };

/** Meds due at this visit that are logged neither given nor missed. Shown
 *  before the sitter ends the visit; never blocks it. */
export function unloggedDueMeds(
  pets: readonly SitPet[],
  entries: readonly CareEntry[],
  facts: SitFacts | null | undefined,
): DueMed[] {
  const window: VisitWindow = facts
    ? { earliest: facts.window_earliest, latest: facts.window_latest }
    : null;
  const overnight = isOvernight(facts);
  const out: DueMed[] = [];
  for (const pet of pets) {
    for (const med of pet.care?.meds ?? []) {
      if (!medDueAtVisit(med.times, window, overnight)) continue;
      if (medEntry(entries, pet.id, med.name)) continue;
      out.push({ petId: pet.id, petName: pet.name, medName: med.name });
    }
  }
  return out;
}

/** Entries oldest first, the order the card lists them in. */
export function byTime(entries: readonly CareEntry[]): CareEntry[] {
  return [...entries].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

/** The reason as record_care_entry stores it: trimmed, never longer than the
 *  column. Empty is null, which the database refuses for a missed entry. */
export function cleanMissedReason(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return t ? t.slice(0, MISSED_REASON_MAX) : null;
}
