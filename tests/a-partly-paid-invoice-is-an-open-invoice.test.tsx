// A partly paid invoice is an open invoice.
//
// The owner's pick for partial payments (PR #463): no "Partially paid" filter
// and no new status. An invoice with money on it and a balance left stays
// `open`, appears under the Open filter with every other open invoice, and
// carries a "Partially paid" label there so the office can tell it apart.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => () => undefined }));
vi.mock("@/hooks/useOrgToday", () => ({
  useOrgToday: () => "2026-10-15",
  useOrgTimezone: () => "America/Chicago",
}));

import { InvoiceCard, InvoiceRow, type InvoiceRowData } from "@/components/InvoiceRow";
import { isPartiallyPaid } from "@/lib/ar";

const ROOT = join(import.meta.dirname, "..");
const page = readFileSync(join(ROOT, "src/routes/_authenticated/invoices.index.tsx"), "utf8");

const PARTLY: InvoiceRowData = {
  id: "16000000-0000-4000-8000-0000000000d1",
  status: "open",
  currency: "usd",
  total_cents: 8000,
  credit_applied_cents: 0,
  amount_paid_cents: 6000,
  period_start: "2026-09-01",
  period_end: "2026-09-30",
  due_on: "2026-10-30",
  clients: { display_name: "Field Customer" },
};

describe("the Invoices status filter", () => {
  it("offers the invoice statuses and nothing for partly paid", () => {
    const m = /const STATUSES = \[([^\]]*)\] as const;/.exec(page);
    expect(m, "STATUSES").not.toBeNull();
    const statuses = [...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    expect(statuses).toEqual(["draft", "open", "paid", "void", "uncollectible"]);
    expect(statuses.some((s) => /partial/i.test(s))).toBe(false);
    // The buttons are drawn from that list and nothing else.
    expect(page).toMatch(/\(\["all", \.\.\.STATUSES\] as StatusKey\[\]\)\.map/);
  });

  it("filters on the stored status, so a partly paid invoice is under Open", () => {
    expect(page).toContain('if (status !== "all" && inv.status !== status) return false;');
    expect(isPartiallyPaid(PARTLY)).toBe(true);
    const underOpen = [PARTLY, { ...PARTLY, id: "paid", status: "paid" }].filter(
      (inv) => inv.status === "open",
    );
    expect(underOpen.map((i) => i.id)).toEqual([PARTLY.id]);
  });
});

describe("under Open, it says it is partly paid", () => {
  it("on the phone card", () => {
    const html = renderToStaticMarkup(<InvoiceCard invoice={PARTLY} onOpen={() => {}} />);
    expect(html).toContain(">Partially paid<");
    expect(html).toContain("$20.00 due");
  });

  it("in the table row", () => {
    const html = renderToStaticMarkup(
      <table>
        <tbody>
          <InvoiceRow invoice={PARTLY} showClient onOpen={() => {}} />
        </tbody>
      </table>,
    );
    expect(html).toContain(">Partially paid<");
    expect(html).toContain("$20.00 due");
  });

  it("and not on an open invoice with nothing paid", () => {
    const html = renderToStaticMarkup(
      <InvoiceCard invoice={{ ...PARTLY, amount_paid_cents: 0 }} onOpen={() => {}} />,
    );
    expect(html).not.toContain("Partially paid");
  });
});
