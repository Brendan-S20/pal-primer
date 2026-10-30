// What the invoice email says about the invoice itself: its number, when it
// is due, and what it is for (#607). Until this the email carried only an
// amount and a pay button, so a customer with two open invoices could not
// tell them apart, and nobody could see what they were paying for without
// following the link.
//
// Shared by the manual send and the nightly auto-send, so both emails read
// the same.
import { formatDocumentDay } from "@/lib/format";
import { formatLineItemDescription, invoiceNumberLabel } from "@/lib/invoice-labels";

/** More than this and the email lists the first ones and says how many are
 *  left; the invoice behind the pay link has every line. */
export const EMAIL_LINE_LIMIT = 25;

export type InvoiceEmailLine = {
  description: string;
  quantity: number;
  unitAmountCents: number | null;
  amountCents: number;
};

export type InvoiceEmailDetails = {
  /** "INV-1001". */
  invoiceLabel: string;
  /** "Nov 14, 2026", or absent when the invoice has no due date. */
  dueLabel?: string;
  lines: InvoiceEmailLine[];
  /** Lines not listed because of EMAIL_LINE_LIMIT. */
  moreLines?: number;
};

export function invoiceEmailDetails(
  inv: { id: string; number?: number | null; due_on?: string | null },
  rows: Array<{
    description: string | null;
    quantity?: number | string | null;
    unit_amount_cents?: number | null;
    amount_cents: number;
  }>,
): InvoiceEmailDetails {
  const lines = rows.slice(0, EMAIL_LINE_LIMIT).map((r) => ({
    // Stored with ISO dates; a filed document always prints the year.
    description: formatLineItemDescription(r.description, formatDocumentDay),
    quantity: Number(r.quantity ?? 1),
    unitAmountCents: r.unit_amount_cents ?? null,
    amountCents: Number(r.amount_cents),
  }));
  const dueLabel = inv.due_on ? formatDocumentDay(inv.due_on) : "";
  return {
    invoiceLabel: invoiceNumberLabel(inv),
    ...(dueLabel ? { dueLabel } : {}),
    lines,
    ...(rows.length > lines.length ? { moreLines: rows.length - lines.length } : {}),
  };
}
