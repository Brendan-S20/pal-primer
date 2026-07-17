// Shared invoice label + description helpers (QA round 3, C6 + I3).
// One place maps the invoice_kind enum to human copy and humanizes the ISO
// dates the generation RPCs bake into line-item descriptions, so no surface
// renders "prepaid_topup" or "Prepaid service on 2026-07-16" to a user.
import { formatDay } from "@/lib/format";

/** Human label for the invoice_kind enum ("postpaid" | "prepaid_topup").
 *  Kills the raw enum chip (C6.2) — used by the invoice drawer, list rows,
 *  and the client portal. Unknown values fall back to sentence case. */
const KIND_LABELS: Record<string, string> = {
  prepaid_topup: "Prepaid top-up",
  postpaid: "Service",
};

export function invoiceKindLabel(kind: string | null | undefined): string {
  if (!kind) return "";
  const known = KIND_LABELS[kind];
  if (known) return known;
  const words = kind.replace(/[_-]/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

/** Line-item descriptions are stored with canonical ISO dates (built inside
 *  the invoice-generation RPCs, e.g. "Prepaid service on 2026-07-16"). Per the
 *  app's "store canonical, render humanized" rule (see format.ts), humanize any
 *  embedded YYYY-MM-DD at render time to "Thu, Jul 16" (C6.1). Handles every
 *  description shape (prepaid, service, skipped, add-on) and legacy rows. */
export function formatLineItemDescription(desc: string | null | undefined): string {
  if (!desc) return "";
  // Digit boundaries (?<!\d) / (?!\d) so a date embedded in a longer number
  // (an id like "Order 12026-07-16") isn't partially matched and mangled.
  return desc.replace(/(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g, (m) => formatDay(m) || m);
}
