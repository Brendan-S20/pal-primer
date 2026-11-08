// Per-pet safety notes and incident log (#729). The table is
// public.pet_safety_entries (supabase/migrations/20261108152900_...); these
// lists mirror its CHECK constraints and the pet-safety-photos bucket.

export const PET_SAFETY_ENTRY_TYPES = ["note", "incident"] as const;
export type PetSafetyEntryType = (typeof PET_SAFETY_ENTRY_TYPES)[number];

export const PET_INCIDENT_KINDS = [
  "bite",
  "scratch",
  "aggression",
  "escape",
  "injury_to_pet",
  "injury_to_person",
  "illness",
  "property_damage",
  "other",
] as const;
export type PetIncidentKind = (typeof PET_INCIDENT_KINDS)[number];

/** Office-screen labels. The pet's page is an office screen; a tech screen
 *  that shows these translates them by code through t("petSafety.kind.*"). */
export const PET_INCIDENT_KIND_LABELS: Record<PetIncidentKind, string> = {
  bite: "Bite",
  scratch: "Scratch",
  aggression: "Aggression",
  escape: "Escape or slipped lead",
  injury_to_pet: "Pet was hurt",
  injury_to_person: "Person was hurt",
  illness: "Illness",
  property_damage: "Property damage",
  other: "Other",
};

export const PET_SAFETY_BUCKET = "pet-safety-photos";
export const PET_SAFETY_MAX_BYTES = 10485760;
export const PET_SAFETY_MIME_EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
} as const;
export type PetSafetyMime = keyof typeof PET_SAFETY_MIME_EXT;
export const PET_SAFETY_BODY_MAX = 2000;

export function isPetSafetyMime(v: unknown): v is PetSafetyMime {
  return typeof v === "string" && Object.hasOwn(PET_SAFETY_MIME_EXT, v);
}

/** Where a photo for this pet goes. Must match the trigger's and the storage
 *  helper's path rule: <org>/<dog>/<uuid>.<ext>. */
export function petSafetyPhotoPath(
  orgId: string,
  dogId: string,
  mime: PetSafetyMime,
  id: string = crypto.randomUUID(),
): string {
  return `${orgId}/${dogId}/${id}.${PET_SAFETY_MIME_EXT[mime]}`;
}

// ── the vaccine Start rule ────────────────────────────────────────────────

export const VACCINE_START_RULES = ["warn", "block"] as const;
export type VaccineStartRule = (typeof VACCINE_START_RULES)[number];
/** The default for every business, and what every business had before the
 *  setting existed: Start goes ahead and the tech is told. */
export const DEFAULT_VACCINE_START_RULE: VaccineStartRule = "warn";

/** The database refuses a blocked Start with this prefix (start_visit_as). */
export const VACCINE_START_BLOCKED = "VACCINE_START_BLOCKED";
export function isVaccineStartBlocked(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return msg.includes(VACCINE_START_BLOCKED);
}

export type MissingVaccine = { dog_id: string; dog_name: string; vaccine: string };
/** One name per pet, in the order the database gave them. */
export function petsMissingVaccines(rows: readonly MissingVaccine[] | null | undefined): string[] {
  return [...new Set((rows ?? []).map((r) => r.dog_name))];
}
