// Money collected outside Stripe: cash at the door, a check, a transfer, an
// app payment. What the office types in, and how it becomes a payments row.
//
// Shared by the server function that writes the row and the dialog that
// collects it, so the list of methods and the rules about the date cannot
// disagree between the two. The same list is the CHECK constraint in
// supabase/migrations/20260928030000_a-cash-payment-could-not-say-how-it-was-paid.sql.

import { daysBetweenOrgDays, orgToday } from "@/lib/org-day";
import { zonedTimeToUtc } from "@/lib/route-window";

export const MANUAL_PAYMENT_METHODS = [
  "cash",
  "check",
  "bank_transfer",
  "venmo",
  "zelle",
  "other",
] as const;

export type ManualPaymentMethod = (typeof MANUAL_PAYMENT_METHODS)[number];

export const MANUAL_PAYMENT_LABELS: Record<ManualPaymentMethod, string> = {
  cash: "Cash",
  check: "Check",
  bank_transfer: "Bank transfer",
  venmo: "Venmo",
  zelle: "Zelle",
  other: "Other",
};

/** What the reference field is called for each method. Cash has none. */
export const REFERENCE_LABELS: Record<ManualPaymentMethod, string | null> = {
  cash: null,
  check: "Check number",
  bank_transfer: "Transfer reference",
  venmo: "Venmo reference",
  zelle: "Zelle reference",
  other: "Reference",
};

export const REFERENCE_MAX = 120;

/** How far back a payment may be dated. A year covers a shoebox of checks
 *  found at tax time; anything older is a correction for the accountant, not
 *  a payment to record. */
export const MAX_BACKDATE_DAYS = 365;

/**
 * Why a received-on day cannot be used, or null when it can. Days are the
 * org's calendar days (YYYY-MM-DD) — a payment is received on the business's
 * day, not the device's.
 */
export function receivedOnProblem(day: string, tz: string, now: Date = new Date()): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(new Date(`${day}T12:00:00Z`).getTime())) {
    return "Choose the day the payment arrived.";
  }
  const today = orgToday(tz, now);
  if (day > today) return "A payment can't be received in the future.";
  if (daysBetweenOrgDays(day, today) > MAX_BACKDATE_DAYS) {
    return "That's more than a year ago. Ask your accountant how to record it.";
  }
  return null;
}

/**
 * The instant stored as paid_at. Today is "now", so the payment sorts after
 * anything else recorded today. An earlier day is noon on that day in the
 * org's timezone, which every consumer reads back as that day: the cash-basis
 * report buckets by orgLocalDay(paid_at), and noon is twelve hours from either
 * edge, so no offset or daylight-saving change can move it to a neighbour.
 */
export function receivedAtInstant(day: string, tz: string, now: Date = new Date()): string {
  if (day === orgToday(tz, now)) return now.toISOString();
  return zonedTimeToUtc(day, "12:00", tz).toISOString();
}

/** "Check #1042", "Cash", "Venmo · @dana-f". Null for a payment with no
 *  recorded method (Stripe, or recorded before methods existed). */
export function describeManualPayment(
  method: string | null | undefined,
  reference: string | null | undefined,
): string | null {
  if (!method || !(MANUAL_PAYMENT_METHODS as readonly string[]).includes(method)) return null;
  const label = MANUAL_PAYMENT_LABELS[method as ManualPaymentMethod];
  const ref = reference?.trim();
  if (!ref) return label;
  return method === "check" ? `${label} #${ref.replace(/^#/, "")}` : `${label} · ${ref}`;
}

const usd = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

/** "60", "60.5", "$1,060.00" to cents; null for anything that is not an
 *  amount with at most two decimals. */
export function parsePaymentAmount(raw: string): number | null {
  const s = raw.trim().replace(/^\$/, "").replace(/,/g, "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s) && !/^\.\d{1,2}$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  return Number(whole || "0") * 100 + Number((frac + "00").slice(0, 2));
}

/** Why an amount cannot be recorded against an invoice with `balanceCents`
 *  still owed, or null. Less than the balance is a partial payment and fine;
 *  more is refused, in the same words record_invoice_payment uses. */
export function paymentAmountProblem(cents: number | null, balanceCents: number): string | null {
  if (cents == null || cents <= 0) return "Enter an amount greater than zero.";
  if (cents > balanceCents) {
    return `That is more than the ${usd(balanceCents)} still owed on this invoice.`;
  }
  return null;
}
