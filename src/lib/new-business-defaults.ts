// Whether a NEW business requires a completion photo, by what it runs (#915).
//
// Product spec, locked 2026-11-16 (issue #915):
//
//   1. Keep the default ON for pet-waste (scooper) businesses, existing ones
//      included, with no change for anyone live. For NEW businesses whose
//      only services are walking, sitting, grooming or training, default it
//      OFF. Owners can still change it in Settings.
//   3. No migration may change existing orgs' require_completion_photo. A
//      new-org default set by segment at setup is fine.
//
// So the column default (`NOT NULL DEFAULT true`, 20260928050000) stays what
// it is, and this decides only what a business still being set up is moved
// to once it says what it runs. A scoop after a dog has been in the yard is
// work the client cannot see, and the photo is the proof; a walk, a sit, a
// groom or a lesson is work the client saw or is told about another way.

import type { ServiceLine } from "@/lib/service-lines";

/** The lines whose businesses start with the photo rule off, when a business
 *  runs nothing else. `other` is not here: it is not offered, and an unknown
 *  segment keeps the column default. */
export const PHOTO_OPTIONAL_LINES: readonly ServiceLine[] = [
  "dog_walking",
  "pet_sitting",
  "mobile_grooming",
  "training",
];

/** The completion-photo default for a new business that runs `lines`. On for
 *  anything that includes pet waste, and for an answer that is empty or not
 *  understood (the column's default, which is what every business had);
 *  off only when every line is one of PHOTO_OPTIONAL_LINES. */
export function newBusinessRequiresCompletionPhoto(lines: readonly string[]): boolean {
  if (lines.length === 0) return true;
  return !lines.every((l) => (PHOTO_OPTIONAL_LINES as readonly string[]).includes(l));
}
