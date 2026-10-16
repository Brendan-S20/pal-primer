/** What a dog-walking client is told when a walk does not happen or moves
 *  (#410). Pure, so the templates, the senders and the tests read one copy.
 *
 *  Only a dog walk ever reaches these: a pet-waste client gets the emails
 *  they always got. English on purpose: anything sent to a customer speaks
 *  the business's language (CLAUDE.md, "What stays English"). */

import { formatDay } from "@/lib/format";
import { windowLabel } from "@/lib/walk-windows";

/** The skip codes skip_visit accepts (my-day.functions.ts, skipVisit). */
export const SKIP_CODES = [
  "client_cancelled_late",
  "gate_locked",
  "dog_outside",
  "weather",
  "our_fault",
  "access_blocked",
  "unsafe_conditions",
  "other",
] as const;

/** A skip reason in plain words for the client. The walker's own typed reason
 *  is never sent: it was written for the office. */
const WALK_SKIP_REASON: Record<(typeof SKIP_CODES)[number], string> = {
  client_cancelled_late: "The walk was cancelled at short notice.",
  gate_locked: "The walker could not get in because the gate was locked.",
  dog_outside: "Your dog was not there when the walker arrived.",
  weather: "The weather made it unsafe to walk.",
  our_fault: "We could not make it today, and that is on us.",
  access_blocked: "The walker could not get in.",
  unsafe_conditions: "It was not safe to walk today.",
  other: "The walker could not do the walk today.",
};

export function walkSkipReason(code: string | null | undefined): string {
  return (WALK_SKIP_REASON as Record<string, string>)[code ?? ""] ?? WALK_SKIP_REASON.other;
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

// ── The office canceled a walk ──────────────────────────────────────────────

/** "Mon, Oct 19, 10 AM to 12 PM", or just "Mon, Oct 19" when the plan has no
 *  window. */
export function canceledWalkLabel(s: Pick<WalkSlot, "day" | "earliest" | "latest">): string {
  const day = s.day ? formatDay(s.day) : "";
  const window = windowLabel(s.earliest, s.latest);
  return window ? `${day}, ${window}` : day;
}

/** One canceled walk names its day; several say how many. */
export function walkCanceledSubject(count: number, day: string): string {
  return count > 1 ? `${count} of your walks are canceled` : `Your walk on ${day} is canceled`;
}
