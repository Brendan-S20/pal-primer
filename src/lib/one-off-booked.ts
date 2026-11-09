// What the one-off dialog says when a booking comes back (#662).
//
// The server books a one-off on the first open day ON OR AFTER the one asked
// for: generate_visits_core steps past a blackout or a day outside the work
// days. So a Saturday asked of a Monday-to-Friday business comes back as
// Monday, and the toast used to read "Visit booked for 2026-11-09" as if that
// had been the request. The day asked for is said out loud when it moved.
//
// The tech is named too: "booked" alone does not say whose route it is on,
// and an assignment that failed (a tech who is away that day) leaves the
// visit unassigned, which is a warning and not a success.

import { formatDay } from "@/lib/format";

export type OneOffBooked = {
  scheduledOn: string;
  assigned: boolean;
  assignWarning: string | null;
};

export function oneOffBookedCopy(input: {
  requestedOn: string;
  result: OneOffBooked;
  /** The tech picked in the dialog, if any. */
  assigneeName: string | null;
}): { success: string; warnings: string[] } {
  const { requestedOn, result, assigneeName } = input;
  const day = formatDay(result.scheduledOn);
  const who = result.assigned
    ? assigneeName
      ? ` with ${assigneeName}`
      : ""
    : assigneeName
      ? `, but not assigned to ${assigneeName}`
      : ", unassigned";
  const warnings: string[] = [];
  if (result.scheduledOn !== requestedOn) {
    warnings.push(
      `${formatDay(requestedOn)} is not open for booking (outside your work days, or a blackout day), so it went on the next open day.`,
    );
  }
  return { success: `Visit booked for ${day}${who}.`, warnings };
}

/** Why a one-off's arrival window cannot be booked, or null (F-05). Either
 *  end may be empty; with both set, "after" comes before "by". The inputs'
 *  HH:MM values compare as strings. */
export function oneOffWindowProblem(earliest: string, latest: string): string | null {
  if (earliest && latest && earliest >= latest) return "Arrive after has to be before Arrive by.";
  return null;
}
