// P1.16: the product had no data export anywhere — a real objection for anyone
// evaluating a switch from another tool. Client-side CSV of the currently
// filtered list keeps it dependency-free and works offline.

function csvEscape(v: unknown): string {
  if (v == null) return "";
  let s = String(v);
  // Formula-injection guard: a client name like `=HYPERLINK(...)` (which can
  // arrive via the public lead form) must not execute when the export opens
  // in Excel/Sheets. Prefixing ' makes spreadsheet apps treat it as text.
  if (/^[=+@\t\r]/.test(s) || (s.startsWith("-") && s.length > 1)) {
    s = `'${s}`;
  }
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: Array<Array<unknown>>): string {
  return [headers, ...rows].map((r) => r.map(csvEscape).join(",")).join("\r\n");
}

export function downloadCsv(filename: string, headers: string[], rows: Array<Array<unknown>>) {
  const blob = new Blob(["﻿" + toCsv(headers, rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
