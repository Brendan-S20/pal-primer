/** Invoices in the shape QuickBooks Online's own importer takes.
 *
 *  The live QuickBooks sync is built and switched off
 *  (ACCOUNTING_CONNECT_ENABLED), so an owner moving books over had nothing to
 *  hand their bookkeeper but totals by month. QuickBooks Online can import
 *  invoices from a CSV (Settings → Import data → Invoices) with no connection
 *  and no app, and this produces that file.
 *
 *  What the importer allows, and so what this has to respect:
 *    - one row per invoice LINE, repeating the invoice number, customer and
 *      dates on each row of the same invoice;
 *    - at most 100 invoices and 1,000 rows per file, so a month for a busy
 *      business is several files, and an invoice is never split across two;
 *    - no negative amounts, so an invoice with a credit or discount line
 *      cannot go through it at all, and is listed for entry by hand rather
 *      than imported with its discount silently missing;
 *    - dates in a format picked at upload; MM/DD/YYYY is offered on every US
 *      company. */

export const QBO_MAX_INVOICES_PER_FILE = 100;
export const QBO_MAX_ROWS_PER_FILE = 1000;

export type QboInvoice = {
  invoiceNo: string;
  customer: string;
  /** YYYY-MM-DD, on the org's calendar. */
  issuedDay: string;
  /** YYYY-MM-DD, or null (the invoice date is used). */
  dueOn: string | null;
  totalCents: number;
  lines: Array<{ description: string; amountCents: number }>;
};

export type QboRow = {
  invoiceNo: string;
  customer: string;
  invoiceDate: string;
  dueDate: string;
  description: string;
  quantity: number;
  rateCents: number;
  amountCents: number;
};

/** 2026-09-28 → 09/28/2026. Garbage in, "" out. */
export function qboDate(day: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day ?? "");
  return m ? `${m[2]}/${m[3]}/${m[1]}` : "";
}

/** Rows for the importer, and the invoices it cannot take with the reason. */
export function qboRows(invoices: QboInvoice[]): {
  rows: QboRow[];
  excluded: Array<{ invoiceNo: string; customer: string; reason: string }>;
} {
  const rows: QboRow[] = [];
  const excluded: Array<{ invoiceNo: string; customer: string; reason: string }> = [];
  for (const inv of invoices) {
    const skip = (reason: string) =>
      excluded.push({ invoiceNo: inv.invoiceNo, customer: inv.customer, reason });
    if (inv.lines.length === 0) {
      skip("it has no lines");
      continue;
    }
    if (inv.lines.some((l) => l.amountCents < 0)) {
      skip("it has a credit or discount line, which the QuickBooks importer refuses");
      continue;
    }
    const sum = inv.lines.reduce((s, l) => s + l.amountCents, 0);
    if (sum !== inv.totalCents) {
      // Imported as-is it would post a different total than the customer was
      // billed; better to say so than to put a wrong number in the books.
      skip("its lines do not add up to its total");
      continue;
    }
    if (inv.lines.length > QBO_MAX_ROWS_PER_FILE) {
      skip("it has more lines than one import file can hold");
      continue;
    }
    for (const l of inv.lines) {
      rows.push({
        invoiceNo: inv.invoiceNo,
        customer: inv.customer,
        invoiceDate: qboDate(inv.issuedDay),
        dueDate: qboDate(inv.dueOn ?? inv.issuedDay),
        description: l.description,
        quantity: 1,
        rateCents: l.amountCents,
        amountCents: l.amountCents,
      });
    }
  }
  return { rows, excluded };
}

/** Split rows into files the importer accepts: at most `maxInvoices`
 *  invoices and `maxRows` rows each, never splitting one invoice across two
 *  files. Rows of one invoice must be contiguous, which qboRows guarantees. */
export function splitForImport<T extends { invoiceNo: string }>(
  rows: T[],
  maxInvoices = QBO_MAX_INVOICES_PER_FILE,
  maxRows = QBO_MAX_ROWS_PER_FILE,
): T[][] {
  const files: T[][] = [];
  let current: T[] = [];
  let invoicesInCurrent = 0;
  let i = 0;
  while (i < rows.length) {
    let j = i;
    while (j < rows.length && rows[j].invoiceNo === rows[i].invoiceNo) j++;
    const group = rows.slice(i, j);
    if (
      current.length > 0 &&
      (invoicesInCurrent + 1 > maxInvoices || current.length + group.length > maxRows)
    ) {
      files.push(current);
      current = [];
      invoicesInCurrent = 0;
    }
    current.push(...group);
    invoicesInCurrent += 1;
    i = j;
  }
  if (current.length) files.push(current);
  return files;
}
