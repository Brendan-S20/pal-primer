// The invoice as a PDF: what HOA boards, commercial customers and bookkeepers
// file. Pure: a model in, bytes out. Loading the model, and deciding who may
// ask for it, is document-pdf.server.ts.
//
// The page reads the way the invoice page does (src/routes/_authenticated/
// invoices.$invoiceId.tsx): who it is from, the number and dates, who it is
// for, the lines, the totals. Two things are added because paper needs them
// and a screen does not: the year on every date, and the status stamped
// across the page, because a PAID or VOID invoice that has been printed and
// photocopied has lost its colour-coded chip.

import { formatDocumentDay } from "@/lib/format";
import { formatLineItemDescription } from "@/lib/invoice-labels";
import { lineQuantityLabel } from "@/lib/invoice-lines";
import {
  AMBER,
  GREEN,
  INK,
  LINK,
  MUTED,
  PdfWriter,
  RED,
  RULE,
  moneyFormatter,
  type DrawnText,
} from "@/lib/pdf/pdf-writer";

export type InvoicePdfModel = {
  business: {
    name: string;
    email?: string | null;
    phone?: string | null;
    address?: string | null;
  };
  /** "INV-1042", from invoiceNumberLabel. */
  label: string;
  status: string;
  /** Days on the org's calendar, YYYY-MM-DD. */
  issuedOn: string | null;
  dueOn: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  paidOn: string | null;
  /** Whether the invoice is past due on the org's calendar (open only). */
  overdue: boolean;
  billedTo: { name: string | null; email?: string | null };
  currency: string;
  lines: Array<{
    description: string | null;
    amountCents: number;
    quantity?: number | string | null;
    unitAmountCents?: number | null;
  }>;
  subtotalCents: number | null;
  totalCents: number;
  creditAppliedCents: number;
  amountPaidCents: number;
  refundedCents: number;
  balanceDueCents: number;
  /** The customer's no-login link: /pay/i/{token}. */
  payUrl: string | null;
};

/** A row this tall or shorter moves to the next page whole rather than
 *  splitting; anything taller splits, because it could not fit anywhere. */
const ROW_KEEP_TOGETHER_MAX = 560;

const STATUS_WORD: Record<string, string> = {
  draft: "DRAFT",
  open: "OPEN",
  paid: "PAID",
  void: "VOID",
  uncollectible: "UNCOLLECTIBLE",
};

export async function renderInvoicePdf(
  m: InvoicePdfModel,
): Promise<{ bytes: Uint8Array; drawn: DrawnText[]; pageCount: number }> {
  const w = await PdfWriter.create({
    title: `Invoice ${m.label}`,
    author: m.business.name,
    subject: `Invoice ${m.label} from ${m.business.name}`,
  });
  const money = moneyFormatter(m.currency);
  const statusWord = STATUS_WORD[m.status] ?? m.status.toUpperCase();
  const statusColor =
    m.status === "paid" ? GREEN : m.status === "void" ? RED : m.overdue ? RED : AMBER;

  // ── Header: the business on the left, the document on the right ────────
  const top = w.y;
  const colGap = 24;
  const rightColWidth = 200;
  const leftWidth = w.contentWidth - rightColWidth - colGap;

  w.paragraph(m.business.name, { size: 16, bold: true, width: leftWidth });
  w.y -= 2;
  for (const line of [m.business.address, m.business.phone, m.business.email]) {
    if (line && line.trim()) w.paragraph(line, { size: 9, color: MUTED, width: leftWidth });
  }
  const leftBottom = w.y;

  w.y = top;
  const rx = w.right - rightColWidth;
  w.paragraph("INVOICE", { size: 22, bold: true, x: rx, width: rightColWidth, align: "right" });
  w.y -= 2;
  w.paragraph(m.label, { size: 11, bold: true, x: rx, width: rightColWidth, align: "right" });
  w.y -= 6;
  const badgeH = w.badge(
    m.overdue && m.status === "open" ? "OVERDUE" : statusWord,
    w.right,
    w.y,
    statusColor,
  );
  w.y -= badgeH + 8;
  const meta: Array<[string, string]> = [];
  if (m.issuedOn) meta.push(["Issued", formatDocumentDay(m.issuedOn)]);
  if (m.dueOn && m.status !== "paid" && m.status !== "void")
    meta.push(["Due", formatDocumentDay(m.dueOn)]);
  const period =
    m.periodStart && m.periodEnd && m.periodStart !== m.periodEnd
      ? `${formatDocumentDay(m.periodStart)} to ${formatDocumentDay(m.periodEnd)}`
      : m.periodEnd
        ? formatDocumentDay(m.periodEnd)
        : null;
  if (period) meta.push(["Service period", period]);
  if (m.status === "paid" && m.paidOn) meta.push(["Paid", formatDocumentDay(m.paidOn)]);
  for (const [k, v] of meta) {
    w.paragraph(`${k}: ${v}`, {
      size: 9,
      x: rx,
      width: rightColWidth,
      align: "right",
      color: k === "Due" && m.overdue ? RED : INK,
    });
  }
  w.y = Math.min(w.y, leftBottom) - 22;

  // ── Billed to ──────────────────────────────────────────────────────────
  w.paragraph("BILLED TO", { size: 8, bold: true, color: MUTED });
  w.y -= 2;
  w.paragraph(m.billedTo.name?.trim() || "Client", { size: 11, bold: true, width: leftWidth });
  if (m.billedTo.email) w.paragraph(m.billedTo.email, { size: 9, color: MUTED, width: leftWidth });
  w.y -= 20;

  // ── Lines ──────────────────────────────────────────────────────────────
  const amountCol = 110;
  const descWidth = w.contentWidth - amountCol - 12;
  const tableHeader = (x: PdfWriter) => {
    x.y -= 8;
    x.drawLine("DESCRIPTION", x.left, x.y, {
      size: 8,
      bold: true,
      color: MUTED,
      maxWidth: descWidth,
    });
    x.drawLine("AMOUNT", x.right, x.y, {
      size: 8,
      bold: true,
      color: MUTED,
      align: "right",
      maxWidth: amountCol,
    });
    x.y -= 6;
    x.rule(x.y, INK, 0.75);
    x.y -= 4;
  };
  w.onContinue = (x) => {
    x.paragraph(`${m.label} (continued)`, { size: 9, bold: true, color: MUTED });
    x.y -= 4;
    tableHeader(x);
  };
  w.ensure(60);
  tableHeader(w);

  if (m.lines.length === 0) {
    w.y -= 6;
    w.paragraph("No line items on this invoice.", { size: 10, color: MUTED });
  }
  const descSize = 10;
  const qtySize = 8.5;
  const lhDesc = w.lineHeight(descSize);
  const lhQty = w.lineHeight(qtySize);
  for (const li of m.lines) {
    const desc = w.wrap(
      formatLineItemDescription(li.description, formatDocumentDay) || "Service",
      descWidth,
      {
        size: descSize,
      },
    );
    const qty = lineQuantityLabel(
      {
        amount_cents: li.amountCents,
        quantity: li.quantity ?? null,
        unit_amount_cents: li.unitAmountCents ?? null,
      },
      money,
    );
    const rowHeight = 12 + desc.length * lhDesc + (qty ? lhQty : 0);
    // Keep a row on one page when it can be; a row taller than a page (it
    // would take a description thousands of characters long) paginates line
    // by line through `ensure` below instead.
    if (rowHeight > w.y - w.bottom && rowHeight <= ROW_KEEP_TOGETHER_MAX) w.newPage();
    w.y -= 6;
    let first = true;
    for (const line of desc) {
      w.ensure(lhDesc);
      w.y -= descSize;
      w.drawLine(line, w.left, w.y, { size: descSize, maxWidth: descWidth });
      if (first) {
        w.drawLine(money(li.amountCents), w.right, w.y, {
          size: descSize,
          align: "right",
          maxWidth: amountCol,
        });
        first = false;
      }
      w.y -= lhDesc - descSize;
    }
    if (qty) {
      w.ensure(lhQty);
      w.y -= qtySize;
      w.drawLine(qty, w.left, w.y, { size: qtySize, color: MUTED, maxWidth: descWidth });
      w.y -= lhQty - qtySize;
    }
    w.y -= 6;
    w.rule(w.y, RULE, 0.5);
  }
  w.onContinue = (x) => {
    x.paragraph(`${m.label} (continued)`, { size: 9, bold: true, color: MUTED });
    x.y -= 8;
  };

  // ── Totals ─────────────────────────────────────────────────────────────
  const rows: Array<{ label: string; value: string; strong?: boolean; color?: typeof INK }> = [];
  if (m.subtotalCents != null && m.subtotalCents !== m.totalCents)
    rows.push({ label: "Subtotal", value: money(m.subtotalCents) });
  rows.push({ label: "Total", value: money(m.totalCents), strong: true });
  if (m.creditAppliedCents > 0)
    rows.push({ label: "Account credit applied", value: `-${money(m.creditAppliedCents)}` });
  if (m.amountPaidCents > 0)
    rows.push({ label: "Amount paid", value: `-${money(m.amountPaidCents)}` });
  if (m.refundedCents > 0) rows.push({ label: "Refunded", value: money(m.refundedCents) });
  rows.push({
    label: "Balance due",
    value: money(m.balanceDueCents),
    strong: true,
    color: m.balanceDueCents > 0 && m.overdue ? RED : INK,
  });
  const totalsWidth = 250;
  const tx = w.right - totalsWidth;
  const rowH = 18;
  w.ensure(rows.length * rowH + 30);
  w.y -= 10;
  for (const r of rows) {
    const size = r.strong ? 11 : 9.5;
    w.y -= size + 4;
    w.drawLine(r.label, tx, w.y, {
      size,
      bold: r.strong,
      color: r.strong ? (r.color ?? INK) : MUTED,
      maxWidth: totalsWidth - 110,
    });
    w.drawLine(r.value, w.right, w.y, {
      size,
      bold: r.strong,
      color: r.color ?? INK,
      align: "right",
      maxWidth: 110,
    });
    w.y -= rowH - size - 4;
  }
  if (m.status === "void") {
    w.y -= 4;
    w.paragraph("This invoice was voided and is no longer payable.", {
      size: 9,
      color: RED,
      x: tx,
      width: totalsWidth,
      align: "right",
    });
  }
  if (m.status === "paid") {
    w.y -= 4;
    w.paragraph(
      m.paidOn
        ? `Paid in full on ${formatDocumentDay(m.paidOn)}. Thank you.`
        : "Paid in full. Thank you.",
      { size: 9, color: GREEN, x: tx, width: totalsWidth, align: "right" },
    );
  }

  // ── The link ───────────────────────────────────────────────────────────
  if (m.payUrl && m.status !== "void") {
    w.y -= 24;
    w.ensure(50);
    w.paragraph(
      m.status === "open" && m.balanceDueCents > 0
        ? `Pay ${money(m.balanceDueCents)} online`
        : "View this invoice online",
      { size: 10, bold: true },
    );
    w.y -= 2;
    w.paragraph(m.payUrl, { size: 9, color: LINK, link: m.payUrl });
  }

  if (m.status === "paid" || m.status === "void") {
    w.stampAllPages(statusWord, m.status === "paid" ? GREEN : RED);
  }
  w.footer(`${m.business.name}  |  Invoice ${m.label}`, (p, n) => `Page ${p} of ${n}`);
  const bytes = await w.save();
  return { bytes, drawn: w.drawn, pageCount: w.pages.length };
}
