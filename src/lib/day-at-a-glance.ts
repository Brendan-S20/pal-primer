/**
 * The rest of the day in three numbers, for somebody holding a phone in a
 * driveway.
 *
 * My Day already answered "how far through am I" (the progress bar) and "where
 * am I going" (the map). It never answered the two things a technician actually
 * asks at 7am and again at noon: when does this end, and is there anything
 * ahead I should know about before I open a gate.
 *
 * Everything here is computed from the visits My Day has already fetched. No
 * new query and no new column — the facts were on screen all along, one card at
 * a time, several scrolls apart, which is the one shape a glance cannot take in.
 *
 * It counts the stops STILL AHEAD, not the whole day. A tech at stop 9 of 12
 * does not need to be told about the aggressive dog at stop 3; the number that
 * means something is the one still in front of them, and it goes down as the
 * day is worked.
 *
 * THREE, not six. Codes, keys, parking and dogs-in-the-yard were all in an
 * earlier draft of this and all of them came out. A count is only worth a line
 * here if it changes what the tech does before arriving, and "3 codes and keys"
 * does not — the code is on the card, at the stop, which is where it is needed
 * and where it already was. Six chips at 360px is a block to read, not a glance,
 * and a summary nobody can take in at arm's length is just the cards again.
 */

/** Hazards severe enough to change how you approach the property. The other five
 *  flags (bees, sharp objects, slippery surfaces, invisible fence, dog in the
 *  yard) are on the card where they belong — promoting all eight to a headline
 *  number makes it meaningless, because on a real route nearly every stop trips
 *  at least one of them. */
const CRITICAL_HAZARDS = ["do_not_enter_if_dog_out", "aggressive_dog", "escape_risk"] as const;

export type DayGlance = {
  /** Stops not yet completed or skipped. */
  remaining: number;
  /** Latest `eta_end` among the remaining stops, ISO, or null when the route
   *  carries no ETAs — which is its own answer and not a missing one. */
  finishAt: string | null;
  /** Remaining stops carrying a critical hazard. */
  warnings: number;
};

const OPEN = new Set(["scheduled", "in_progress"]);

export function dayAtAGlance(visits: readonly any[]): DayGlance {
  const ahead = visits.filter((v) => OPEN.has(String(v?.status)));

  let finishAt: string | null = null;
  for (const v of ahead) {
    // `eta_end` is written by the route optimizer. A route nobody optimized has
    // none, and so does a day assembled by hand — in both cases there is no
    // finish time to report, and saying so is honest where guessing is not.
    const end = v?.eta_end;
    if (typeof end !== "string" || !end) continue;
    const t = Date.parse(end);
    if (Number.isNaN(t)) continue;
    if (finishAt === null || t > Date.parse(finishAt)) finishAt = end;
  }

  let warnings = 0;
  for (const v of ahead) {
    const p = v?.properties;
    // One stop, one count, however many of the three flags it carries: the
    // question is "how many stops need care", not "how many flags are on file".
    if (p && CRITICAL_HAZARDS.some((k) => p[k])) warnings += 1;
  }

  return { remaining: ahead.length, finishAt, warnings };
}
