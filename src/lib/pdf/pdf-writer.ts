// A page, a cursor and a font: the small amount of layout an invoice or a
// quote needs, over pdf-lib.
//
// ── WHY pdf-lib ────────────────────────────────────────────────────────────
//
// The app deploys to Cloudflare Workers (Nitro's cloudflare-module preset, via
// @lovable.dev/vite-tanstack-config). A PDF library has to run THERE, not
// only in Node: no native modules, no canvas, no filesystem, no WebAssembly
// that has to be fetched at runtime. pdf-lib is plain JavaScript over
// Uint8Array, and its four dependencies (pako, tslib and two of its own) are
// the same. The standard 14 fonts are metrics tables compiled into the
// package, so nothing is read from disk to set text.
//
// @react-pdf/renderer was the other candidate and was not chosen: it lays out
// with yoga (WebAssembly) and loads fonts through fontkit, and both of those
// have to be coaxed into a Worker. For two documents with a fixed shape, a
// layout engine is a large dependency for a problem this file solves in a few
// hundred lines.
//
// ── WHAT THE STANDARD FONTS CANNOT SAY ─────────────────────────────────────
//
// Helvetica here is WinAnsi: Latin-1 plus a few typographic marks. "José",
// "Müller", "Zoë", "×" and "–" are all in it. A name written in a script it
// does not cover (Chinese, Arabic, an emoji) would make pdf-lib THROW rather
// than draw a box, which would turn one customer's name into a failed
// download. `sanitize` below decides character by character: keep it, fold
// an accent it cannot draw onto its base letter, or print "?". Embedding a
// Unicode font would fix that and cost a few hundred KB in the worker bundle;
// that trade was not made here.
//
// ── WHAT THIS FILE PROMISES ────────────────────────────────────────────────
//
// Nothing is drawn past the page margin. Text wraps at word boundaries, and a
// "word" wider than the space it has (a URL, an email address, a 46-character
// name with no space in it) is broken inside itself rather than allowed to run
// off the edge. Every draw is recorded in `drawn`, which is how the tests
// prove that promise rather than eyeball it.

import {
  PDFDocument,
  PDFString,
  StandardFonts,
  degrees,
  rgb,
  type PDFFont,
  type PDFPage,
  type RGB,
} from "@/lib/pdf/pdf-lib";

export const PAGE_WIDTH = 612; // US Letter, points
export const PAGE_HEIGHT = 792;
export const MARGIN = 48;
/** Space kept clear at the bottom of every page for the footer. */
export const FOOTER_SPACE = 28;

export const INK = rgb(0.1, 0.1, 0.12);
export const MUTED = rgb(0.42, 0.43, 0.47);
export const RULE = rgb(0.84, 0.85, 0.87);
export const LINK = rgb(0.09, 0.33, 0.72);
export const GREEN = rgb(0.06, 0.5, 0.27);
export const RED = rgb(0.75, 0.13, 0.13);
export const AMBER = rgb(0.7, 0.45, 0.02);

export type DrawnText = {
  page: number;
  x: number;
  y: number;
  width: number;
  size: number;
  text: string;
};

/** Characters with an obvious WinAnsi stand-in that NFKD does not find. */
const REPLACEMENTS: Record<string, string> = {
  "−": "-", // minus sign
  "‐": "-",
  "‑": "-",
  "‒": "-",
  "―": "-",
  "′": "'",
  "″": '"',
  " ": " ",
  " ": " ",
  " ": " ",
  " ": " ",
  "​": "",
  "‌": "",
  "‍": "",
  "﻿": "",
};

export function makeSanitizer(font: PDFFont): (s: string) => string {
  const supported = new Set(font.getCharacterSet());
  const ok = (c: string) => supported.has(c.codePointAt(0)!);
  return (raw: string) => {
    let out = "";
    for (const ch of (raw ?? "").normalize("NFC")) {
      if (ch === "\n") {
        out += "\n";
        continue;
      }
      if (ch === "\r") continue;
      if (ch === "\t") {
        out += " ";
        continue;
      }
      if (ch in REPLACEMENTS) {
        out += REPLACEMENTS[ch];
        continue;
      }
      // Control characters draw nothing useful and some are unencodable.
      if (/[\u0000-\u001f\u007f-\u009f]/.test(ch)) continue;
      if (ok(ch)) {
        out += ch;
        continue;
      }
      const base = ch.normalize("NFKD").replace(/[̀-ͯ]/g, "");
      if (base && [...base].every(ok)) {
        out += base;
        continue;
      }
      out += "?";
    }
    return out;
  };
}

/**
 * Lines of at most `width`, broken at spaces, and inside a word only when the
 * word alone is wider than the line. Newlines in the input are kept as line
 * breaks; runs of spaces collapse. Never returns an empty array.
 */
export function wrapText(text: string, width: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const words = para.split(/ +/).filter(Boolean);
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    for (let word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate) <= width) {
        line = candidate;
        continue;
      }
      if (line) out.push(line);
      line = "";
      // A single word wider than the line: take the longest prefix that fits,
      // at least one character so a pathological width still terminates.
      while (measure(word) > width) {
        let lo = 1;
        let hi = word.length;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          if (measure(word.slice(0, mid)) <= width) lo = mid;
          else hi = mid - 1;
        }
        out.push(word.slice(0, lo));
        word = word.slice(lo);
      }
      line = word;
    }
    out.push(line);
  }
  return out.length ? out : [""];
}

type TextOpts = {
  size: number;
  bold?: boolean;
  color?: RGB;
};

export class PdfWriter {
  readonly doc: PDFDocument;
  readonly font: PDFFont;
  readonly bold: PDFFont;
  readonly sanitize: (s: string) => string;
  readonly pages: PDFPage[] = [];
  readonly drawn: DrawnText[] = [];
  page!: PDFPage;
  /** The baseline cursor, in PDF coordinates (0 at the bottom). */
  y = 0;
  /** Drawn at the top of every page after the first, e.g. a table header. */
  onContinue: ((w: PdfWriter) => void) | null = null;

  private constructor(doc: PDFDocument, font: PDFFont, bold: PDFFont) {
    this.doc = doc;
    this.font = font;
    this.bold = bold;
    this.sanitize = makeSanitizer(font);
  }

  static async create(meta: { title: string; author: string; subject: string }) {
    const doc = await PDFDocument.create();
    const w = new PdfWriter(
      doc,
      await doc.embedFont(StandardFonts.Helvetica),
      await doc.embedFont(StandardFonts.HelveticaBold),
    );
    const clean = (s: string) => w.sanitize(s).replace(/\n/g, " ");
    doc.setTitle(clean(meta.title));
    doc.setAuthor(clean(meta.author));
    doc.setSubject(clean(meta.subject));
    doc.setCreator("HoundStack");
    doc.setProducer("HoundStack");
    doc.setCreationDate(new Date());
    doc.setModificationDate(new Date());
    w.addPage();
    return w;
  }

  get left() {
    return MARGIN;
  }
  get right() {
    return PAGE_WIDTH - MARGIN;
  }
  get contentWidth() {
    return PAGE_WIDTH - 2 * MARGIN;
  }
  get bottom() {
    return MARGIN + FOOTER_SPACE;
  }

  private addPage() {
    this.page = this.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.pages.push(this.page);
    this.y = PAGE_HEIGHT - MARGIN;
  }

  /** A new page, with the continuation header when one is set. */
  newPage() {
    this.addPage();
    this.onContinue?.(this);
  }

  /** Room for `height` more points below the cursor, or a new page. */
  ensure(height: number) {
    if (this.y - height < this.bottom) this.newPage();
  }

  fontFor(o: { bold?: boolean }) {
    return o.bold ? this.bold : this.font;
  }

  width(text: string, o: TextOpts) {
    return this.fontFor(o).widthOfTextAtSize(text, o.size);
  }

  lineHeight(size: number) {
    return Math.round(size * 1.35 * 100) / 100;
  }

  /** Wrap already-sanitized or raw text to `width`. */
  wrap(text: string, width: number, o: TextOpts): string[] {
    return wrapText(this.sanitize(text), width, (s) => this.width(s, o));
  }

  /**
   * One line, at an explicit baseline. `text` must already fit in `maxWidth`
   * (use `wrap` first); it is clipped to it as a last resort so that a caller's
   * mistake shows up as a missing character, never as text off the page.
   */
  drawLine(
    text: string,
    x: number,
    y: number,
    o: TextOpts & { align?: "left" | "right"; maxWidth: number; opacity?: number },
  ) {
    let t = this.sanitize(text).replace(/\n/g, " ");
    while (t.length > 1 && this.width(t, o) > o.maxWidth + 0.01) t = t.slice(0, -1);
    const w = this.width(t, o);
    const drawX = o.align === "right" ? x - w : x;
    if (!t) return;
    this.page.drawText(t, {
      x: drawX,
      y,
      size: o.size,
      font: this.fontFor(o),
      color: o.color ?? INK,
      ...(o.opacity != null ? { opacity: o.opacity } : {}),
    });
    this.drawn.push({ page: this.pages.length, x: drawX, y, width: w, size: o.size, text: t });
  }

  /**
   * A wrapped block at the cursor, moving the cursor down. Paginates line by
   * line, so a block longer than a page continues on the next one.
   * Returns the lines drawn.
   */
  paragraph(
    text: string,
    o: TextOpts & { x?: number; width?: number; align?: "left" | "right"; link?: string },
  ): string[] {
    const x = o.x ?? this.left;
    const width = o.width ?? this.right - x;
    const lines = this.wrap(text, width, o);
    const lh = this.lineHeight(o.size);
    for (const line of lines) {
      this.ensure(lh);
      this.y -= o.size;
      const anchorX = o.align === "right" ? x + width : x;
      this.drawLine(line, anchorX, this.y, { ...o, maxWidth: width });
      if (o.link && line) {
        const lw = this.width(line, o);
        const lx = o.align === "right" ? anchorX - lw : anchorX;
        this.linkRect(o.link, lx, this.y - 2, lw, o.size + 3);
      }
      this.y -= lh - o.size;
    }
    return lines;
  }

  rule(y = this.y, color: RGB = RULE, thickness = 0.75) {
    this.page.drawLine({
      start: { x: this.left, y },
      end: { x: this.right, y },
      thickness,
      color,
    });
  }

  /** A clickable area on the current page that opens `url`. */
  linkRect(url: string, x: number, y: number, width: number, height: number) {
    const ctx = this.doc.context;
    const annot = ctx.register(
      ctx.obj({
        Type: "Annot",
        Subtype: "Link",
        Rect: [x, y, x + width, y + height],
        Border: [0, 0, 0],
        A: { Type: "Action", S: "URI", URI: PDFString.of(url) },
      }),
    );
    this.page.node.addAnnot(annot);
  }

  /** A word in a box: the status, where it cannot be missed. */
  badge(text: string, xRight: number, yTop: number, color: RGB, size = 11) {
    const label = this.sanitize(text);
    const padX = 7;
    const padY = 4;
    const w = this.width(label, { size, bold: true }) + padX * 2;
    const h = size + padY * 2;
    this.page.drawRectangle({
      x: xRight - w,
      y: yTop - h,
      width: w,
      height: h,
      borderColor: color,
      borderWidth: 1.5,
    });
    this.drawLine(label, xRight - w + padX, yTop - h + padY + 1.5, {
      size,
      bold: true,
      color,
      maxWidth: w,
    });
    return h;
  }

  /** The large diagonal PAID / VOID across the middle of every page. Faint
   *  enough to read through, large enough that a photocopy still says it. */
  stampAllPages(text: string, color: RGB) {
    const label = this.sanitize(text);
    const size = 110;
    const w = this.bold.widthOfTextAtSize(label, size);
    const angle = 30;
    const rad = (angle * Math.PI) / 180;
    // Centre the rotated baseline on the page centre.
    const cx = PAGE_WIDTH / 2;
    const cy = PAGE_HEIGHT / 2;
    const x = cx - (w / 2) * Math.cos(rad) + (size / 3) * Math.sin(rad);
    const y = cy - (w / 2) * Math.sin(rad) - (size / 3) * Math.cos(rad);
    for (const page of this.pages) {
      page.drawText(label, {
        x,
        y,
        size,
        font: this.bold,
        color,
        opacity: 0.13,
        rotate: degrees(angle),
      });
    }
  }

  /** "INV-12 · Page 1 of 3" on every page, once the page count is known. */
  footer(left: string, right: (page: number, of: number) => string) {
    const size = 8;
    const y = MARGIN - 4;
    const n = this.pages.length;
    this.pages.forEach((page, i) => {
      const saved = this.page;
      this.page = page;
      const r = right(i + 1, n);
      const rw = this.width(r, { size });
      this.page.drawLine({
        start: { x: this.left, y: y + 14 },
        end: { x: this.right, y: y + 14 },
        thickness: 0.5,
        color: RULE,
      });
      const drawnBefore = this.drawn.length;
      this.drawLine(left, this.left, y, {
        size,
        color: MUTED,
        maxWidth: this.contentWidth - rw - 16,
      });
      this.drawLine(r, this.right, y, { size, color: MUTED, align: "right", maxWidth: rw + 1 });
      // Record the right page number for these two draws.
      for (let k = drawnBefore; k < this.drawn.length; k++) this.drawn[k].page = i + 1;
      this.page = saved;
    });
  }

  async save(): Promise<Uint8Array> {
    return this.doc.save();
  }
}

/** "$1,234.00" in the document's currency. */
export function moneyFormatter(currency: string | null | undefined) {
  const fmt = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: (currency || "usd").toUpperCase(),
  });
  return (cents: number | null | undefined) => fmt.format((cents ?? 0) / 100);
}

/** A file name a person can read in a downloads folder. */
export function pdfFileName(kind: "Invoice" | "Quote", label: string, business: string): string {
  const slug = (s: string) =>
    s
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^A-Za-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40);
  const parts = [slug(business), kind, slug(label)].filter(Boolean);
  return `${parts.join("-")}.pdf`;
}

/** Bytes to base64 without Buffer, which a Worker only has behind a flag. */
export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
