/** What a dog-walking client is told when a walk does not happen or moves
 *  (#410). Pure, so the templates, the senders and the tests read one copy.
 *
 *  Only a dog walk ever reaches these: a pet-waste client gets the emails
 *  they always got. English on purpose: anything sent to a customer speaks
 *  the business's language (CLAUDE.md, "What stays English"). */

import { formatDay } from "@/lib/format";
import { windowLabel } from "@/lib/walk-windows";

/** The skip codes skip_visit accepts (my-day.functions.ts, skipVisit). The
 *  last three are a walker's own (WALK_SKIP_REASON_CODES in
 *  skip-rules.functions.ts). The rest are older codes a walk may still carry
 *  from before the walker had a list of its own, or from the office. */
export const SKIP_CODES = [
  "client_cancelled_late",
  "gate_locked",
  "dog_outside",
  "weather",
  "our_fault",
  "access_blocked",
  "unsafe_conditions",
  "other",
  "key_failed",
  "no_one_home",
  "dog_unwell",
] as const;

/** A skip reason in plain words for the client. The walker's own typed reason
 *  is never sent: it was written for the office.
 *
 *  dog_outside is a yard reason (the dog was out in the yard, so the scooper
 *  stayed out). It says nothing true about a walk, so a walk skipped with it
 *  before the walker's list existed reads as the general sentence. */
const WALK_SKIP_REASON: Record<(typeof SKIP_CODES)[number], string> = {
  client_cancelled_late: "The walk was cancelled at short notice.",
  gate_locked: "The walker could not get in because the gate was locked.",
  dog_outside: "The walker could not do the walk today.",
  weather: "The weather made it unsafe to walk.",
  our_fault: "We could not make it today, and that is on us.",
  access_blocked: "The walker could not get in.",
  unsafe_conditions: "It was not safe to walk today.",
  other: "The walker could not do the walk today.",
  key_failed: "The walker could not get in because the key or door code did not work.",
  no_one_home: "Nobody was home to hand over your dog when the walker arrived.",
  dog_unwell: "Your dog seemed unwell, so the walker did not take them out.",
};

export function walkSkipReason(code: string | null | undefined): string {
  return (WALK_SKIP_REASON as Record<string, string>)[code ?? ""] ?? WALK_SKIP_REASON.other;
}

/** The "on my way" text for a dog walk. A walker always comes in, so there is
 *  no ENT / DNE: the pet-waste text's handshake (on-my-way.ts) asks whether
 *  to enter a yard with the dogs out, which a walk never does. `dogs` is
 *  dogNamesPhrase's "Bella and Max", or "your dog". */
export function walkOnMyWayText(p: {
  customerName: string;
  orgName: string;
  techName: string | null;
  dogs: string;
  eta: string | null;
  trackUrl?: string | null;
}): string {
  const who = p.techName ? `${p.techName} from ${p.orgName}` : `your ${p.orgName} walker`;
  const when = p.eta ? `, arriving ${p.eta}` : "";
  const track = p.trackUrl ? ` Live map: ${p.trackUrl}` : "";
  return `Hi ${p.customerName}, ${who} is on the way to pick up ${p.dogs} for today's walk${when}.${track} Reply STOP to opt out.`;
}

export type WalkNotDoneKind = "skipped" | "missed";

export function walkNotDoneSubject(
  kind: WalkNotDoneKind,
  dogs: string,
  day: string,
): string {
  return kind === "skipped" ? `We could not walk ${dogs} today` : `Your walk on ${day} did not happen`;
}

/** Days of the week as subscriptions.weekdays stores them: 0 is Sunday. */
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Mon, Wed and Fri", or null for no fixed days. */
export function weekdaysPhrase(days: readonly number[] | null | undefined): string | null {
  const clean = [...new Set((days ?? []).filter((d) => d >= 0 && d <= 6))].sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const names = clean.map((d) => DAY_SHORT[d]);
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** One walk's place on the calendar: a day or a set of weekdays, and a window. */
export type WalkSlot = {
  /** A visit's date, YYYY-MM-DD. */
  day?: string | null;
  /** A plan's days of the week. */
  weekdays?: readonly number[] | null;
  earliest?: string | null;
  latest?: string | null;
};

/** "Mon, Oct 19, 10 AM to 12 PM" / "Mon and Thu, any time". */
export function walkSlotLabel(s: WalkSlot): string {
  const when = s.day ? formatDay(s.day) : (weekdaysPhrase(s.weekdays) ?? "Your usual days");
  return `${when}, ${windowLabel(s.earliest, s.latest) ?? "any time"}`;
}

export type WalkScheduleLine = { before: string; after: string };

/** The line for one moved walk, or null when nothing a client reads changed. */
export function walkScheduleLine(before: WalkSlot, after: WalkSlot): WalkScheduleLine | null {
  const b = walkSlotLabel(before);
  const a = walkSlotLabel(after);
  return a === b ? null : { before: b, after: a };
}

const clock = (v: string | null | undefined) => (v ? v.slice(0, 5) : null);

/** Whether a plan's days or window changed: the two things a walk plan's
 *  client is told about. A price or a note is not a schedule change. */
export function walkPlanScheduleChanged(before: WalkSlot, after: WalkSlot): boolean {
  const days = (d: readonly number[] | null | undefined) =>
    [...new Set(d ?? [])].sort((x, y) => x - y).join(",");
  return (
    days(before.weekdays) !== days(after.weekdays) ||
    clock(before.earliest) !== clock(after.earliest) ||
    clock(before.latest) !== clock(after.latest)
  );
}

/** At most this many lines in one email. A bulk move of a whole month says
 *  the first few and "and N more". */
export const SCHEDULE_LINES_MAX = 10;
