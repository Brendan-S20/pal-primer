// Sales tax: the TypeScript half of the one rule.
//
// The SQL half is `public.set_invoice_totals` and `public.sales_tax_cents` /
// `public.sales_tax_share_cents` (migration 20260929110000). This file mirrors
// them exactly, so the hand-made invoice (insertManualInvoice, which a quote's
// one-time charges also go through) taxes the same way the billing run does,
// and so every surface that needs "how much of this payment was tax" asks one
// function.
//
// ── THE RULE ───────────────────────────────────────────────────────────────
//
//   * The rate is the organization's `sales_tax_rate_bps` (basis points,
//     0..2500), or 0 for a client marked `tax_exempt`. It DEFAULTS TO 0: most
//     pet-waste services are not taxable, and a business that never sets a
//     rate sees nothing change anywhere.
//   * It is snapshotted onto the invoice (`invoices.tax_rate_bps`) when the
//     invoice is made. A later change to the setting never re-prices an
//     invoice already issued.
//   * Tax is charged on the WHOLE invoice subtotal, rounded ONCE, half away
//     from zero, to the cent. Not per line: per-line rounding can differ from
//     the invoice figure by a cent per line, and a customer adding up their
//     bill should get the number printed on it.
//   * Account credit applied to an invoice reduces what is owed, not the
//     taxable base.
//
// ── TAX IS A LIABILITY, NOT REVENUE ────────────────────────────────────────
//
// A payment's tax share sits INSIDE `payments.amount_cents` (which is money
// applied to the invoice, and the invoice total includes the tax) and is
// identified pro rata: amount x invoice tax / invoice total. The database
// fills `payments.tax_cents` with exactly `taxShareCents` below on every
// write, so revenue is `amount_cents - tax_cents` everywhere it is summed.

/** Highest rate the settings accept: 25%. No US combined rate comes close;
 *  the ceiling exists to catch a typo (825 entered as 8250), not to model law. */
export const SALES_TAX_MAX_BPS = 2500;

export const DEFAULT_SALES_TAX_LABEL = "Sales tax";

/** Integer cents, half away from zero. `Math.round` is half-UP (toward +inf),
 *  which differs for negatives; spelled out so the TS and Postgres `round`
 *  agree on every input. */
export function roundHalfAwayFromZero(x: number): number {
  if (!Number.isFinite(x)) return 0;
  const r = Math.sign(x) * Math.round(Math.abs(x));
  return r === 0 ? 0 : r; // no -0
}

/** Tax on a taxable base at a rate in basis points. Mirrors
 *  `public.sales_tax_cents`: zero for a zero or negative base or rate. */
export function salesTaxCents(taxableCents: number, rateBps: number): number {
  const base = Number.isFinite(taxableCents) ? Math.floor(taxableCents) : 0;
  const rate = Number.isFinite(rateBps) ? Math.floor(rateBps) : 0;
  if (rate <= 0 || base <= 0) return 0;
  return roundHalfAwayFromZero((base * rate) / 10_000);
}

/** The rate that applies to a client: the org's, or 0 when exempt. */
export function effectiveTaxRateBps(orgRateBps: number | null | undefined, taxExempt: boolean | null | undefined): number {
  if (taxExempt) return 0;
  const r = Number(orgRateBps ?? 0);
  if (!Number.isFinite(r) || r <= 0) return 0;
  return Math.min(Math.floor(r), SALES_TAX_MAX_BPS);
}

export type InvoiceTotals = {
  subtotalCents: number;
  taxRateBps: number;
  taxCents: number;
  /** The snapshotted label, or null when there is no tax to label. */
  taxLabel: string | null;
  totalCents: number;
};

/** An invoice's totals from its subtotal. Mirrors `public.set_invoice_totals`. */
export function invoiceTotals(
  subtotalCents: number,
  rateBps: number,
  label: string | null | undefined = DEFAULT_SALES_TAX_LABEL,
): InvoiceTotals {
  const subtotal = Number.isFinite(subtotalCents) ? Math.floor(subtotalCents) : 0;
  const rate = Math.max(0, Math.floor(Number.isFinite(rateBps) ? rateBps : 0));
  const tax = salesTaxCents(Math.max(subtotal, 0), rate);
  return {
    subtotalCents: subtotal,
    taxRateBps: rate,
    taxCents: tax,
    taxLabel: tax > 0 ? (label?.trim() || DEFAULT_SALES_TAX_LABEL) : null,
    totalCents: subtotal + tax,
  };
}

/** How much of a payment of `amountCents` against an invoice is that
 *  invoice's tax: pro rata by tax / total, capped at the tax. Mirrors
 *  `public.sales_tax_share_cents`, which fills `payments.tax_cents`. */
export function taxShareCents(
  amountCents: number,
  invoiceTaxCents: number | null | undefined,
  invoiceTotalCents: number | null | undefined,
): number {
  const amount = Number.isFinite(amountCents) ? Math.floor(amountCents) : 0;
  const tax = Math.floor(Number(invoiceTaxCents ?? 0));
  const total = Math.floor(Number(invoiceTotalCents ?? 0));
  if (!(tax > 0) || !(total > 0) || amount <= 0) return 0;
  return Math.min(roundHalfAwayFromZero((amount * tax) / total), tax);
}

/** The part of a payment against an invoice that is NOT tax. What the
 *  platform fee is taken on, what a card surcharge is computed on, and what
 *  counts as revenue. Equal to `amountCents` whenever the invoice has no tax. */
export function preTaxShareCents(
  amountCents: number,
  invoice: { tax_cents?: number | null; total_cents?: number | null } | null | undefined,
): number {
  const amount = Number.isFinite(amountCents) ? Math.floor(amountCents) : 0;
  return amount - taxShareCents(amount, invoice?.tax_cents, invoice?.total_cents);
}

/** "8.25%" from 825. Trailing zeros dropped: 800 → "8%", 850 → "8.5%". */
export function formatTaxRate(rateBps: number): string {
  const pct = Math.max(0, Math.floor(rateBps)) / 100;
  return `${Number(pct.toFixed(2))}%`;
}

/** The label a tax line is drawn with: "Sales tax (8.25%)". */
export function taxLineLabel(label: string | null | undefined, rateBps: number | null | undefined): string {
  const name = label?.trim() || DEFAULT_SALES_TAX_LABEL;
  const rate = Number(rateBps ?? 0);
  return rate > 0 ? `${name} (${formatTaxRate(rate)})` : name;
}

/** Whether an invoice shows a tax line at all. False for every invoice made
 *  at a zero rate, which is every invoice of every business that never set
 *  one — so nothing changes on screen for them. */
export function showsTaxLine(inv: { tax_cents?: number | null } | null | undefined): boolean {
  return Number(inv?.tax_cents ?? 0) > 0;
}

/** What the invoice email adds for a taxed invoice, or nothing at all for an
 *  untaxed one, so the email's data (and its rendering) is unchanged for
 *  every business that never set a rate. */
export function invoiceEmailTaxData(inv: {
  subtotal_cents?: number | null;
  tax_cents?: number | null;
  tax_rate_bps?: number | null;
  tax_label?: string | null;
}): { subtotalCents?: number; taxCents?: number; taxLabel?: string } {
  const tax = Number(inv.tax_cents ?? 0);
  if (!(tax > 0)) return {};
  return {
    ...(inv.subtotal_cents != null ? { subtotalCents: Number(inv.subtotal_cents) } : {}),
    taxCents: tax,
    taxLabel: taxLineLabel(inv.tax_label, inv.tax_rate_bps),
  };
}

/** "8.25" typed into the settings box, to basis points. Refuses a third
 *  decimal and anything outside 0..25 rather than rounding a rate nobody
 *  typed. Returns null for unusable input. */
export function parseTaxRatePercent(text: string): number | null {
  const t = text.trim().replace(/%$/, "").trim();
  if (t === "") return 0;
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  const bps = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > SALES_TAX_MAX_BPS) return null;
  return bps;
}
