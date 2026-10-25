/** What a client is told after a pet sitting visit (#411). Pure, so the
 *  emails, the push and the tests read one copy of the rules. The walk
 *  report's helpers (walk-report.ts) are reused rather than copied.
 *
 *  English on purpose: anything sent to a customer speaks the business's
 *  language, never the sitter's (CLAUDE.md, "What stays English"). */

import { REPORT_NOTE_MAX, dogNamesPhrase, walkClock, walkerFirstName } from "@/lib/walk-report";
import { stayDatesLabel, type StayKind } from "@/lib/stays";
import type { CareKind, CareStatus } from "@/lib/sit-day";

export const SIT_PUSH = {
  drop_in: { title: "Visit complete", body: "Your pets were checked on." },
  overnight: { title: "Check-out done", body: "Your pets had company overnight." },
} as const;

/** "Luna", "Luna and Max", or "your pets". */
export function petNamesPhrase(names: readonly (string | null | undefined)[]): string {
  return dogNamesPhrase(names, "your pets");
}

const capitalize = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export function sitReportSubject(
  orgName: string | null | undefined,
  pets: string,
  overnight: boolean,
): string {
  if (overnight) return `${capitalize(pets)} had company overnight`;
  return `${orgName?.trim() || "Your sitter"} checked on ${pets} today`;
}

/** A care log row as the server reads it for an email. */
export type CareRow = {
  pet_id: string | null;
  kind: CareKind | string;
  med_name: string | null;
  status: CareStatus | string;
  missed_reason: string | null;
  note: string | null;
  at: string;
};

const KIND_DONE: Record<string, string> = {
  feed: "Fed",
  water: "Fresh water",
  litter: "Litter or yard cleaned",
  walk: "Walked",
  other: "Other care",
};

const KIND_NOUN: Record<string, string> = {
  feed: "Feeding",
  water: "Fresh water",
  litter: "Litter or yard",
  walk: "Walk",
  other: "Other care",
};

/** One line of what a pet got: "Fed at 8:05 AM", "Insulin given at 8:10 AM",
 *  "Insulin missed: she hid under the bed". */
export function careLine(row: CareRow, timezone: string): string {
  const time = walkClock(row.at, timezone);
  const at = time ? ` at ${time}` : "";
  const reason = (row.missed_reason ?? "").trim();
  if (row.kind === "meds") {
    const med = (row.med_name ?? "").trim() || "Medication";
    return row.status === "missed" ? `${med} missed: ${reason}` : `${med} given${at}`;
  }
  if (row.status === "missed") return `${KIND_NOUN[row.kind] ?? "Care"} missed: ${reason}`;
  const note = (row.note ?? "").trim();
  if (row.kind === "other" && note) return `${note}${time ? ` (${time})` : ""}`;
  return `${KIND_DONE[row.kind] ?? "Done"}${at}`;
}

export type PetCareLines = { pet: string; lines: string[] };
export type MissedMed = { pet: string; med: string; reason: string };

type PetName = { id: string; name: string | null };

const nameOf = (pets: readonly PetName[], id: string | null) =>
  (id && (pets.find((p) => p.id === id)?.name ?? "").trim()) || "All pets";

/** What each pet got, oldest first, one group per pet in the order they
 *  first appear, with "All pets" for an entry that names none. */
export function careByPet(
  rows: readonly CareRow[],
  pets: readonly PetName[],
  timezone: string,
): PetCareLines[] {
  const groups = new Map<string, PetCareLines>();
  for (const row of [...rows].sort((a, b) => a.at.localeCompare(b.at))) {
    const pet = nameOf(pets, row.pet_id);
    const g = groups.get(pet) ?? { pet, lines: [] };
    g.lines.push(careLine(row, timezone));
    groups.set(pet, g);
  }
  return [...groups.values()];
}

/** Every med logged missed, with the pet and the reason. */
export function missedMeds(rows: readonly CareRow[], pets: readonly PetName[]): MissedMed[] {
  return rows
    .filter((r) => r.kind === "meds" && r.status === "missed")
    .map((r) => ({
      pet: nameOf(pets, r.pet_id),
      med: (r.med_name ?? "").trim() || "Medication",
      reason: (r.missed_reason ?? "").trim(),
    }));
}

/** What visit-completed.tsx draws for a pet sitting visit. */
export type SitReportEmail = {
  pets: string;
  overnight: boolean;
  sitterFirstName?: string;
  timeIn?: string;
  timeOut?: string;
  care: PetCareLines[];
  missed: MissedMed[];
  reportNote?: string;
};

export type SitReportInput = {
  overnight: boolean;
  startedAt: string | null;
  completedAt: string | null;
  timezone: string;
  pets: readonly PetName[];
  rows: readonly CareRow[];
  reportNote: string | null;
  sitterName: string | null;
};

export function sitReportEmail(input: SitReportInput): SitReportEmail {
  const out: SitReportEmail = {
    pets: petNamesPhrase(input.pets.map((p) => p.name)),
    overnight: input.overnight,
    care: careByPet(input.rows, input.pets, input.timezone),
    missed: missedMeds(input.rows, input.pets),
  };
  const sitter = walkerFirstName(input.sitterName);
  if (sitter) out.sitterFirstName = sitter;
  const tin = input.startedAt ? walkClock(input.startedAt, input.timezone) : "";
  const tout = input.completedAt ? walkClock(input.completedAt, input.timezone) : "";
  if (tin) out.timeIn = tin;
  if (tout) out.timeOut = tout;
  const note = (input.reportNote ?? "").trim().slice(0, REPORT_NOTE_MAX);
  if (note) out.reportNote = note;
  return out;
}

/** "In at 8:02 AM, out at 8:31 AM." An overnight says checked in and out. */
export function sitTimesSentence(
  r: Pick<SitReportEmail, "overnight" | "timeIn" | "timeOut">,
): string {
  const [inWord, outWord] = r.overnight ? ["Checked in", "checked out"] : ["In", "out"];
  if (r.timeIn && r.timeOut) return `${inWord} at ${r.timeIn}, ${outWord} at ${r.timeOut}.`;
  if (r.timeOut) return `${capitalize(outWord)} at ${r.timeOut}.`;
  return "";
}

// ── A missed medication ─────────────────────────────────────────────────

/** The office notification (English: office copy). */
export function missedMedNotice(p: {
  sitter: string | null;
  pet: string | null;
  med: string;
  reason: string;
  client: string | null;
}): { title: string; body: string } {
  const who = p.sitter?.trim() || "A sitter";
  const pet = p.pet?.trim();
  const client = p.client?.trim();
  return {
    title: pet ? `${who} missed ${pet}'s ${p.med}` : `${who} missed ${p.med}`,
    body: [p.reason.trim(), client].filter(Boolean).join(". "),
  };
}

export function missedMedsSubject(pets: string): string {
  return `A medication was missed for ${pets}`;
}

// ── The stay summary ────────────────────────────────────────────────────

export type StaySummaryEmail = {
  pets: string;
  dates: string;
  visitsDone: number;
  visitsTotal: number;
  overnight: boolean;
  missed: Array<MissedMed & { day: string }>;
  portalUrl?: string;
};

export function staySummarySubject(pets: string): string {
  return `Stay summary for ${pets}`;
}

/** "5 of 5 nights" / "9 of 10 visits". */
export function staySummaryCount(
  s: Pick<StaySummaryEmail, "visitsDone" | "visitsTotal" | "overnight">,
): string {
  const noun = s.overnight
    ? s.visitsTotal === 1
      ? "night"
      : "nights"
    : s.visitsTotal === 1
      ? "visit"
      : "visits";
  return `${s.visitsDone} of ${s.visitsTotal} ${noun}`;
}

export function staySummaryDates(kind: StayKind, startsOn: string, endsOn: string): string {
  return stayDatesLabel(kind, startsOn, endsOn);
}
