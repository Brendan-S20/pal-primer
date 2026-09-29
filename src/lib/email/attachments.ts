// What a queued email's attachments become in the Resend request.
//
// The queue payload is jsonb written by enqueue.server.ts (today only the
// invoice PDF on "invoice-sent"), read back by /email/queue/process minutes
// later. Anything malformed is dropped rather than forwarded: Resend rejects
// a request with a bad attachment outright, which would turn a broken file
// into an undelivered invoice. Messages queued before attachments existed
// have none, and get none.

export type ResendAttachment = { filename: string; content: string };

/** Resend's cap is 40MB per email; the queue is not the place for anything
 *  near it. An invoice PDF is tens of KB. Above this, send the email bare. */
export const MAX_ATTACHMENT_BASE64_CHARS = 4_000_000;

export function resendAttachments(raw: unknown): ResendAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: ResendAttachment[] = [];
  for (const a of raw) {
    if (!a || typeof a !== "object") continue;
    const { filename, content } = a as { filename?: unknown; content?: unknown };
    if (typeof filename !== "string" || !filename.trim()) continue;
    if (typeof content !== "string" || !content) continue;
    if (content.length > MAX_ATTACHMENT_BASE64_CHARS) continue;
    if (!/^[A-Za-z0-9+/]+=*$/.test(content)) continue;
    out.push({ filename, content });
  }
  return out;
}
