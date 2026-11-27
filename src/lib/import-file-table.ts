// An export as its vendor wrote it, read into one header row and data rows.
//
// Real exports are not all a plain header and rows (files from Housecall Pro
// and Time To Pet trials, 2026-11-27, in tests/fixtures/imports):
//
// - Time To Pet's client and pet exports open with a byte-order mark and put
//   a second header row of group labels under the first ("Primary Contact",
//   "Address", "Emergency Contact", "Other", "Basic Details"). Read as data,
//   that row became a client called "Primary Contact".
// - The same exports repeat column names: "Email", "Primary Phone" and
//   "Secondary Phone" once for the client and again for the emergency
//   contact; the pets file with client fields has two "Name"s, the pet's and
//   the emergency contact's. A repeat is named after its group here
//   ("Email (Emergency Contact)"), so the owner can tell them apart.
// - Time To Pet's Sales report has an unnamed first column holding only the
//   report's date range and a "Totals: " line. Neither is a row of data.
// - Housecall Pro writes ids as Excel formulas so a spreadsheet keeps them as
//   text: ="1". The value is 1.
//
// Every line that is not imported is listed in `skipped` with the reason, for
// the page to show; nothing is dropped without a word.

export type SkippedLine = { line: number; reason: string };
export type FileTable = {
  headers: string[];
  rows: Record<string, string>[];
  skipped: SkippedLine[];
};

const blank = (s: string | undefined) => (s ?? "").trim() === "";

/** ="1" → 1, the way Excel would show it. */
function cellValue(raw: unknown): string {
  const s = raw === undefined || raw === null ? "" : String(raw);
  const formula = s.match(/^="(.*)"$/s);
  return formula ? formula[1] : s;
}

const YES_NO = /^(yes|no|y|n|true|false)$/i;

/** A second header row of group labels: two or more labels, none holding a
 *  digit or a yes/no, each label filling one unbroken run of columns, and
 *  at least one label spanning several columns. A row of data has a name, a
 *  date, a zip or an amount in it; this has only section names. */
export function isGroupLabelRow(row: readonly string[], headers: readonly string[]): boolean {
  const filled = row.map((c, i) => ({ c: c.trim(), i })).filter((x) => x.c !== "");
  if (filled.length < 2) return false;
  if (
    filled.some(
      ({ c, i }) => /\d/.test(c) || YES_NO.test(c) || c.length > 40 || c === headers[i]?.trim(),
    )
  ) {
    return false;
  }
  const runs: string[] = [];
  let prev: string | null = null;
  for (let i = 0; i < row.length; i++) {
    const c = (row[i] ?? "").trim();
    if (c === "") {
      prev = null;
      continue;
    }
    if (c !== prev) runs.push(c);
    prev = c;
  }
  // Each label appears as one run, and some run is longer than one column.
  return new Set(runs).size === runs.length && runs.length < filled.length;
}

const TOTALS = /^(grand\s+)?totals?\s*:?\s*$/i;

/** The rows of a parsed CSV (header row first, as Papa Parse returns it
 *  without `header: true`) as a header list and keyed rows. */
export function tableFromCsv(cells: readonly (readonly unknown[])[]): FileTable {
  const lines = cells.map((r) => r.map(cellValue));
  if (!lines.length) return { headers: [], rows: [], skipped: [] };
  const first = [...lines[0]];
  if (first.length) first[0] = first[0].replace(/^\uFEFF/, "");
  const raw = first.map((h) => h.trim());
  const skipped: SkippedLine[] = [];

  let body = 1;
  let groups: string[] | null = null;
  if (lines.length > 1 && isGroupLabelRow(lines[1], raw)) {
    groups = lines[1].map((g) => g.trim());
    const names = [...new Set(groups.filter((g) => g))];
    skipped.push({
      line: 2,
      reason: `Column group labels, not a row of data (${names.join(", ")})`,
    });
    body = 2;
  }

  // Unique, readable names: a repeat takes its group label, else a number.
  const seen = new Map<string, number>();
  const headers = raw.map((h, i) => {
    if (h === "") return "";
    const key = h.toLowerCase();
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n === 1) return h;
    const group = groups?.[i];
    return group ? `${h} (${group})` : `${h} (${n})`;
  });
  // A group label that named two repeats alike still needs them apart.
  const taken = new Set<string>();
  for (let i = 0; i < headers.length; i++) {
    if (!headers[i]) continue;
    let name = headers[i];
    for (let k = 2; taken.has(name.toLowerCase()); k++) name = `${headers[i]} (${k})`;
    headers[i] = name;
    taken.add(name.toLowerCase());
  }
  const unnamed = headers.map((h, i) => (h === "" ? i : -1)).filter((i) => i >= 0);

  const kept: string[][] = [];
  for (let n = body; n < lines.length; n++) {
    const line = lines[n];
    if (line.every((c) => blank(c))) continue;
    const firstFilled = line.find((c) => !blank(c))!.trim();
    if (TOTALS.test(firstFilled)) {
      skipped.push({ line: n + 1, reason: `A totals line ("${firstFilled}")` });
      continue;
    }
    // Text only under columns with no name: a report's title or date range.
    const named = line.some((c, i) => !blank(c) && headers[i]);
    if (!named) {
      skipped.push({
        line: n + 1,
        reason: `A report heading, not a row of data ("${firstFilled}")`,
      });
      continue;
    }
    kept.push(line);
  }

  // An unnamed column with values left in it is still a column.
  const live = unnamed.filter((i) => kept.some((l) => !blank(l[i])));
  for (const i of live) headers[i] = `Column ${i + 1}`;
  const columns = headers.map((h, i) => ({ h, i })).filter((x) => x.h !== "");
  const rows = kept.map((line) => {
    const r: Record<string, string> = {};
    for (const { h, i } of columns) r[h] = line[i] ?? "";
    return r;
  });
  return { headers: columns.map((c) => c.h), rows, skipped };
}
