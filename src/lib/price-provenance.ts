// Where a service's price came from, said in one line.
//
// `subscriptions.price_cents` is captured once and only changes when somebody
// edits it, so the number on the screen can be anything from "today's zone
// rate" to "a figure agreed in 2024 that nobody has revisited". Three columns
// record which: `priced_from_zone_id`, `priced_at`, `price_overridden_at`.
//
// All three are nullable and NULL means "set before this was recorded", not
// "never happened". That distinction is the whole point of the columns, so
// this module never renders a NULL as a negative claim: an unknown price says
// it is unknown rather than "priced from its zone" or "never overridden".

/** The three columns, exactly as they come off the row. */
export interface PriceProvenanceFields {
  priced_at: string | null;
  priced_from_zone_id: string | null;
  price_overridden_at: string | null;
}

export type PriceProvenanceTone = "manual" | "zone" | "service" | "dated" | "unknown";

export interface PriceProvenance {
  /** Which case this is, for a caller that wants to style rather than read. */
  tone: PriceProvenanceTone;
  text: string;
}

/**
 * Deliberately not `toLocaleDateString`. The office and the field see the same
 * record and a test should not depend on the runner's locale; a date that
 * cannot be misread as month/day-transposed is worth more here than one that
 * matches the browser.
 */
export function formatProvenanceDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "an unreadable date";
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * One sentence for the price's origin.
 *
 * `lookupZoneName` is passed rather than a zones array so this stays pure and
 * the caller keeps whatever it already has in scope. A zone that has since
 * been deleted resolves to undefined, and the sentence says the zone is gone
 * instead of printing a uuid or pretending there was none.
 */
export function describePriceProvenance(
  sub: PriceProvenanceFields,
  lookupZoneName: (zoneId: string) => string | undefined,
  /** The plan's service when it is priced from the service rather than a
   *  zone (phase 5: a walk, a sit, a groom). Such a plan records no zone,
   *  and "Set on <date>" would understate what is known. */
  serviceName?: string | null,
): PriceProvenance {
  // An override outranks everything: once a person has typed a number, which
  // zone rate it started from is history.
  if (sub.price_overridden_at) {
    return {
      tone: "manual",
      text: `Set by hand on ${formatProvenanceDate(sub.price_overridden_at)}`,
    };
  }

  if (sub.priced_at && sub.priced_from_zone_id) {
    const name = lookupZoneName(sub.priced_from_zone_id);
    return {
      tone: "zone",
      text: name
        ? `From the ${name} rate on ${formatProvenanceDate(sub.priced_at)}`
        : `From a zone that has since been deleted, on ${formatProvenanceDate(sub.priced_at)}`,
    };
  }

  if (sub.priced_at && serviceName) {
    return {
      tone: "service",
      text: `From the ${serviceName} price on ${formatProvenanceDate(sub.priced_at)}`,
    };
  }

  if (sub.priced_at) {
    // Priced with no zone in force: a client outside every zone still gets a
    // number typed into the form.
    return { tone: "dated", text: `Set on ${formatProvenanceDate(sub.priced_at)}` };
  }

  // Every column NULL. Says so, rather than claiming the price came from the
  // zone it happens to sit in today.
  return { tone: "unknown", text: "Set before the app recorded where prices came from" };
}
