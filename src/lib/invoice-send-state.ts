// An invoice that is held for a send date that has not come yet reads
// "Scheduled", not "Open" (#1042). Display only: the stored status stays
// `open`, and every filter, count, total, report and export keeps reading it.
//
// The rule is the one the "Scheduled to send" chip and the drawer already
// used, tightened to the day: an open invoice nobody has emailed, whose
// send_after is after the ORG's today. Once send_after arrives, or the invoice
// has no send_after (a manual one), or it has been sent, it is just open.
// Both dates are calendar days (YYYY-MM-DD) in the org's timezone, so a plain
// string comparison is the date comparison.

export const SCHEDULED_LABEL = "Scheduled";

export function isScheduledToSend(
  inv: { status: string; sent_at?: string | null; send_after?: string | null },
  today: string,
): boolean {
  return inv.status === "open" && !inv.sent_at && !!inv.send_after && inv.send_after > today;
}

/** The invoice has not gone out and cannot go by email, because the client has
 *  no address (#1065). A send date does not change that, so such an invoice
 *  must not read as scheduled. `email` is what the screen loaded for the
 *  client: `undefined` means it did not load one, and claims nothing. */
export function cannotEmailInvoice(
  inv: { status: string; sent_at?: string | null },
  email: string | null | undefined,
): boolean {
  return email !== undefined && inv.status === "open" && !inv.sent_at && !email?.trim();
}

export const NO_EMAIL_LABEL = "Can't email: no address";
