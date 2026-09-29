// Quotes: the pure half. Labels, line arithmetic, totals, expiry and the
// words a customer reads when their answer is refused. No I/O, so every rule
// here is tested without a browser or a database.
//
// The database is the authority on two of these and this file must agree with
// it, not improvise:
//
//   * a line total is round(quantity * unit_amount_cents), and Postgres
//     rounds numeric half AWAY from zero. JavaScript's Math.round rounds half
//     UP, and `1.15 * 100` is 114.99999999999999, so the obvious one-liner
//     disagrees with the CHECK constraint on ordinary input. Done in integer
//     hundredths instead.
//   * a sent quote past its valid_until reads as expired on the ORGANIZATION's
//     calendar (public_quote_document), so the staff list and the customer's
//     page say the same word on the same evening.
//
// See supabase/migrations/20260928170000_a-bid-had-nothing-to-accept.sql.

import { addDaysToDay } from "@/lib/reclean";
import { EMPTY_PREFILL, isSyntheticLeadEmail, type WizardPrefill } from "@/lib/lead-conversion";

export const QUOTE_STATUSES = ["draft", "sent", "accepted", "declined", "expired"] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

/** How long a new quote is good for, in days on the org's calendar. */
export const QUOTE_DEFAULT_VALID_DAYS = 30;

/** The limits the database enforces, so the editor can say so first. */
export const QUOTE_LIMITS = {
  title: 200,
  message: 4000,
  description: 300,
  maxQuantity: 10_000,
  maxUnitCents: 10_000_000,
  maxLines: 40,
  signatureMin: 2,
  signatureMax: 120,
  declineReason: 1000,
} as const;

/** "Q-1001". The number a customer reads aloud on the phone. */
export function quoteNumberLabel(number: number | null | undefined): string {
  return number == null ? "Quote" : `Q-${number}`;
}

export function quoteStatusLabel(status: string): string {
  switch (status) {
    case "draft":
      return "Draft";
    case "sent":
      return "Sent";
    case "accepted":
      return "Accepted";
    case "declined":
      return "Declined";
    case "expired":
      return "Expired";
    default:
      return status;
  }
}

/** How a recurring line is priced, in the words the customer reads. */
export const RECURRING_LABEL = "per visit";

// ── Line arithmetic ────────────────────────────────────────────────────────

/** A quantity as the database stores it: numeric(10,2), positive. */
export function parseQuantity(raw: string | number): number | null {
  const s = String(raw).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s) && !/^\.\d{1,2}$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0 || n > QUOTE_LIMITS.maxQuantity) return null;
  return n;
}

/** A price typed as dollars ("24", "24.5", "$1,200.00") in whole cents. */
export function parseMoneyToCents(raw: string): number | null {
  const s = raw.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s) && !/^\.\d{1,2}$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const cents = Number(whole || "0") * 100 + Number((frac + "00").slice(0, 2));
  if (!Number.isSafeInteger(cents) || cents > QUOTE_LIMITS.maxUnitCents) return null;
  return cents;
}

/**
 * quantity x unit price, rounded the way Postgres rounds numeric: half away
 * from zero. Integer arithmetic throughout, on the quantity in hundredths,
 * because that is exactly what numeric(10,2) holds.
 */
export function lineAmountCents(quantity: number, unitAmountCents: number): number {
  const hundredths = Math.round(quantity * 100);
  const product = hundredths * Math.trunc(unitAmountCents);
  const sign = product < 0 ? -1 : 1;
  return sign * Math.floor((Math.abs(product) + 50) / 100);
}

export type QuoteLine = {
  description: string;
  quantity: number;
  unit_amount_cents: number;
  amount_cents: number;
  recurring: boolean;
};

export type QuoteTotals = {
  /** Everything billed once, together. */
  oneTimeCents: number;
  /** Everything billed on every visit, together: the price per visit. */
  recurringCents: number;
  oneTimeCount: number;
  recurringCount: number;
};

export function quoteTotals(
  lines: ReadonlyArray<Pick<QuoteLine, "amount_cents" | "recurring">>,
): QuoteTotals {
  let oneTimeCents = 0;
  let recurringCents = 0;
  let oneTimeCount = 0;
  let recurringCount = 0;
  for (const l of lines) {
    if (l.recurring) {
      recurringCents += l.amount_cents;
      recurringCount++;
    } else {
      oneTimeCents += l.amount_cents;
      oneTimeCount++;
    }
  }
  return { oneTimeCents, recurringCents, oneTimeCount, recurringCount };
}

/** A quantity for display: "1", "1.5", "2.25", never "1.00". */
export function formatQuantity(q: number | string): string {
  const n = typeof q === "string" ? Number(q) : q;
  if (!Number.isFinite(n)) return String(q);
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

export function formatQuoteMoney(cents: number, currency = "usd"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format((cents ?? 0) / 100);
}

// ── Status on the org's calendar ───────────────────────────────────────────

/**
 * What a quote IS today. A sent quote whose valid_until has passed on the
 * org's calendar is expired even though the row still says sent: nothing runs
 * at midnight to flip it, and nothing needs to.
 */
export function effectiveQuoteStatus(
  status: string,
  validUntil: string | null | undefined,
  orgToday: string,
): QuoteStatus {
  if (status === "sent" && validUntil && validUntil < orgToday) return "expired";
  return (QUOTE_STATUSES as readonly string[]).includes(status) ? (status as QuoteStatus) : "draft";
}

/** A calendar day as a customer reads it: "October 28, 2026". The day is a
 *  date on the org's calendar already, so it is formatted in UTC, where a
 *  bare YYYY-MM-DD lives, and cannot slip a day in any browser's zone. */
export function formatQuoteDay(day: string | null | undefined): string {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return "";
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** A new quote's valid-until: thirty days on from the org's today. */
export function defaultQuoteValidUntil(orgToday: string): string {
  return addDaysToDay(orgToday, QUOTE_DEFAULT_VALID_DAYS);
}

/** The typed full name that is the acceptance signature, as it is stored. */
export function normalizeSignature(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

export function isUsableSignature(raw: string): boolean {
  const s = normalizeSignature(raw);
  return s.length >= QUOTE_LIMITS.signatureMin && s.length <= QUOTE_LIMITS.signatureMax;
}

/**
 * The refusal codes public_quote_respond raises, in words for the customer.
 * Unknown text becomes a generic line rather than a Postgres message: this
 * page is read by somebody who has never heard of the product.
 */
export function quoteRespondErrorMessage(raw: string | null | undefined): string {
  const code = (raw ?? "").trim();
  if (/quote_expired/.test(code))
    return "This quote has expired. Please contact the business for an updated quote.";
  if (/quote_already_accepted/.test(code)) return "This quote has already been accepted.";
  if (/quote_already_declined/.test(code))
    return "This quote was declined. Please contact the business if you would like a new one.";
  if (/signature_required/.test(code)) return "Type your full name to accept.";
  if (/quote_not_found/.test(code)) return "This quote link isn't valid.";
  return "Something went wrong. Please try again, or contact the business.";
}

/**
 * What the office is told after pressing Send. The quote is marked sent in
 * every case (the link works from that moment), so each branch says what
 * happened to the EMAIL and, when it did not go, what to do instead. The one
 * thing it must never do is say "emailed" about an email that was not queued.
 */
export function sendResultMessage(r: {
  emailed: boolean;
  reason: string | null;
  recipient: string | null;
}): { ok: boolean; text: string } {
  if (r.emailed) return { ok: true, text: `Quote emailed to ${r.recipient ?? "the customer"}.` };
  const copy = "Copy the link to share it yourself.";
  switch (r.reason) {
    case "no_email":
    case "no_recipient":
      return { ok: false, text: `Quote marked sent. There is no email address on it. ${copy}` };
    case "org_toggle_off":
      return {
        ok: false,
        text: `Quote marked sent. Quote emails are switched off in Settings, Emails. ${copy}`,
      };
    case "client_opted_out":
      return { ok: false, text: `Quote marked sent. This client has opted out of email. ${copy}` };
    case "suppressed":
      return {
        ok: false,
        text: `Quote marked sent. That address unsubscribed or bounced before. ${copy}`,
      };
    default:
      return { ok: false, text: `Quote marked sent, but the email could not be queued. ${copy}` };
  }
}

// ── Recipients ─────────────────────────────────────────────────────────────

/** Who a quote is addressed to, whether a client or a prospect. */
export function quoteRecipientName(q: {
  client_display_name?: string | null;
  prospect_name?: string | null;
}): string {
  return q.client_display_name?.trim() || q.prospect_name?.trim() || "No recipient";
}

// ── Turning an accepted quote into work ────────────────────────────────────

export type QuoteConversion = {
  /** The per-visit price the service starts at: every recurring line, summed.
   *  null when the quote has no recurring line, so the service form asks. */
  priceCents: number | null;
  /** Charged once. Not billed by starting a service, and said so. */
  oneTimeCents: number;
};

export function quoteConversion(
  lines: ReadonlyArray<Pick<QuoteLine, "amount_cents" | "recurring">>,
): QuoteConversion {
  const t = quoteTotals(lines);
  return {
    priceCents: t.recurringCount > 0 ? t.recurringCents : null,
    oneTimeCents: t.oneTimeCents,
  };
}

/**
 * What the new-client wizard starts as for a prospect's accepted quote that
 * did not come from a lead (one that did starts from the lead, which knows
 * the address and the dogs). The prospect's contact details, and an office
 * note saying where the client came from and what was agreed.
 */
export function quoteToWizardPrefill(q: {
  label: string;
  title: string | null;
  prospectName: string | null;
  prospectEmail: string | null;
  prospectPhone: string | null;
  acceptedName: string | null;
  acceptedAt: string | null;
}): WizardPrefill {
  const email = q.prospectEmail?.trim().toLowerCase() ?? "";
  const facts = [
    `From quote ${q.label}${q.title ? `: ${q.title}` : ""}`,
    q.acceptedName
      ? `Accepted by ${q.acceptedName}${q.acceptedAt ? ` on ${q.acceptedAt.slice(0, 10)}` : ""}`
      : "",
  ].filter(Boolean);
  return {
    ...EMPTY_PREFILL,
    dogs: EMPTY_PREFILL.dogs.map((d) => ({ ...d })),
    displayName: q.prospectName?.trim() ?? "",
    primaryEmail: isSyntheticLeadEmail(email) ? "" : email,
    primaryPhone: q.prospectPhone?.trim() ?? "",
    officeNote: facts.join("\n"),
  };
}

/** Where "Convert to work" goes. An accepted quote for a client opens that
 *  client's new-service form; a prospect's opens the new-client wizard (from
 *  the lead as well, when the quote came from one). Anything else has nowhere
 *  to go. */
export type ConvertTarget =
  | { kind: "client"; clientId: string }
  | { kind: "prospect"; leadId: string | null }
  | { kind: "not-ready"; reason: string };

export function convertTarget(q: {
  status: string;
  client_id: string | null;
  lead_id: string | null;
  converted_at: string | null;
}): ConvertTarget {
  if (q.status !== "accepted")
    return { kind: "not-ready", reason: "Only an accepted quote can be turned into work." };
  if (q.converted_at)
    return { kind: "not-ready", reason: "This quote has already been turned into work." };
  if (q.client_id) return { kind: "client", clientId: q.client_id };
  return { kind: "prospect", leadId: q.lead_id };
}
