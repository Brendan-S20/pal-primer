// One phone number, typed once, shown in the three places that need it (#787).
//
// Get started asks the owner for a mobile number. That same number is the
// business phone setup step 1 asks for, the office phone the client portal
// shows (Settings > Client portal), and the owner's own phone on Profile.
// Each of those reads a different column:
//
//   setup step 1 "Business phone"   organizations.contact_phone (getOrgBranding)
//   Client portal "Office phone"    organizations.contact_phone (getOrgBranding)
//   Profile "Your phone"            staff.phone                 (getMyProfile)
//
// The QA report of 2026-11-09 found them disagreeing: setup's Business phone
// empty (later `555-`), Profile blank, and the portal showing `555-010-0199`.
// So every write that hands the number from one place to another goes through
// this file, and the rules for "is there a number here" and "is this a number
// at all" are written once:
//
//   - a value with fewer than MIN_PHONE_DIGITS digits is not handed anywhere.
//     `555-` is what an interrupted keystroke leaves, not a phone, and storing
//     it would prefill setup with exactly the truncated value the report saw.
//   - a column holding "" or only spaces is blank, the same as NULL. A fill
//     that only looks for NULL leaves an emptied field empty forever.
//   - a handoff only FILLS. A number somebody has typed in a place is theirs,
//     and copying a different one over it is the "data was lost" this fixes
//     from the other side.

/** Fewer digits than this is a fragment, not a number (shortest local numbers are 7). */
export const MIN_PHONE_DIGITS = 7;

/** The digits of a phone number, without spaces, dashes, dots or brackets. */
export function phoneDigits(value: string | null | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}

/** True when a stored phone column counts as empty: NULL, "", or only spaces. */
export function isBlankPhone(value: string | null | undefined): boolean {
  return !value || value.trim() === "";
}

/**
 * The number to hand on, trimmed and as typed, or null when there is not a
 * whole number to hand on (blank, or a fragment such as `555-`).
 */
export function handoffPhone(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (phoneDigits(trimmed).length < MIN_PHONE_DIGITS) return null;
  return trimmed;
}

/**
 * Two phone numbers are the same number when their digits agree, however
 * they were punctuated: `555-010-0199` and `(555) 010 0199` are one phone.
 */
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const da = phoneDigits(a);
  return da.length > 0 && da === phoneDigits(b);
}

/**
 * What setup step 1's "Business phone" should start with.
 *
 * `draft` is what was typed on this device and kept (null while untouched);
 * `stored` is organizations.contact_phone, which the signup mobile fills.
 * A kept draft wins when it is a whole number or when nothing is stored, so
 * a deliberate edit is never undone. A kept FRAGMENT (`555-`) does not win
 * over a stored whole number: that is how setup came to show `555-` over the
 * number the owner had already typed at sign-up.
 */
export function setupBusinessPhonePrefill(
  draft: string | null | undefined,
  stored: string | null | undefined,
): string {
  const storedPhone = handoffPhone(stored);
  if (draft == null) return stored ?? "";
  if (storedPhone && !handoffPhone(draft) && draft.trim() !== "") return storedPhone;
  return draft;
}
