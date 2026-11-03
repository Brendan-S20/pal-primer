/** The service a visitor came for, carried from the marketing site into signup
 *  (site-r2-03 / F-06).
 *
 *  Every "Start free trial" on houndstack.com links to
 *  `/sign-up?service=<line>&utm_source=site&utm_content=<page>`. Before this,
 *  no CTA carried anything, so a trainer who clicked through from
 *  /services/dog-training was set up as a scooping business (pet waste is the
 *  column default) and had to notice and untick it.
 *
 *  The value is a URL parameter, so it is untrusted: only an id the settings
 *  screen offers is accepted, and anything else reads as "nothing asked",
 *  which leaves today's default alone. `other` is accepted by the database but
 *  never offered, so a link cannot ask for it. Whether the line is bookable
 *  right now is a platform switch read on the server at signup, not here. */

import {
  OFFERED_SERVICE_LINES,
  isBookableLine,
  type ServiceLine,
  type ServiceLineAvailability,
} from "@/lib/service-lines";

export function requestedServiceLine(raw: unknown): ServiceLine | undefined {
  if (typeof raw !== "string") return undefined;
  // "dog-walking" and "Dog_Walking" are the same request as "dog_walking":
  // a hand-typed or slug-shaped link should not silently fall back to waste.
  const id = raw.trim().toLowerCase().replace(/-/g, "_");
  return (OFFERED_SERVICE_LINES as readonly string[]).includes(id)
    ? (id as ServiceLine)
    : undefined;
}

/** What setup step 1 shows before the owner touches it. The stored answer,
 *  unless the business has only the column default and the visitor asked for
 *  a different line that is bookable, in which case the requested line alone.
 *  A business that already chose (anything but the bare default) is never
 *  overridden by a link, and a Coming soon line is never preselected, because
 *  saving it would be refused. Until availability is known (null) nothing is
 *  changed. */
export function preselectedServiceLines(
  saved: readonly ServiceLine[],
  requested: ServiceLine | undefined,
  availability: ServiceLineAvailability | null,
): ServiceLine[] {
  if (!requested || !availability || !isBookableLine(requested, availability)) return [...saved];
  const onlyDefault = saved.length === 1 && saved[0] === "pet_waste";
  return onlyDefault ? [requested] : [...saved];
}

/** What setup step 1 starts on, before the owner touches it, combining the
 *  link's request (preselectedServiceLines) with RC3 / F-06: a business that
 *  has not answered (still the bare column default, step open) and did not
 *  come with a valid, bookable ?service= starts with nothing ticked and must
 *  choose. A valid request ticks that line alone, pet waste included. A
 *  business that has answered sees the link's preselection rules unchanged. */
export function setupStartingLines(input: {
  unanswered: boolean;
  saved: readonly ServiceLine[];
  requested: ServiceLine | undefined;
  preselected: readonly ServiceLine[];
}): ServiceLine[] {
  if (!input.unanswered) return [...input.preselected];
  const honoured = !!input.requested && input.preselected.includes(input.requested);
  return honoured ? [...input.preselected] : [];
}
