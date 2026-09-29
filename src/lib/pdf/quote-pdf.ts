// The quote as a PDF. Same shape as the quote the customer reads at /q/:token
// (src/components/quotes/QuoteDocument.tsx): from, to, the lines with their
// arithmetic, one-time and per-visit totals kept apart, and what the customer
// answered. Pure: model in, bytes out. Access is document-pdf.server.ts.

import { formatDocumentDay } from "@/lib/format";
import { RECURRING_LABEL, formatQuantity, quoteTotals } from "@/lib/quotes";
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

export type QuotePdfModel = {
  business: { name: string; email?: string | null; phone?: string | null };
  /** "Q-1001", from quoteNumberLabel. */
  label: string;
  /** The EFFECTIVE status (a sent quote past valid_until is "expired"). */
  status: string;
  title: string | null;
  message: string | null;
  recipient: { name: string | null; email?: string | null };
  /** Days on the org's calendar, YYYY-MM-DD. */
  sentOn: string | null;
  validUntil: string | null;
  acceptedName: string | null;
  acceptedOn: string | null;
  declinedOn: string | null;
  currency: string;
  lines: Array<{
    description: string;
    quantity: number;
    unitAmountCents: number;
    amountCents: number;
    recurring: boolean;
  }>;
  /** The customer's link, /q/{token}. Null for a draft, which has none. */
  acceptUrl: string | null;
};

const STATUS_WORD: Record<string, string> = {
  draft: "DRAFT",
  sent: "AWAITING ANSWER",
  accepted: "ACCEPTED",
  declined: "DECLINED",
  expired: "EXPIRED",
};

const ROW_KEEP_TOGETHER_MAX = 560;

export async function renderQuotePdf(
  m: QuotePdfModel,
): Promise<{ bytes: Uint8Array; drawn: DrawnText[]; pageCount: number }> {
  const w = await PdfWriter.create({
    title: `Quote ${m.label}`,
    author: m.business.name,
    subject: `Quote ${m.label} from ${m.business.name}`,
  });
  const money = moneyFormatter(m.currency);
  const statusWord = STATUS_WORD[m.status] ?? m.status.toUpperCase();
  const statusColor =
    m.status === "accepted"
      ? GREEN
      : m.status === "declined" || m.status === "expired"
        ? RED
        : m.status === "draft"
          ? MUTED
          : AMBER;

  // ── Header ─────────────────────────────────────────────────────────────
  const top = w.y;
  const rightColWidth = 200;
  const leftWidth = w.contentWidth - rightColWidth - 24;
  w.paragraph(m.business.name, { size: 16, bold: true, width: leftWidth });
  w.y -= 2;
  for (const line of [m.business.phone, m.business.email]) {
    if (line && line.trim()) w.paragraph(line, { size: 9, color: MUTED, width: leftWidth });
  }
  const leftBottom = w.y;

  w.y = top;
  const rx = w.right - rightColWidth;
  w.paragraph("QUOTE", { size: 22, bold: true, x: rx, width: rightColWidth, align: "right" });
  w.y -= 2;
  w.paragraph(m.label, { size: 11, bold: true, x: rx, width: rightColWidth, align: "right" });
  w.y -= 6;
  const bh = w.badge(statusWord, w.right, w.y, statusColor);
  w.y -= bh + 8;
  const meta: Array<[string, string]> = [];
  if (m.sentOn) meta.push(["Sent", formatDocumentDay(m.sentOn)]);
  if (m.validUntil) meta.push(["Valid until", formatDocumentDay(m.validUntil)]);
  for (const [k, v] of meta) {
    w.paragraph(`${k}: ${v}`, {
      size: 9,
      x: rx,
      width: rightColWidth,
      align: "right",
      color: k === "Valid until" && m.status === "expired" ? RED : INK,
    });
  }
  w.y = Math.min(w.y, leftBottom) - 22;

  // ── Prepared for / For ─────────────────────────────────────────────────
  w.paragraph("PREPARED FOR", { size: 8, bold: true, color: MUTED });
  w.y -= 2;
  w.paragraph(m.recipient.name?.trim() || "Customer", { size: 11, bold: true, width: leftWidth });
  if (m.recipient.email)
    w.paragraph(m.recipient.email, { size: 9, color: MUTED, width: leftWidth });
  if (m.title) {
    w.y -= 10;
    w.paragraph("FOR", { size: 8, bold: true, color: MUTED });
    w.y -= 2;
    w.paragraph(m.title, { size: 11, bold: true });
  }
  if (m.message && m.message.trim()) {
    w.y -= 14;
    w.paragraph(m.message.trim(), { size: 10, x: w.left + 10, width: w.contentWidth - 10 });
  }
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
    w.paragraph("No lines on this quote.", { size: 10, color: MUTED });
  }
  const descSize = 10;
  const subSize = 8.5;
  const lhDesc = w.lineHeight(descSize);
  const lhSub = w.lineHeight(subSize);
  for (const l of m.lines) {
    const desc = w.wrap(l.description || "Service", descWidth, { size: descSize });
    const sub = `${formatQuantity(l.quantity)} × ${money(l.unitAmountCents)}${
      l.recurring ? `, ${RECURRING_LABEL}` : ", one time"
    }`;
    const subLines = w.wrap(sub, descWidth, { size: subSize });
    const rowHeight = 12 + desc.length * lhDesc + subLines.length * lhSub;
    if (rowHeight > w.y - w.bottom && rowHeight <= ROW_KEEP_TOGETHER_MAX) w.newPage();
    w.y -= 6;
    let first = true;
    for (const line of desc) {
      w.ensure(lhDesc);
      w.y -= descSize;
      w.drawLine(line, w.left, w.y, { size: descSize, maxWidth: descWidth });
      if (first) {
        w.drawLine(money(l.amountCents), w.right, w.y, {
          size: descSize,
          bold: true,
          align: "right",
          maxWidth: amountCol,
        });
        first = false;
        if (l.recurring) {
          w.drawLine(RECURRING_LABEL, w.right, w.y - lhSub, {
            size: subSize,
            color: MUTED,
            align: "right",
            maxWidth: amountCol,
          });
        }
      }
      w.y -= lhDesc - descSize;
    }
    for (const line of subLines) {
      w.ensure(lhSub);
      w.y -= subSize;
      w.drawLine(line, w.left, w.y, { size: subSize, color: MUTED, maxWidth: descWidth });
      w.y -= lhSub - subSize;
    }
    w.y -= 6;
    w.rule(w.y, RULE, 0.5);
  }
  w.onContinue = (x) => {
    x.paragraph(`${m.label} (continued)`, { size: 9, bold: true, color: MUTED });
    x.y -= 8;
  };

  // ── Totals: one-time and per visit, never added together ───────────────
  const totals = quoteTotals(
    m.lines.map((l) => ({ amount_cents: l.amountCents, recurring: l.recurring })),
  );
  const rows: Array<[string, string]> = [];
  if (totals.oneTimeCount > 0) rows.push(["One-time total", money(totals.oneTimeCents)]);
  if (totals.recurringCount > 0)
    rows.push([`Recurring, ${RECURRING_LABEL}`, money(totals.recurringCents)]);
  const totalsWidth = 250;
  const tx = w.right - totalsWidth;
  w.ensure(rows.length * 20 + 20);
  w.y -= 10;
  for (const [label, value] of rows) {
    w.y -= 15;
    w.drawLine(label, tx, w.y, { size: 10, color: MUTED, maxWidth: totalsWidth - 110 });
    w.drawLine(value, w.right, w.y, { size: 12, bold: true, align: "right", maxWidth: 110 });
    w.y -= 5;
  }
  if (totals.recurringCount > 0 && totals.oneTimeCount > 0) {
    w.y -= 2;
    w.paragraph(
      "The one-time total is charged once. The recurring price is charged on every visit.",
      { size: 8, color: MUTED, x: tx, width: totalsWidth, align: "right" },
    );
  }

  // ── The answer ─────────────────────────────────────────────────────────
  w.y -= 22;
  w.ensure(70);
  if (m.status === "accepted") {
    w.paragraph("ACCEPTED", { size: 9, bold: true, color: GREEN });
    w.y -= 2;
    w.paragraph(
      `Signed by ${m.acceptedName ?? "the customer"}${
        m.acceptedOn ? ` on ${formatDocumentDay(m.acceptedOn)}` : ""
      }.`,
      { size: 11, bold: true },
    );
    w.paragraph(
      "The customer typed their full name and pressed Accept as their signature agreeing to this quote.",
      { size: 8.5, color: MUTED },
    );
  } else if (m.status === "declined") {
    w.paragraph(`Declined${m.declinedOn ? ` on ${formatDocumentDay(m.declinedOn)}` : ""}.`, {
      size: 10,
      bold: true,
      color: RED,
    });
  } else if (m.status === "expired") {
    w.paragraph("This quote has expired and can no longer be accepted.", {
      size: 10,
      bold: true,
      color: RED,
    });
  } else if (m.status === "draft") {
    w.paragraph("Draft. This quote has not been sent to the customer.", {
      size: 10,
      bold: true,
      color: MUTED,
    });
  }

  if (m.acceptUrl) {
    w.y -= 14;
    w.ensure(40);
    w.paragraph(
      m.status === "sent" ? "Review and accept this quote online" : "View this quote online",
      { size: 10, bold: true },
    );
    w.y -= 2;
    w.paragraph(m.acceptUrl, { size: 9, color: LINK, link: m.acceptUrl });
  }

  if (m.status === "draft" || m.status === "declined" || m.status === "expired") {
    w.stampAllPages(statusWord, m.status === "draft" ? MUTED : RED);
  }
  w.footer(`${m.business.name}  |  Quote ${m.label}`, (p, n) => `Page ${p} of ${n}`);
  const bytes = await w.save();
  return { bytes, drawn: w.drawn, pageCount: w.pages.length };
}
