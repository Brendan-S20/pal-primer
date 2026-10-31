// The idempotency key every first invoice email is queued under, and the way
// back from it to the invoice.
//
// sent_at is taken when the mail provider ACCEPTS the email, not when it is
// queued (#612). The queue processor is the only code that sees that answer,
// and the key is what it has to go on: the payload carries it to Resend as
// the Idempotency-Key, so it is on every message already and needs no column.

const PREFIX = "invoice-sent-";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function invoiceSendKey(invoiceId: string): string {
  return `${PREFIX}${invoiceId}`;
}

/** The invoice a first-send key names, or null for any other key (a
 *  reminder, a welcome email, a campaign). */
export function invoiceIdFromSendKey(key: unknown): string | null {
  if (typeof key !== "string" || !key.startsWith(PREFIX)) return null;
  const id = key.slice(PREFIX.length);
  return UUID.test(id) ? id : null;
}
