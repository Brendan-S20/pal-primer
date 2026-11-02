// The name a PDF is saved under in the native app's cache before the share
// sheet opens (#660, src/components/DownloadPdfButton.tsx).

/** A file name the native file system will take: no path separators, no
 *  characters Android's FileProvider or iOS share targets trip over. */
export function nativePdfName(filename: string): string {
  const base = filename.replace(/\.pdf$/i, "").replace(/[^A-Za-z0-9._-]+/g, "-");
  const trimmed = base.replace(/^[-.]+|[-.]+$/g, "").slice(0, 80);
  return `${trimmed || "document"}.pdf`;
}
