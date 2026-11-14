// /setup step 1's device draft, read back against what is saved (#770).
//
// ── WHAT WAS WRONG ────────────────────────────────────────────────────────
//
// Step 1 keeps what is typed on the device (useFormDraft, gaps-r2-12) and
// read it back whole. A draft is null-means-untouched, so a draft whose
// `lines` was ["dog_walking"] won over the saved answer through
// `lines ?? startingLines`. An owner who had saved Dog walking AND Pet waste
// reopened step 1 to find Pet waste unticked, under "We kept what you typed
// here last time", and reasonably read it as the save being lost. A draft can
// outlive the save it led to: a second tab, a remount that wrote again
// before the save landed, or a draft typed before the first save failed.
//
// ── THE RULE ──────────────────────────────────────────────────────────────
//
// Once step 1 is done, a draft is read back against what is stored:
//
//   - it can ADD a line, never take one away. A line in the saved answer
//     stays ticked; taking it off is a choice made on screen, not one a
//     stale draft makes. (An untick that was never saved is lost on a
//     reload. That is the cheaper mistake: the box is one tap.)
//   - a field equal to what is stored is not a draft, it is the stored
//     value, and goes back to untouched;
//   - a draft with nothing left in it is no draft: nothing is restored and
//     no banner is shown.
//
// Before step 1 is first saved there is nothing stored to read against for
// the lines or the zone (the lines start empty, the zone is a suggestion),
// so those are kept as typed: that is the reload gaps-r2-12 was for.
//
// The phone has one more rule (#787): sign-up stores the owner's mobile as
// the business phone before step 1 is ever opened, and a kept FRAGMENT, the
// "555-" an interrupted keystroke leaves, must not cover it. The server
// already refuses to save the fragment (#811); this is the display half. A
// fragment over a stored whole number is dropped, whether step 1 is done or
// not; a whole number typed here, a field the owner cleared, and a fragment
// with nothing stored behind it are kept (setupBusinessPhonePrefill).

import { setupBusinessPhonePrefill } from "@/lib/phone-handoff";
import { SETUP_WORKDAY_DEFAULTS, workdayField } from "@/lib/setup-workday";
import { SERVICE_LINES, type ServiceLine } from "@/lib/service-lines";

export type SetupBusinessDraft = {
  lines: ServiceLine[] | null;
  name: string | null;
  phone: string | null;
  address: string | null;
  tz: string | null;
  dayStart?: string | null;
  dayEnd?: string | null;
  officeEmail?: string | null;
  portalSlug?: string | null;
};

/** What step 1 shows for each field nobody has touched, from the server. */
export type SetupBusinessStored = {
  name: string;
  phone: string;
  address: string;
  officeEmail: string;
  portalSlug: string;
  timezone: string | null;
  dayStart: string;
  dayEnd: string;
};

type Branding = {
  name?: string | null;
  contact_phone?: string | null;
  contact_address?: string | null;
  contact_email?: string | null;
} | null;

/** The stored values, from the same reads step 1 draws from. */
export function setupBusinessStored(
  branding: Branding | undefined,
  dispatch: Record<string, unknown> | null | undefined,
  portalSlug: string | null | undefined,
): SetupBusinessStored {
  const tz = dispatch?.timezone;
  return {
    name: branding?.name ?? "",
    phone: branding?.contact_phone ?? "",
    address: branding?.contact_address ?? "",
    officeEmail: branding?.contact_email ?? "",
    portalSlug: portalSlug ?? "",
    timezone: typeof tz === "string" && tz ? tz : null,
    dayStart: workdayField(dispatch?.workday_start, SETUP_WORKDAY_DEFAULTS.start),
    dayEnd: workdayField(dispatch?.workday_end, SETUP_WORKDAY_DEFAULTS.end),
  };
}

/** A draft's lines with every saved line kept, in the usual order. */
export function linesWithSaved(
  draft: readonly ServiceLine[],
  saved: readonly ServiceLine[],
): ServiceLine[] {
  return SERVICE_LINES.filter((l) => draft.includes(l) || saved.includes(l));
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

/** null when a typed value is the stored one, so it reads as untouched. */
const unlessStored = (typed: string | null | undefined, stored: string | null) =>
  typed == null || typed === stored ? null : typed;

/**
 * The draft step 1 may restore, or null for none (no banner).
 *
 * `alreadyDone` is the server's word that step 1 has been saved;
 * `savedLines` is the stored answer and only counts once it is `linesKnown`.
 */
export function reconcileSetupBusinessDraft(
  draft: SetupBusinessDraft,
  ctx: {
    alreadyDone: boolean;
    savedLines: readonly ServiceLine[];
    linesKnown: boolean;
    stored: SetupBusinessStored;
  },
): SetupBusinessDraft | null {
  const { alreadyDone, savedLines, linesKnown, stored } = ctx;
  let lines = Array.isArray(draft.lines) ? draft.lines : null;
  if (lines && alreadyDone && linesKnown) {
    const kept = linesWithSaved(lines, savedLines);
    lines = sameSet(kept, savedLines) ? null : kept;
  }
  const out: SetupBusinessDraft = {
    lines,
    name: unlessStored(draft.name, stored.name),
    phone: unlessStored(setupBusinessPhonePrefill(draft.phone, stored.phone), stored.phone),
    address: unlessStored(draft.address, stored.address),
    tz: alreadyDone ? unlessStored(draft.tz, stored.timezone) : (draft.tz ?? null),
    dayStart: unlessStored(draft.dayStart, stored.dayStart),
    dayEnd: unlessStored(draft.dayEnd, stored.dayEnd),
    officeEmail: unlessStored(draft.officeEmail, stored.officeEmail),
    portalSlug: unlessStored(draft.portalSlug, stored.portalSlug),
  };
  return Object.values(out).some((v) => v !== null) ? out : null;
}
