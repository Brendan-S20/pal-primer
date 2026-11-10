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

/** The days a weekly plan starts on: the first visit's weekday alone
 *  (0 = Sunday), for every line (#774).
 *
 *  A walk used to start on Monday to Friday. An owner who switched the
 *  service from pet waste to a 30-minute walk got five walks a week without
 *  choosing them, and the plan was saved that way. One day is what a person
 *  can see and add to: each tap on Days each week adds a day, so a five-day
 *  walker is four taps away, and nobody is booked for days they never picked.
 *  `line` is kept so a line can be given its own start again, on purpose. */
export function defaultPlanWeekdays(
  _line: ServiceLine | null | undefined,
  firstVisitWeekday: number,
): number[] {
  return [firstVisitWeekday];
}

/** The day the wizard's First visit starts on: tomorrow on the business's
 *  calendar. Today, created in the evening, meant a visit that night after
 *  the route had ended (persona review, 2026-09-27). The form says so, and
 *  Today is one tap (#774). */
export function defaultFirstVisit(orgToday: string): string {
  return nextDay(orgToday);
}

/** The next calendar day after a YYYY-MM-DD day. */
export function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/** What the Plan step does when the owner picks a different service (#774).
 *  Days chosen for the old service are dropped, so the new one starts from
 *  its own default, and the step says so (`notice`) instead of keeping a
 *  set the owner picked for something else. No change, no notice. */
export function serviceSwitch(opts: {
  from: string | null | undefined;
  to: string;
  hadDays: boolean;
  toName: string | null | undefined;
}): { reset: boolean; notice: string | null } {
  if (!opts.to || opts.to === (opts.from ?? "")) return { reset: false, notice: null };
  const name = opts.toName?.trim() || "the new service";
  return {
    reset: true,
    notice: opts.hadDays
      ? `Days reset for ${name}. They start on the first visit's day again.`
      : `Days set for ${name}: the first visit's day. Tap more days to add them.`,
  };
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
