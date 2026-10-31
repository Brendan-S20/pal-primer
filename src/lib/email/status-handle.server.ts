// A handle a page can poll for one queued email's outcome, and nothing else.
//
// The send log has no organization column and only the service role may read
// it (20260701180832_email_infra.sql). The poll used to read it through the
// caller's own client, so RLS answered every poll with zero rows and the
// status was "pending" for ever (#612 review). Reading it with the service
// role on a bare message id would hand any signed-in caller any recipient's
// address.
//
// So the handle names what the email was FOR, an invoice or a client, and is
// signed over that, the organization and the message id. The poll checks the
// signature against the poller's organization AND that the poller can read
// that invoice or client in it, and only then reads the log as the service
// role.
import { createHash, timingSafeEqual } from "node:crypto";
import {
  emailStatusFromLog,
  type EmailLogRow,
  type EmailSendStatus,
} from "@/lib/email/send-status";

export type EmailSubject = { kind: "invoice" | "client"; id: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function handleSecret(): string {
  const s = process.env.SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  // No key, no handle: refuse rather than sign with something guessable.
  if (!s) {
    throw new Error("SERVICE_ROLE_KEY is not set, so an email status handle cannot be signed.");
  }
  return s;
}

function mac(orgId: string, subject: EmailSubject, messageId: string): string {
  return createHash("sha256")
    .update(`${handleSecret()}.email-status.${orgId}.${subject.kind}.${subject.id}.${messageId}`)
    .digest("hex")
    .slice(0, 32);
}

export function signEmailStatusHandle(
  orgId: string,
  subject: EmailSubject,
  messageId: string,
): string {
  return `${subject.kind}.${subject.id}.${messageId}.${mac(orgId, subject, messageId)}`;
}

/** The subject and message id, when the handle was signed for this
 *  organization. The caller still has to show it can read the subject. */
export function verifyEmailStatusHandle(
  orgId: string,
  handle: string,
): { subject: EmailSubject; messageId: string } | null {
  const parts = handle.split(".");
  if (parts.length !== 4) return null;
  const [kind, id, messageId, given] = parts;
  if ((kind !== "invoice" && kind !== "client") || !UUID.test(id) || !messageId) return null;
  const subject: EmailSubject = { kind, id };
  const a = Buffer.from(given);
  const b = Buffer.from(mac(orgId, subject, messageId));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { subject, messageId };
}

/**
 * The poll, with its two reads passed in so the gate can be tested without a
 * database. Refuses a handle not signed for `orgId`, and one naming a subject
 * the caller cannot read; only then reads the log.
 */
export async function emailStatusForHandle(
  orgId: string,
  handle: string,
  deps: {
    ownsSubject: (subject: EmailSubject) => Promise<boolean>;
    readLog: (messageId: string) => Promise<EmailLogRow[]>;
  },
): Promise<EmailSendStatus> {
  const verified = verifyEmailStatusHandle(orgId, handle);
  if (!verified) throw new Error("Not found");
  if (!(await deps.ownsSubject(verified.subject))) throw new Error("Not found");
  return emailStatusFromLog(await deps.readLog(verified.messageId));
}
