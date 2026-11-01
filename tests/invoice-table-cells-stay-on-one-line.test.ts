import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// #497: at 1024 to 1032 px the invoice table wrapped "INV-1037", the period
// and the due date (with its Overdue chip) onto two or three lines, so every
// row was tall and the column was hard to scan. Those three cells, and their
// headers on both tables that render InvoiceRow, are `whitespace-nowrap`; the
// client column is the one that gives way, by truncating.

const read = (p: string) => readFileSync(p, "utf8");

function cellClassContaining(src: string, needle: string): string | null {
  for (const m of src.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/g)) {
    if (!m[2].includes(needle)) continue;
    return m[1].match(/className="([^"]*)"/)?.[1] ?? "";
  }
  return null;
}

function headerClass(src: string, label: string): string | null {
  const m = src.match(new RegExp(`<th\\b[^>]*className="([^"]*)"[^>]*>\\s*${label}\\s*</th>`));
  return m ? m[1] : null;
}

describe("the invoice row keeps its number, period and due date on one line", () => {
  const row = read("src/components/InvoiceRow.tsx");

  it.each([
    ["Invoice", "invoiceNumberLabel(invoice)"],
    ["Period", "invoicePeriodLabelCompact(invoice.period_start, invoice.period_end)"],
    ["Due", "formatDay(invoice.due_on)"],
  ])("the %s cell is whitespace-nowrap", (_name, needle) => {
    const cls = cellClassContaining(row, needle);
    expect(cls, `no <td> in InvoiceRow renders ${needle}`).not.toBeNull();
    expect(cls!.split(/\s+/)).toContain("whitespace-nowrap");
  });

  it("the client cell truncates with the full name as a title", () => {
    // The checkbox cell names the client in its aria-label; this is the
    // cell that prints it.
    const cls = cellClassContaining(row, '{client?.display_name ?? "-"}');
    expect(cls).not.toBeNull();
    expect(cls!.split(/\s+/)).toEqual(expect.arrayContaining(["w-full", "max-w-0"]));
    expect(row).toMatch(/className="truncate" title=\{client\?\.display_name/);
  });

  it("the client cell has a floor, so 1024 px does not squeeze names to 'Paloma P...'", () => {
    // `w-full max-w-0` alone let the other columns take everything: the
    // client cell came out about 80 px wide at 1024 px. 9rem is enough for
    // "Emily & Marc Johnson" to read mostly in full.
    const cls = cellClassContaining(row, '{client?.display_name ?? "-"}');
    expect(cls).not.toBeNull();
    expect(cls!.split(/\s+/)).toContain("min-w-36");
  });

  it("the kind chip is hidden below xl, like the scheduled and sent chips", () => {
    expect(row).toMatch(
      /<MetaChip className="[^"]*\bmax-xl:hidden\b[^"]*">\s*\{invoiceKindLabel\(invoice\.kind\)\}/,
    );
  });

  // PR #513 review: "Scheduled to send" matters on an open invoice, so below
  // xl the hidden chip is replaced by a clock icon that still says it.
  describe("below xl a scheduled send is a clock icon with the full text", () => {
    it("the label is the full 'Scheduled to send <date>' text", () => {
      expect(row).toMatch(
        /const scheduledLabel =[\s\S]*?`Scheduled to send \$\{formatDay\(invoice\.send_after\)\}`/,
      );
    });

    it("the chip is still hidden below xl and shown from xl up", () => {
      expect(row).toMatch(
        /<MetaChip className="[^"]*\bmax-xl:hidden\b[^"]*">\s*\{scheduledLabel\}\s*<\/MetaChip>/,
      );
    });

    it("the icon is shown only below xl, labelled for a screen reader and in its title", () => {
      const m = row.match(/<span\b([^>]*)>\s*<Clock\b([^>]*)\/>\s*<\/span>/);
      expect(m, "no <span> wrapping a <Clock> in InvoiceRow").not.toBeNull();
      const [, wrapper, icon] = m!;
      expect(wrapper).toMatch(/role="img"/);
      expect(wrapper).toMatch(/aria-label=\{scheduledLabel\}/);
      expect(wrapper).toMatch(/title=\{scheduledLabel\}/);
      expect(wrapper.match(/className="([^"]*)"/)?.[1].split(/\s+/)).toContain("xl:hidden");
      expect(icon.match(/className="([^"]*)"/)?.[1].split(/\s+/)).toEqual(
        expect.arrayContaining(["h-4", "w-4", "shrink-0"]),
      );
      expect(icon).toMatch(/aria-hidden="true"/);
    });

    it("the sent chip stays hidden below xl with no stand-in", () => {
      expect(row).toMatch(
        /<MetaChip className="[^"]*\bmax-xl:hidden\b[^"]*">\s*Sent \{formatDay\(invoice\.sent_at, undefined, tz\)\}/,
      );
      expect(row.match(/<Clock\b/g)).toHaveLength(1);
    });

    it("the status cell stays on one line below xl", () => {
      const cls = cellClassContaining(row, "<StatusChip status={invoice.status}");
      expect(cls).not.toBeNull();
      expect(cls!.split(/\s+/)).toContain("whitespace-nowrap");
      expect(row).toMatch(
        /className="inline-flex flex-wrap items-center gap-1\.5 max-xl:flex-nowrap"/,
      );
    });
  });
});

describe.each([
  "src/routes/_authenticated/invoices.index.tsx",
  "src/components/client-detail/billing-panels.tsx",
])("%s", (file) => {
  const src = read(file);

  it.each(["Invoice", "Period", "Due"])("the %s header is whitespace-nowrap", (label) => {
    const cls = headerClass(src, label);
    expect(cls, `no <th> labelled ${label} in ${file}`).not.toBeNull();
    expect(cls!.split(/\s+/)).toContain("whitespace-nowrap");
  });
});
