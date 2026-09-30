// A Polish name printed as a question mark.
//
// The PDF fonts are the standard WinAnsi ones, and the sanitizer folds an
// accent it cannot draw onto its base letter ("Nguyễn" -> "Nguyen"). But a
// handful of Latin letters have no decomposition to fold: the Polish Ł, the
// Croatian and Serbian Đ, the Maltese Ħ, the Turkish dotless ı. NFKD leaves
// them alone, so "Łukasz Đorđević" printed as "?ukasz ?or?evi?". They now map
// to the plain base letter, the way the same names are spelled wherever the
// stroke cannot go. Scripts with no Latin form still print "?"; embedding a
// Unicode font for them was weighed and not taken (bundle size in the worker).

import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "@/lib/pdf/pdf-lib";
import { makeSanitizer } from "@/lib/pdf/pdf-writer";

const sanitize = async () => {
  const doc = await PDFDocument.create();
  return makeSanitizer(await doc.embedFont(StandardFonts.Helvetica));
};

describe("names in the PDF", () => {
  it("keep Latin letters with a stroke as their base letter", async () => {
    const s = await sanitize();
    expect(s("Łukasz Đorđević")).toBe("Lukasz Dordevic");
    expect(s("Ħamrun, Iğdır")).toBe("Hamrun, Igdir");
  });

  it("still fold accents, and still keep what Latin-1 has", async () => {
    const s = await sanitize();
    expect(s("Nguyễn Zoë Müller-José")).toBe("Nguyen Zoë Müller-José");
  });

  it("still print a question mark for a script with no Latin form", async () => {
    const s = await sanitize();
    expect(s("李小龍")).toBe("???");
  });
});
