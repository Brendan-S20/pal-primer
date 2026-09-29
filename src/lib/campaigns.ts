// Email campaigns: the rules, with no I/O, so every one of them is testable
// on its own. The table is email_campaigns (migration
// 20260929070000_nobody-could-send-a-seasonal-offer.sql), the sending is
// campaigns.server.ts, the page is routes/_authenticated/campaigns.*.
//
// A campaign is one email the owner writes once and sends to a set of their
// clients: "Spring deep clean, $20 off", "we now cover Oak Park", "no visits
// on the 25th". Three things make that different from every other email this
// product sends, and each is a rule below:
//
//   WHO it may go to     only a client who has not opted out, is not on an
//                        imported comms hold, and has an address, and never
//                        twice to one address.
//   WHAT it may say      plain text, a heading and at most one https button.
//                        No HTML from the office reaches the email: the body is
//                        split into paragraphs here and React escapes every
//                        character of them in the template.
//   WHETHER it may go    CAN-SPAM wants the sender's postal address in every
//                        commercial email and an unsubscribe that works. No
//                        address, no send.
import { z } from "zod";

/** The most recipients one campaign may have. A one-or-two-truck business has
 *  hundreds of clients, not thousands; a list longer than this is far more
 *  likely an import gone wrong than a customer base, and at the lane's pace of
 *  one batch a minute it is already most of a working day. Mirrored by the
 *  CHECK on email_campaigns.recipient_count and by start_email_campaign. */
export const CAMPAIGN_MAX_RECIPIENTS = 5000;

export const CAMPAIGN_LIMITS = {
  subject: 150,
  heading: 150,
  body: 5000,
  buttonLabel: 40,
  buttonUrl: 500,
  tag: 40,
} as const;

// ── Audience ────────────────────────────────────────────────────────────────

export type CampaignAudience =
  { kind: "active" } | { kind: "tagged"; tag: string } | { kind: "inactive" };

export type CampaignAudienceKind = CampaignAudience["kind"];

export const AUDIENCE_LABELS: Record<CampaignAudienceKind, string> = {
  active: "All active clients",
  tagged: "Clients with a tag",
  inactive: "Inactive and former clients",
};

/**
 * Why "Leads not converted" is shown, disabled, and not offered.
 *
 * A lead would need three things a client has and a lead does not:
 *
 *   1. PROOF THE ADDRESS WAS GIVEN. The public form (/api/public/leads) takes
 *      any email from anyone, with no confirmation step and CORS open to every
 *      site, and its `source` field is whatever the caller posts. "Submitted
 *      the form" and "somebody typed this person's address into the form" are
 *      the same row.
 *   2. SOMEWHERE FOR AN UNSUBSCRIBE TO LAND. leads has no opt-out column. For
 *      a recipient with no client row, enqueueAppEmail checks only the
 *      suppression list, which is platform-wide: unsubscribing from one
 *      business's promotion would stop every business's invoices to them.
 *   3. AN UNSUBSCRIBE THAT SURVIVES CONVERSION. Nothing in lead conversion
 *      would carry an opt-out across to the client it creates, so the person
 *      who clicked "unsubscribe" as a lead would be mailed again as a client.
 *
 * Any one of those is a way to email somebody who said no. All three need
 * building before leads are an audience.
 */
export const LEADS_ARE_NOT_AN_AUDIENCE_YET =
  "Not yet. Lead addresses are not confirmed and leads have nowhere to record an unsubscribe, so they are left out until both exist.";

export function audienceLabel(a: CampaignAudience): string {
  return a.kind === "tagged" ? `Clients tagged "${a.tag}"` : AUDIENCE_LABELS[a.kind];
}

export const audienceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("active") }),
  z.object({ kind: z.literal("tagged"), tag: z.string().trim().min(1).max(CAMPAIGN_LIMITS.tag) }),
  z.object({ kind: z.literal("inactive") }),
]);

/** The columns the audience is decided on. */
export type AudienceClient = {
  id: string;
  display_name: string;
  primary_email: string | null;
  active: boolean;
  tags: string[] | null;
  email_opt_out: boolean;
  comms_paused: boolean;
};

export type AudienceRecipient = { clientId: string; email: string; name: string };

export type AudienceResult = {
  /** Who it will go to. */
  recipients: AudienceRecipient[];
  /** Clients the audience matched before anyone was left out. */
  matched: number;
  /** Left out, by reason. A client is counted under the FIRST that applies,
   *  so the four add up to matched - recipients. */
  excluded: { optedOut: number; commsPaused: number; noEmail: number; duplicate: number };
  overCap: boolean;
};

export function normalizeEmail(raw: string | null | undefined): string | null {
  const e = (raw ?? "").trim().toLowerCase();
  // Deliberately loose: the question is "is there an address to send to",
  // not "is this RFC 5322". A malformed one is the mail provider's to refuse.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

export function matchesAudience(c: AudienceClient, a: CampaignAudience): boolean {
  switch (a.kind) {
    case "active":
      return c.active;
    case "inactive":
      return !c.active;
    case "tagged": {
      // Case-insensitive, like the tag filter and bulk tagging on /clients:
      // "VIP" and "vip" are one tag to the person who typed them.
      const want = a.tag.trim().toLowerCase();
      return (c.tags ?? []).some((t) => t.trim().toLowerCase() === want);
    }
  }
}

/**
 * Who a campaign goes to.
 *
 * `clients` must be EVERY client in the organization, not only those the
 * audience matches, because an opt-out belongs to an address as much as to a
 * row. Two clients sharing one inbox (a couple with a house each, a landlord)
 * are one person to CAN-SPAM. If either has unsubscribed, neither is mailed:
 * otherwise the unsubscribe on the first row is answered by an email to the
 * second.
 */
export function selectAudience(
  clients: AudienceClient[],
  audience: CampaignAudience,
): AudienceResult {
  const optedOutAddresses = new Set<string>();
  for (const c of clients) {
    const e = normalizeEmail(c.primary_email);
    if (e && c.email_opt_out) optedOutAddresses.add(e);
  }

  const matched = clients
    .filter((c) => matchesAudience(c, audience))
    // Stable, so the same list always keeps the same row for a shared address.
    .sort((a, b) => a.display_name.localeCompare(b.display_name) || a.id.localeCompare(b.id));

  const excluded = { optedOut: 0, commsPaused: 0, noEmail: 0, duplicate: 0 };
  const seen = new Set<string>();
  const recipients: AudienceRecipient[] = [];
  for (const c of matched) {
    const email = normalizeEmail(c.primary_email);
    if (c.email_opt_out || (email && optedOutAddresses.has(email))) {
      excluded.optedOut++;
    } else if (c.comms_paused) {
      // The imported hold: an import brought this client in and the business
      // has not contacted them yet. A campaign is not manual, so it waits.
      excluded.commsPaused++;
    } else if (!email) {
      excluded.noEmail++;
    } else if (seen.has(email)) {
      excluded.duplicate++;
    } else {
      seen.add(email);
      recipients.push({ clientId: c.id, email, name: c.display_name });
    }
  }
  return {
    recipients,
    matched: matched.length,
    excluded,
    overCap: recipients.length > CAMPAIGN_MAX_RECIPIENTS,
  };
}

/** Every tag in use, with how many clients carry it, for the audience picker.
 *  Grouped case-insensitively under the most common spelling. */
export function tagsInUse(
  clients: Pick<AudienceClient, "tags">[],
): { tag: string; count: number }[] {
  const byKey = new Map<string, { spellings: Map<string, number>; count: number }>();
  for (const c of clients) {
    const seenHere = new Set<string>();
    for (const raw of c.tags ?? []) {
      const t = raw.trim();
      const k = t.toLowerCase();
      if (!t || seenHere.has(k)) continue;
      seenHere.add(k);
      const entry = byKey.get(k) ?? { spellings: new Map(), count: 0 };
      entry.count++;
      entry.spellings.set(t, (entry.spellings.get(t) ?? 0) + 1);
      byKey.set(k, entry);
    }
  }
  return [...byKey.values()]
    .map((e) => ({
      tag: [...e.spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0],
      count: e.count,
    }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

// ── Content ─────────────────────────────────────────────────────────────────

/** https, a host with a dot in it, no credentials, no spaces. The button is
 *  the one link in the email the office chooses, so it is held to the
 *  standard a customer would assume of it. Mirrored by
 *  email_campaigns_button_check. */
export function isSafeButtonUrl(raw: string | null | undefined): boolean {
  const s = (raw ?? "").trim();
  if (!s || s.length > CAMPAIGN_LIMITS.buttonUrl || /\s/.test(s)) return false;
  if (!/^https:\/\/[^\s/@]+\.[^\s/@]+(\/\S*)?$/.test(s)) return false;
  try {
    const u = new URL(s);
    return u.protocol === "https:" && !u.username && !u.password && u.hostname.includes(".");
  } catch {
    return false;
  }
}

export const campaignContentSchema = z
  .object({
    subject: z
      .string()
      .trim()
      .max(CAMPAIGN_LIMITS.subject)
      // A subject is a header. A line break in a header is an injection.
      .refine((s) => !/[\r\n]/.test(s), "The subject must be one line."),
    heading: z.string().trim().max(CAMPAIGN_LIMITS.heading),
    body: z.string().max(CAMPAIGN_LIMITS.body),
    buttonLabel: z.string().trim().max(CAMPAIGN_LIMITS.buttonLabel).nullable(),
    buttonUrl: z.string().trim().max(CAMPAIGN_LIMITS.buttonUrl).nullable(),
  })
  .superRefine((v, ctx) => {
    const label = v.buttonLabel?.trim() || null;
    const url = v.buttonUrl?.trim() || null;
    if (label && !url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["buttonUrl"],
        message: "Add the link the button opens, or clear its label.",
      });
    }
    if (url && !label) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["buttonLabel"],
        message: "Give the button a label, or clear its link.",
      });
    }
    if (url && !isSafeButtonUrl(url)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["buttonUrl"],
        message:
          "The button link must be a full https:// address, like https://example.com/spring.",
      });
    }
  });

export type CampaignContent = z.infer<typeof campaignContentSchema>;

/** Blank label and URL are "no button", stored as NULL, as the CHECK wants. */
export function normalizeContent(c: CampaignContent): CampaignContent {
  const label = c.buttonLabel?.trim() || null;
  const url = c.buttonUrl?.trim() || null;
  return {
    subject: c.subject.trim(),
    heading: c.heading.trim(),
    body: c.body.replace(/\r\n?/g, "\n").trim(),
    buttonLabel: label && url ? label : null,
    buttonUrl: label && url ? url : null,
  };
}

/**
 * The body as paragraphs of lines. A blank line starts a new paragraph; a
 * single line break stays a line break inside one.
 *
 * This is the whole of the formatting a campaign has, and it is the reason
 * there is no HTML injection to defend against: the office's text is only ever
 * SPLIT, never interpreted, and the template renders each line as a React text
 * child, which escapes `<`, `>`, `&` and quotes. Nothing here or there ever
 * uses dangerouslySetInnerHTML.
 */
export function bodyParagraphs(body: string): string[][] {
  return body
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((p) =>
      p
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0),
    )
    .filter((lines) => lines.length > 0);
}

// ── Whether it may go ───────────────────────────────────────────────────────

export type SendBlocker =
  "no_address" | "no_subject" | "no_body" | "invalid_content" | "no_recipients" | "too_many";

export const SEND_BLOCKER_TEXT: Record<SendBlocker, string> = {
  no_address:
    "Add your business address before sending. The law on marketing email (CAN-SPAM) requires a postal address in every one, and it is printed at the foot of the email.",
  no_subject: "Write a subject line.",
  no_body: "Write the message.",
  invalid_content: "Fix the highlighted fields.",
  no_recipients: "Nobody in this audience can be emailed.",
  too_many: `A campaign can go to at most ${CAMPAIGN_MAX_RECIPIENTS.toLocaleString("en-US")} clients. Narrow the audience with a tag.`,
};

/** Everything that stops Send, in the order the page shows it. Empty means
 *  it may go. The server asks the same question, and start_email_campaign
 *  asks the address and the count a third time under a lock. */
export function sendBlockers(input: {
  contactAddress: string | null | undefined;
  content: CampaignContent;
  recipientCount: number;
}): SendBlocker[] {
  const out: SendBlocker[] = [];
  if (!(input.contactAddress ?? "").trim()) out.push("no_address");
  const parsed = campaignContentSchema.safeParse(input.content);
  if (!parsed.success) out.push("invalid_content");
  if (!input.content.subject.trim()) out.push("no_subject");
  if (bodyParagraphs(input.content.body).length === 0) out.push("no_body");
  if (input.recipientCount === 0) out.push("no_recipients");
  if (input.recipientCount > CAMPAIGN_MAX_RECIPIENTS) out.push("too_many");
  return out;
}

/** The key that makes a retry, a re-claim or a double press the same email.
 *  Sent to Resend as Idempotency-Key, which dedupes for 24 hours; the UNIQUE
 *  (campaign_id, client_id) on the recipients table is the guard in front of
 *  it. */
export function campaignIdempotencyKey(campaignId: string, clientId: string): string {
  return `campaign-${campaignId}-${clientId}`;
}

/** What the start function's answer means to the person who pressed Send. */
export function startOutcomeText(outcome: string): string {
  switch (outcome) {
    case "started":
      return "Sending.";
    case "already_started":
      return "This campaign was already sent. Nothing was sent twice.";
    case "no_address":
      return SEND_BLOCKER_TEXT.no_address;
    case "no_recipients":
      return SEND_BLOCKER_TEXT.no_recipients;
    case "too_many":
      return SEND_BLOCKER_TEXT.too_many;
    case "not_found":
      return "Campaign not found.";
    default:
      return "The campaign could not be sent.";
  }
}

/** Why a recipient was not queued, in words. Keys are enqueueAppEmail's. */
export const SKIP_REASON_TEXT: Record<string, string> = {
  client_opted_out: "Unsubscribed",
  address_opted_out: "Unsubscribed",
  comms_paused: "On an imported hold",
  suppressed: "Address bounced or unsubscribed",
  no_recipient: "No email address",
  render_failed: "Could not be built",
  enqueue_failed: "Could not be queued",
  unknown_template: "Could not be built",
  org_toggle_off: "Could not be queued",
};
