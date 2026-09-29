// pdf-lib, from its own prebuilt ES bundle rather than its package entry.
//
// ── WHY NOT `import ... from "pdf-lib"` ────────────────────────────────────
//
// It builds, it passes every test in Node, and the deployed worker answers
// every PDF request with a 500. Measured on 2026-09-29 by running the BUILT
// worker (.output/server) in workerd with `wrangler dev`:
//
//   TypeError: Cannot destructure property '__extends' of
//   '__toESM(...).default' as it is undefined.
//       at .output/server/_libs/pdf-lib+tslib.mjs:19:7
//
// pdf-lib's package entry (es/index.js) imports its helpers from tslib 1.x,
// whose ESM wrapper (tslib/modules/index.js) default-imports the CommonJS
// tslib.js. That file marks itself `__esModule`, so the server bundle's
// interop reads `.default` off it, finds nothing, and the module throws the
// moment it is evaluated. Node's own loader and Vitest resolve the same
// import differently, which is why nothing but the real runtime shows it.
//
// dist/pdf-lib.esm.min.js is the same library with tslib, pako and the font
// metrics already inlined and no imports at all, so there is no interop left
// for a bundler to get wrong. It ships no declarations, so the values are
// typed here as the package's own: `import type` below is erased at build
// and never loads the package entry.
//
// Import pdf-lib ONLY through this file. tests/a-pdf-opens-only-the-doors-
// its-page-does.test.ts fails on a direct `from "pdf-lib"` anywhere else in
// src/.

// @ts-expect-error -- the prebuilt bundle has no .d.ts; typed as the package below.
import * as bundle from "pdf-lib/dist/pdf-lib.esm.min.js";
import type * as PdfLib from "pdf-lib";

const lib = bundle as typeof PdfLib;

export const PDFDocument = lib.PDFDocument;
export type PDFDocument = PdfLib.PDFDocument;
export const PDFString = lib.PDFString;
export const StandardFonts = lib.StandardFonts;
export const degrees = lib.degrees;
export const rgb = lib.rgb;
export type PDFFont = PdfLib.PDFFont;
export type PDFPage = PdfLib.PDFPage;
export type RGB = PdfLib.RGB;
