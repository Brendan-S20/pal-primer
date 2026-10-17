/** What a client is told after a walk (#410). Pure, so the email, the push and
 *  the tests read one copy of the rules.
 *
 *  English on purpose: anything sent to a customer speaks the business's
 *  language, never the walker's (CLAUDE.md, "What stays English"). */

import { orgLocalTime } from "@/lib/org-day";

/** The client push for a finished walk. */
export const WALK_PUSH_TITLE = "Walk complete";
export const WALK_PUSH_BODY = "Your walk is done.";

export const REPORT_NOTE_MAX = 500;

/** Whole minutes from start to end, rounded. Null when either end is missing
 *  or unreadable, or the end is not after the start: a duration the walker
 *  never measured is left out rather than guessed. */
export function walkDurationMinutes(
  startedAt: string | null | undefined,
  completedAt: string | null | undefined,
): number | null {
  if (!startedAt || !completedAt) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return null;
  return Math.max(1, Math.round((end - start) / 60_000));
}

/** "Pee: yes" / "Poo: no", or null when the walker did not record it. */
export function yesNoLine(label: "Pee" | "Poo", value: boolean | null | undefined): string | null {
  if (value == null) return null;
  return `${label}: ${value ? "yes" : "no"}`;
}

/** "Bella", "Bella and Max", "Bella, Max and Rex", or "your dog" when the
 *  visit has no dog names on file. A sitting visit passes "your pets". */
export function dogNamesPhrase(
  names: readonly (string | null | undefined)[],
  fallback = "your dog",
): string {
  const clean = names.map((n) => (n ?? "").trim()).filter(Boolean);
  if (clean.length === 0) return fallback;
  if (clean.length === 1) return clean[0];
  return `${clean.slice(0, -1).join(", ")} and ${clean[clean.length - 1]}`;
}

/** The first word of the walker's name, or null. */
export function walkerFirstName(name: string | null | undefined): string | null {
  const first = (name ?? "").trim().split(/\s+/)[0];
  return first || null;
}

/** "9:05 AM" on the business's clock, or "" for a missing or unreadable time. */
export function walkClock(instant: string | null | undefined, timezone: string): string {
  return orgLocalTime(instant, timezone, "en-US");
}

export function walkReportSubject(orgName: string | null | undefined, dogs: string): string {
  return `${orgName?.trim() || "Your walker"} walked ${dogs} today`;
}

export type WalkReportInput = {
  startedAt: string | null;
  completedAt: string | null;
  timezone: string;
  pee: boolean | null;
  poo: boolean | null;
  reportNote: string | null;
  dogNames: readonly (string | null | undefined)[];
  walkerName: string | null;
};

/** What visit-completed.tsx draws for a walk. Every field is optional in the
 *  template, so a line with nothing recorded is simply absent. */
export type WalkReportEmail = {
  dogs: string;
  walkerFirstName?: string;
  startTime?: string;
  endTime?: string;
  durationMin?: number;
  peeLine?: string;
  pooLine?: string;
  reportNote?: string;
};

export function walkReportEmail(input: WalkReportInput): WalkReportEmail {
  const out: WalkReportEmail = { dogs: dogNamesPhrase(input.dogNames) };
  const walker = walkerFirstName(input.walkerName);
  if (walker) out.walkerFirstName = walker;
  const start = input.startedAt ? walkClock(input.startedAt, input.timezone) : "";
  const end = input.completedAt ? walkClock(input.completedAt, input.timezone) : "";
  if (start) out.startTime = start;
  if (end) out.endTime = end;
  const minutes = walkDurationMinutes(input.startedAt, input.completedAt);
  if (minutes != null) out.durationMin = minutes;
  const pee = yesNoLine("Pee", input.pee);
  const poo = yesNoLine("Poo", input.poo);
  if (pee) out.peeLine = pee;
  if (poo) out.pooLine = poo;
  const note = (input.reportNote ?? "").trim().slice(0, REPORT_NOTE_MAX);
  if (note) out.reportNote = note;
  return out;
}

/** The walk report's note, as record_walk_report stores it: trimmed, empty
 *  is null. Over 500 characters is refused there; here it is cut, so a field
 *  the walker typed into never fails the completion. */
export function cleanReportNote(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return t ? t.slice(0, REPORT_NOTE_MAX) : null;
}
