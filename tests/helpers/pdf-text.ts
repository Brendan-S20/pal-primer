import { PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib";

/** Every string a PDF's content streams show, one per line, in drawing order
 *  within each stream. The standard fonts are WinAnsi, whose printable range
 *  agrees with Latin-1 for everything the suite looks for ("×" is 0xD7 in
 *  both; an en dash is 0x96 in WinAnsi and reads back as U+0096). */
export async function pdfText(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const chunks: string[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    let raw: Uint8Array;
    try {
      raw = decodePDFRawStream(obj).decode();
    } catch {
      continue;
    }
    const src = Buffer.from(raw).toString("latin1");
    for (const m of src.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)) {
      chunks.push(Buffer.from(m[1], "hex").toString("latin1"));
    }
  }
  return chunks.join("\n");
}
