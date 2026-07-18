// Parse a portal vacation-hold request out of a concern (qc_ticket) message.
//
// The portal writes these when portal_auto_apply_changes is off (see
// portal_request_vacation_hold): the message is formatted as
//   "Vacation hold requested 2026-07-23 → 2028-10-17. <reason>"
// The Concerns inbox uses this to offer a structured "Create hold from request"
// action (C4/G4) that prefills the shared hold drawer instead of leaving the
// office to retype the dates.

export type ParsedHoldRequest = {
  startsOn: string;
  endsOn: string;
  reason: string;
};

const ISO_RANGE = /(\d{4}-\d{2}-\d{2})\s*(?:→|->|–|—|to|through|until|-)\s*(\d{4}-\d{2}-\d{2})/i;

/**
 * Returns the parsed date range + reason when `message` looks like a vacation
 * hold request, or null otherwise. A message must mention "hold" AND contain a
 * start/end ISO date pair so an unrelated concern that happens to include dates
 * is never mistaken for a hold request.
 */
export function parseHoldRequest(message: string | null | undefined): ParsedHoldRequest | null {
  if (!message || !/hold/i.test(message)) return null;
  const m = message.match(ISO_RANGE);
  if (!m) return null;
  const [, startsOn, endsOn] = m;
  if (endsOn < startsOn) return null;
  // Reason is whatever trails the end date, stripped of the leading ". ".
  const after = message.slice(message.indexOf(endsOn) + endsOn.length);
  const reason = after.replace(/^[.\s]+/, "").trim();
  return { startsOn, endsOn, reason };
}
