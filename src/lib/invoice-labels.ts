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
export function formatLineItemDescription(
  desc: string | null | undefined,
  /** How each embedded day is written. The screen's `formatDay` drops the
   *  year in the current one; the PDF passes `formatDocumentDay`, which never
   *  does, because a filed document is read in a later year. */
  formatEmbeddedDay: (day: string) => string = formatDay,
): string {
  if (!desc) return "";
  // Digit boundaries (?<!\d) / (?!\d) so a date embedded in a longer number
  // (an id like "Order 12026-07-16") isn't partially matched and mangled.
  return desc.replace(/(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g, (m) => formatEmbeddedDay(m) || m);
}

/**
 * What an invoice is called wherever a person reads it: "INV-1042". The
 * number is per organization and assigned on insert (see migration
 * 20260928120000). Until then every screen, email and activity entry printed
 * the first eight characters of the UUID, which nobody could read out on a
 * phone call or match to a deposit. The fragment stays only as a fallback for
 * a row read without its number.
 */
export function invoiceNumberLabel(inv: { number?: number | null; id: string }): string {
  return inv.number != null ? `INV-${inv.number}` : `#${inv.id.slice(0, 8)}`;
}

/** The same label for text written on the server (activity timeline,
 *  notifications), read with whichever client the caller holds. */
export async function invoiceRef(
  supabase: { from: (table: string) => any },
  invoiceId: string,
): Promise<string> {
  const { data } = await supabase
    .from("invoices")
    .select("number")
    .eq("id", invoiceId)
    .maybeSingle();
  return invoiceNumberLabel({ id: invoiceId, number: data?.number ?? null });
}
