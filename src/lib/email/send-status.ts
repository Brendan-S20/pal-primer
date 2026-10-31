// What a queued email's send-log rows add up to, for a page that has to say
// "sent" only when it was (#612).
//
// The log is append-only. The `pending` row written on queueing is always
// there, a `failed` row is a retry the queue is still making (up to five), and
// only these four mean it has stopped trying.
export const FINAL_EMAIL_FAILURES: ReadonlySet<string> = new Set([
  "dlq",
  "bounced",
  "suppressed",
  "complained",
]);

export type EmailLogRow = {
  status: string;
  recipient_email: string | null;
  error_message: string | null;
};

export type EmailSendStatus = {
  status: "sent" | "failed" | "pending";
  recipient: string | null;
  error: string | null;
};

/** One answer from a message's rows, newest first: `sent` anywhere wins, then
 *  a final failure, and anything else is still on its way. */
export function emailStatusFromLog(rows: EmailLogRow[]): EmailSendStatus {
  const recipient = rows[0]?.recipient_email ?? null;
  const sent = rows.find((r) => r.status === "sent");
  if (sent) return { status: "sent", recipient: sent.recipient_email ?? recipient, error: null };
  const final = rows.find((r) => FINAL_EMAIL_FAILURES.has(r.status));
  if (final) return { status: "failed", recipient, error: final.error_message ?? null };
  return { status: "pending", recipient, error: null };
}
