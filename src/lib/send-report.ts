// Saying "sent" only once the mail provider has taken the email (#612).
//
// Team invites already did this (#568): the server reports whether the
// provider accepted the message and the page says "did not go out, copy the
// link" when it did not. Setup step 4, the welcome email and every invoice
// send now say the same thing the same way, from here.
//
// Two shapes of answer reach a page. A direct send (the invite) knows at once.
// A queued send (invoice, welcome) knows only that it was queued: the queue
// processor hands it to the provider within a minute and writes the answer to
// email_send_log, so the page polls that before it says "sent".
import { toast } from "sonner";

export type EmailPoll = (args: {
  data: { messageId: string };
}) => Promise<{ status: string; recipient: string | null; error: string | null }>;

export type EmailOutcome = "sent" | "failed" | "pending";

const FAILED = new Set(["failed", "bounced", "dlq", "suppressed", "complained"]);

/** Ask the send log until the provider has answered, or give up and say
 *  "pending". Never throws: a poll that errors is asked again. */
export async function waitForEmailOutcome(
  poll: EmailPoll,
  messageId: string,
  { tries = 20, intervalMs = 3000 }: { tries?: number; intervalMs?: number } = {},
): Promise<{ outcome: EmailOutcome; recipient: string | null; error: string | null }> {
  for (let i = 0; i < tries; i++) {
    await new Promise((res) => setTimeout(res, intervalMs));
    let s: { status: string; recipient: string | null; error: string | null };
    try {
      s = await poll({ data: { messageId } });
    } catch {
      continue;
    }
    if (s.status === "sent") return { outcome: "sent", recipient: s.recipient, error: null };
    if (FAILED.has(s.status)) return { outcome: "failed", recipient: s.recipient, error: s.error };
  }
  return { outcome: "pending", recipient: null, error: null };
}

/** The words for an email that did not go out. Exported so a test can pin
 *  them without rendering a toast. */
export function notSentMessage(what: string, to: string | null | undefined): string {
  return `${what} not sent: the email to ${to || "them"} did not go out. Copy the link and send it yourself.`;
}

export function copyLinkToClipboard(link: string, copied = "Link copied") {
  navigator.clipboard.writeText(link).then(
    () => toast.success(copied),
    () => toast.error(`Couldn't copy. The link is ${link}`),
  );
}

/** The "not sent, copy link" warning. Long enough on screen to act on. */
export function toastNotSent(
  what: string,
  to: string | null | undefined,
  link: string | null | undefined,
  id?: string | number,
) {
  toast.warning(notSentMessage(what, to), {
    id,
    duration: 15000,
    action: link ? { label: "Copy link", onClick: () => copyLinkToClipboard(link) } : undefined,
  });
}

export type QueuedSendResult = {
  ok: boolean;
  messageId?: string | null;
  recipient?: string | null;
  link?: string | null;
  alreadySent?: boolean;
};

/**
 * Report a queued send honestly: "not sent, copy link" when nothing was
 * queued, "Sending…" while it is in the queue, "Sent" only once the provider
 * has taken it. `onSent` runs then, so a page can refetch the row whose
 * sent_at the queue processor has just stamped.
 */
export async function reportQueuedSend(
  r: QueuedSendResult,
  { what, poll, onSent }: { what: string; poll: EmailPoll; onSent?: () => void },
): Promise<EmailOutcome> {
  const to = r.recipient ?? null;
  if (r.alreadySent) {
    toast.success(`${what} was already sent${to ? ` to ${to}` : ""}`);
    onSent?.();
    return "sent";
  }
  if (!r.ok || !r.messageId) {
    toastNotSent(what, to, r.link);
    return "failed";
  }
  const id = toast.loading(`Sending ${what.toLowerCase()} to ${to ?? "the client"}…`);
  const res = await waitForEmailOutcome(poll, r.messageId);
  if (res.outcome === "sent") {
    toast.success(`${what} sent to ${res.recipient ?? to ?? "the client"}`, { id });
    onSent?.();
  } else if (res.outcome === "failed") {
    toastNotSent(what, res.recipient ?? to, r.link, id);
  } else {
    toast.message(
      `${what} is queued for ${to ?? "the client"} but not sent yet. It shows as Sent once the email provider takes it.`,
      { id },
    );
  }
  return res.outcome;
}
