/** A new-client draft read back from the device, made safe to type into
 *  (#784, Nov 10 2026 retest).
 *
 *  The wizard keeps what was typed in localStorage (useFormDraft,
 *  lib/form-drafts). What comes back is whatever JSON was stored, not the
 *  shape the wizard writes today: a draft kept by an older build, a key a
 *  newer build added, or a value that serialized as nothing all arrive as
 *  `undefined`. The wizard fed that straight into its text state and later
 *  called `.trim()` on it, so the tester's second client, with no email and
 *  the draft-restored banner on screen, stopped at Plan with "Create client
 *  did not finish. Cannot read properties of undefined (reading 'trim')".
 *
 *  Every text field the wizard trims or sends is therefore a string after a
 *  restore: the stored one when it is a string, otherwise the field's empty
 *  value. A dog row without a name is a dog row with a blank name. Nothing
 *  else is changed. Pure, so the wizard and the tests read one copy. */

/** The wizard's text fields and the value each starts empty as. */
export const NEW_CLIENT_DRAFT_TEXT_DEFAULTS = {
  displayName: "",
  primaryEmail: "",
  primaryPhone: "",
  officeNote: "",
  street: "",
  city: "",
  region: "",
  postalCode: "",
  accessNotes: "",
  parkingNotes: "",
  hazardNotes: "",
  vcName: "",
  vcPhone: "",
  vcEmail: "",
  unitCount: "1",
  stationCount: "",
  priceOverride: "",
  serviceId: "",
  fcChoice: "",
  fcOverride: "",
} as const;

type TextField = keyof typeof NEW_CLIENT_DRAFT_TEXT_DEFAULTS;

/** `draft` with every wizard text field a string and every dog named (if
 *  blank). A field the stored draft never had takes its empty value. */
export function withNewClientDraftDefaults<T extends object>(draft: T): T {
  const raw = (draft ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...raw };
  for (const field of Object.keys(NEW_CLIENT_DRAFT_TEXT_DEFAULTS) as TextField[]) {
    if (typeof raw[field] !== "string") out[field] = NEW_CLIENT_DRAFT_TEXT_DEFAULTS[field];
  }
  if (Array.isArray(raw.dogs)) {
    out.dogs = raw.dogs.map((d) => {
      const dog = d && typeof d === "object" ? (d as Record<string, unknown>) : {};
      return typeof dog.name === "string" ? dog : { ...dog, name: "" };
    });
  }
  return out as T;
}
