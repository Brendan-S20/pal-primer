/** What the new-client wizard's Plan step starts on, by service line (F-04,
 *  RC3 in the round-2 audit).
 *
 *  The step started every business on a weekly plan, and a walk-like service
 *  on Monday to Friday: right for a scooping route and for a dog walker, and
 *  wrong for everybody else. A groomer got "Bath & brush, weekly, 5 days a
 *  week", a trainer a Mon-Fri Evaluation, a sitter a weekday drop-in plan for
 *  two cats. Those lines book a groom, a lesson or a stay; a repeating plan is
 *  the exception, not the place to start.
 *
 *  Pure, so the wizard and the tests read one copy. Only the STARTING values
 *  live here: everything stays one tap away, and nothing is refused. */

import { WORK_WEEK } from "@/lib/weekday-set";
import { runsPetWaste, type ServiceLine } from "@/lib/service-lines";

/** Lines whose ordinary customer is on a repeating plan from day one. */
const PLAN_FIRST_LINES: readonly ServiceLine[] = ["pet_waste", "dog_walking"];

/** Whether "Skip subscription for now" starts ticked: when the business runs
 *  no line that is sold as a repeating plan. Unknown lines (`known` false)
 *  read as pet waste, which is a plan, so the box starts unticked. */
export function planStartsSkipped(lines: readonly ServiceLine[], known = true): boolean {
  if (!known) return false;
  return !lines.some((l) => PLAN_FIRST_LINES.includes(l));
}

/** The days a weekly plan of this line starts on. A walk is a weekday thing;
 *  anything else starts on the first visit's weekday alone (0 = Sunday), so
 *  a groom or a lesson is once a week, not five times. */
export function defaultPlanWeekdays(
  line: ServiceLine | null | undefined,
  firstVisitWeekday: number,
): number[] {
  if (line === "dog_walking") return [...WORK_WEEK];
  return [firstVisitWeekday];
}

/** The property hazards the wizard offers. Bees, sharp objects, "dog in the
 *  yard during service" and "do NOT enter if dog is outside" (the yard gate,
 *  #768) are a yard's, asked of a business that scoops; the rest matter at
 *  any door. A hazard already ticked is never hidden (the wizard starts with
 *  none ticked). */
export const PROPERTY_HAZARDS = [
  ["doNotEnterIfDogOut", "Do NOT enter if dog is outside", true],
  ["aggressiveDog", "Aggressive dog", false],
  ["escapeRisk", "Escape risk (close gate)", false],
  ["invisibleFence", "Invisible fence", false],
  ["dogInYardDuringService", "Dog in yard during service", true],
  ["beesWasps", "Bees / wasps", true],
  ["sharpObjects", "Sharp objects", true],
  ["slipperySurfaces", "Slippery surfaces", false],
] as const;

export type PropertyHazardKey = (typeof PROPERTY_HAZARDS)[number][0];

export function propertyHazardsFor(
  lines: readonly ServiceLine[],
  ticked: Partial<Record<PropertyHazardKey, boolean>> = {},
  /** The line of the service the client is set up for, when known (#768): a
   *  walk client of a business that also scoops is not asked about the yard. */
  planLine?: ServiceLine | null,
): { key: PropertyHazardKey; label: string }[] {
  const petWaste = runsPetWaste(lines) && (planLine == null || planLine === "pet_waste");
  return PROPERTY_HAZARDS.filter(([key, , yardOnly]) => petWaste || !yardOnly || ticked[key]).map(
    ([key, label]) => ({ key, label }),
  );
}
