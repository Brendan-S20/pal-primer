// An invoice had no PDF. The office page had a print stylesheet and a button
// labelled "Download / print" that opened the browser's print dialog; quotes
// had nothing at all. HOA boards, commercial customers and bookkeepers file a
// PDF, and Jobber and every competitor hand them one.
//
// These tests hold the generator to what a filed document has to be:
//
//   * a real PDF: it starts %PDF-, and pdf-lib parses it back with the page
//     count the renderer reported;
//   * nothing drawn past the margin, however long the text: a 60-character
//     description, a 46-character client name, a 70-character address with no
//     space in it, a URL. Every draw is recorded, and every one is checked;
//   * thirty lines paginate, with the table header repeated and "Page n of N";
//   * VOID and PAID are on the page in words, not only as a colour;
//   * the numbers a bookkeeper reconciles are the numbers on the page.
//
// The fixture is awkward on purpose, the same rule as tests/viewports: a
// fixture tidier than reality measures nothing.

import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { pdfText } from "./helpers/pdf-text";
import { renderInvoicePdf, type InvoicePdfModel } from "@/lib/pdf/invoice-pdf";
import { renderQuotePdf, type QuotePdfModel } from "@/lib/pdf/quote-pdf";
import {
  MARGIN,
  PAGE_HEIGHT,
  PAGE_WIDTH,
  pdfFileName,
  toBase64,
  wrapText,
  type DrawnText,
} from "@/lib/pdf/pdf-writer";

const LONG_DESCRIPTION = "Common-area waste stations, emptied, relined and disinfected";
const LONG_CLIENT = "Maximilian Alexander Fitzgerald-Worthington II";
const NO_SPACE_EMAIL = "accounts.payable.department.for.the.board@lincolnsquarecondominiums.org";

function awkwardInvoice(overrides: Partial<InvoicePdfModel> = {}): InvoicePdfModel {
  const lines = Array.from({ length: 30 }, (_, i) =>
    i % 3 === 0
      ? { description: LONG_DESCRIPTION, amountCents: 4500, quantity: 3, unitAmountCents: 1500 }
      : i % 3 === 1
        ? {
            description: `Weekly service on 2026-07-${String((i % 28) + 1).padStart(2, "0")}`,
            amountCents: 2500,
          }
        : {
            description: `${LONG_DESCRIPTION} and hauled off site, gate code on file, ${LONG_DESCRIPTION}`,
            amountCents: 1234,
            quantity: 2.5,
            unitAmountCents: 494,
          },
  );
  const total = lines.reduce((s, l) => s + l.amountCents, 0);
  return {
    business: {
      name: "Whitfield & Ramirez Yard, Waste and Pet Sanitation Services of Greater Lincoln Square",
      email: "office@whitfieldramirezpetsanitationservices.example.com",
      phone: "(734) 309-3494",
      address: "4410 North Lincoln Square Boulevard, Suite 200\nLincoln Square, IL 60625",
    },
    label: "INV-1042",
    status: "void",
    issuedOn: "2026-07-01",
    dueOn: "2026-07-15",
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    paidOn: null,
    overdue: false,
    billedTo: { name: LONG_CLIENT, email: NO_SPACE_EMAIL },
    currency: "usd",
    lines,
    subtotalCents: total,
    totalCents: total,
    creditAppliedCents: 1500,
    amountPaidCents: 0,
    refundedCents: 0,
    balanceDueCents: 0,
    payUrl: "https://app.houndstack.com/pay/i/0f0e0d0c-0b0a-4908-8706-050403020100",
    ...overrides,
  };
}

function expectInsideTheMargins(drawn: DrawnText[]) {
  expect(drawn.length).toBeGreaterThan(0);
  const outside = drawn.filter(
    (d) =>
      d.x < MARGIN - 0.01 ||
      d.x + d.width > PAGE_WIDTH - MARGIN + 0.01 ||
      d.y > PAGE_HEIGHT - MARGIN + 0.01 ||
      // The footer sits in the bottom margin by design; nothing goes below it.
      d.y < MARGIN - 10,
  );
  expect(
    outside.map((d) => `p${d.page} x=${d.x.toFixed(1)} w=${d.width.toFixed(1)} "${d.text}"`),
  ).toEqual([]);
}

describe("the invoice PDF", () => {
  it("is a PDF: %PDF- header, parses back, and says what the renderer says", async () => {
    const { bytes, pageCount } = await renderInvoicePdf(awkwardInvoice());
    expect(Buffer.from(bytes.slice(0, 5)).toString("latin1")).toBe("%PDF-");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(pageCount);
    expect(doc.getTitle()).toBe("Invoice INV-1042");
    // US Letter.
    const { width, height } = doc.getPage(0).getSize();
    expect([width, height]).toEqual([612, 792]);
  });

  it("fits the awkward fixture inside the margins: long names, descriptions and addresses wrap", async () => {
    expect(LONG_DESCRIPTION).toHaveLength(60);
    expect(LONG_CLIENT).toHaveLength(46);
    const { drawn } = await renderInvoicePdf(awkwardInvoice());
    expectInsideTheMargins(drawn);
    // The unbroken address was broken inside itself rather than overflowing,
    // and all of it is still on the page.
    const emailPieces = drawn.filter((d) => NO_SPACE_EMAIL.includes(d.text) && d.text.length > 3);
    expect(emailPieces.map((d) => d.text).join("")).toBe(NO_SPACE_EMAIL);
  });

  it("paginates thirty lines, repeats the table header, and numbers the pages", async () => {
    const { bytes, pageCount, drawn } = await renderInvoicePdf(awkwardInvoice());
    expect(pageCount).toBeGreaterThanOrEqual(2);
    const text = await pdfText(bytes);
    expect(text).toContain(`Page 1 of ${pageCount}`);
    expect(text).toContain(`Page ${pageCount} of ${pageCount}`);
    expect(text).toContain("INV-1042 (continued)");
    for (let p = 1; p <= pageCount; p++) {
      const onPage = drawn.filter((d) => d.page === p).map((d) => d.text);
      expect(onPage, `page ${p}`).toContain(`Page ${p} of ${pageCount}`);
    }
    // Every page that carries lines carries the column header.
    const headerPages = new Set(drawn.filter((d) => d.text === "DESCRIPTION").map((d) => d.page));
    const amountPages = new Set(drawn.filter((d) => /^\$\d/.test(d.text)).map((d) => d.page));
    for (const p of amountPages) {
      if (drawn.some((d) => d.page === p && d.text === LONG_DESCRIPTION))
        expect(headerPages.has(p), `page ${p} has lines but no header`).toBe(true);
    }
  });

  it("stamps VOID on every page, in words", async () => {
    const { bytes, pageCount } = await renderInvoicePdf(awkwardInvoice());
    const text = await pdfText(bytes);
    // The badge once, and the diagonal stamp on each page.
    expect(text.split("\n").filter((t) => t === "VOID").length).toBe(1 + pageCount);
    expect(text).toContain("This invoice was voided and is no longer payable.");
    // A voided invoice offers no way to pay it.
    expect(text).not.toContain("online");
  });

  it("prints every number a bookkeeper reconciles, and the pay link", async () => {
    const model = awkwardInvoice({
      status: "open",
      lines: [
        {
          description: "Weekly service on 2026-07-02",
          amountCents: 4500,
          quantity: 3,
          unitAmountCents: 1500,
        },
        { description: "Gate fee", amountCents: 500 },
      ],
      subtotalCents: 5000,
      totalCents: 5400,
      creditAppliedCents: 1000,
      amountPaidCents: 0,
      balanceDueCents: 4400,
      overdue: true,
    });
    const { bytes, drawn } = await renderInvoicePdf(model);
    expectInsideTheMargins(drawn);
    const text = await pdfText(bytes);
    for (const s of [
      "INVOICE",
      "INV-1042",
      "OVERDUE",
      "Issued: Jul 1, 2026",
      "Due: Jul 15, 2026",
      "Service period: Jun 1, 2026 to Jun 30, 2026",
      LONG_CLIENT,
      // "3 × $15.00": the quantity detail, from lineQuantityLabel.
      "3 × $15.00",
      // Dates inside a description are humanized, and on paper keep the year.
      "Weekly service on Jul 2, 2026",
      "Subtotal",
      "$50.00",
      "Total",
      "$54.00",
      "Account credit applied",
      "-$10.00",
      "Balance due",
      "$44.00",
      "Pay $44.00 online",
    ]) {
      expect(text, s).toContain(s);
    }
    // The pay link is on the page (possibly across two lines) and clickable.
    expect(text.replace(/\n/g, "")).toContain(model.payUrl!);
    const doc = await PDFDocument.load(bytes);
    const annots = doc.getPages().flatMap((p) => p.node.Annots()?.asArray() ?? []);
    expect(annots.length).toBeGreaterThan(0);
  });

  it("says PAID, with the amount paid and a zero balance", async () => {
    const { bytes } = await renderInvoicePdf(
      awkwardInvoice({
        status: "paid",
        paidOn: "2026-07-09",
        lines: [{ description: "Gate fee", amountCents: 500 }],
        subtotalCents: 500,
        totalCents: 500,
        creditAppliedCents: 0,
        amountPaidCents: 500,
        balanceDueCents: 0,
      }),
    );
    const text = await pdfText(bytes);
    expect(text).toContain("PAID");
    expect(text).toContain("Amount paid");
    expect(text).toContain("Paid in full on Jul 9, 2026. Thank you.");
    expect(text).toContain("View this invoice online");
  });

  it("does not fall over on a name its font cannot draw", async () => {
    const { bytes, drawn } = await renderInvoicePdf(
      awkwardInvoice({
        billedTo: { name: "李小龍 and Zoë Müller-José 🐶", email: null },
        lines: [{ description: "Service − one visit – thanks", amountCents: 100 }],
      }),
    );
    expectInsideTheMargins(drawn);
    const text = await pdfText(bytes);
    // Latin-1 survives as itself; what the font cannot draw is a "?".
    expect(text).toContain("??? and Zoë Müller-José ?");
    expect(text).toContain("Service - one visit – thanks".replace("–", "\u0096"));
  });
});

function awkwardQuote(overrides: Partial<QuotePdfModel> = {}): QuotePdfModel {
  return {
    business: {
      name: "Whitfield & Ramirez Yard, Waste and Pet Sanitation Services of Greater Lincoln Square",
      email: "office@whitfieldramirez.example.com",
      phone: "(734) 309-3494",
    },
    label: "Q-1001",
    status: "accepted",
    title: "Spring clean-up and weekly service for the Lincoln Square Condominium Association",
    message:
      "Thanks for walking the property with us.\n\nThe per-visit price covers all four common areas. Gate code on file.",
    recipient: { name: LONG_CLIENT, email: NO_SPACE_EMAIL },
    sentOn: "2026-09-01",
    validUntil: "2026-10-01",
    acceptedName: "Genevieve Okonkwo-Castellanos de la Fuente",
    acceptedOn: "2026-09-03",
    declinedOn: null,
    currency: "usd",
    lines: Array.from({ length: 30 }, (_, i) => ({
      description: i % 2 ? LONG_DESCRIPTION : `Initial clean-up, zone ${i + 1}`,
      quantity: i % 2 ? 6 : 1.5,
      unitAmountCents: 450,
      amountCents: i % 2 ? 2700 : 675,
      recurring: i % 2 === 1,
    })),
    acceptUrl: "https://app.houndstack.com/q/dddddddd-0000-4000-8000-00000000d002",
    ...overrides,
  };
}

describe("the quote PDF", () => {
  it("is a PDF that parses back, paginates, and stays inside the margins", async () => {
    const { bytes, pageCount, drawn } = await renderQuotePdf(awkwardQuote());
    expect(Buffer.from(bytes.slice(0, 5)).toString("latin1")).toBe("%PDF-");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(pageCount);
    expect(pageCount).toBeGreaterThanOrEqual(2);
    expectInsideTheMargins(drawn);
  });

  it("labels recurring lines per visit and keeps the two totals apart", async () => {
    const { bytes } = await renderQuotePdf(awkwardQuote());
    const text = await pdfText(bytes);
    for (const s of [
      "QUOTE",
      "Q-1001",
      "Valid until: Oct 1, 2026",
      "6 × $4.50, per visit",
      "1.5 × $4.50, one time",
      "per visit",
      "One-time total",
      "$101.25", // 15 x $6.75
      "Recurring, per visit",
      "$405.00", // 15 x $27.00
      "Thanks for walking the property with us.",
    ]) {
      expect(text, s).toContain(s);
    }
  });

  it("shows who signed and when, once accepted", async () => {
    const text = await pdfText((await renderQuotePdf(awkwardQuote())).bytes);
    expect(text).toContain("ACCEPTED");
    expect(text).toContain("Signed by Genevieve Okonkwo-Castellanos de la Fuente on Sep 3, 2026.");
    expect(text).toContain("View this quote online");
  });

  it("offers the accept link while it is waiting for an answer", async () => {
    const q = awkwardQuote({ status: "sent", acceptedName: null, acceptedOn: null });
    const text = await pdfText((await renderQuotePdf(q)).bytes);
    expect(text).toContain("Review and accept this quote online");
    expect(text.replace(/\n/g, "")).toContain(q.acceptUrl!);
    expect(text).not.toContain("Signed by");
  });

  it("stamps a draft DRAFT and prints no link for it", async () => {
    const q = awkwardQuote({ status: "draft", acceptUrl: null, acceptedName: null, sentOn: null });
    const text = await pdfText((await renderQuotePdf(q)).bytes);
    expect(text).toContain("DRAFT");
    expect(text).not.toContain("online");
  });
});

describe("the pieces", () => {
  it("wraps at spaces and breaks a word only when it cannot fit", () => {
    const measure = (s: string) => s.length;
    expect(wrapText("one two three", 7, measure)).toEqual(["one two", "three"]);
    expect(wrapText("abcdefghij", 4, measure)).toEqual(["abcd", "efgh", "ij"]);
    expect(wrapText("a\n\nb", 10, measure)).toEqual(["a", "", "b"]);
    for (const line of wrapText(NO_SPACE_EMAIL, 20, measure))
      expect(line.length).toBeLessThanOrEqual(20);
  });

  it("names the file after the business and the number", () => {
    expect(pdfFileName("Invoice", "INV-1042", "Doo Right Pet Services, LLC")).toBe(
      "Doo-Right-Pet-Services-LLC-Invoice-INV-1042.pdf",
    );
    expect(pdfFileName("Quote", "Q-7", "Café Zoë")).toBe("Cafe-Zoe-Quote-Q-7.pdf");
  });

  it("base64 round-trips without Buffer", () => {
    const bytes = new Uint8Array(70_000).map((_, i) => (i * 31) % 256);
    expect(Buffer.from(toBase64(bytes), "base64").equals(Buffer.from(bytes))).toBe(true);
  });
});
