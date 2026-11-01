// #654, R2-22 and R2-40: the board and the portal read the business's clock,
// while import rows and payment rows read the browser's, and "overdue" was
// decided on three different days: the device's UTC day on the invoice page,
// Chicago's on the portal, and the business's own on the dashboard.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatDay } from "@/lib/format";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("formatDay with the business's zone", () => {
  // 01:30 UTC on Nov 4 is 8:30 PM on Nov 3 in Chicago and Nov 4 in Berlin.
  const PAID = "2026-11-04T01:30:00Z";
  it("reads an instant on the business's calendar", () => {
    expect(formatDay(PAID, "en-US", "America/Chicago")).toBe("Tue, Nov 3");
    expect(formatDay(PAID, "en-US", "Europe/Berlin")).toBe("Wed, Nov 4");
  });
  it("leaves a date-only value as the day it already is", () => {
    expect(formatDay("2026-11-03", "en-US", "Pacific/Auckland")).toBe("Tue, Nov 3");
  });
});

describe("import and payment rows render in the business's zone", () => {
  const cases: Array<[string, RegExp]> = [
    ["src/routes/_authenticated/imports.index.tsx", /formatDateTime\(b\.created_at, tz\)/],
    ["src/routes/_authenticated/imports.$batchId.tsx", /formatDateTime\(batch\.created_at, tz\)/],
    ["src/components/InvoiceDrawer.tsx", /formatDateTime\(p\.paid_at \?\? p\.created_at, tz\)/],
    [
      "src/routes/_authenticated/invoices.$invoiceId.tsx",
      /formatDateTime\(p\.paid_at \?\? p\.created_at, tz\)/,
    ],
    [
      "src/components/client-detail/billing-panels.tsx",
      /formatDay\(p\.paid_at \?\? p\.created_at, undefined, tz\)/,
    ],
    ["src/components/InvoiceRow.tsx", /Sent \{formatDay\(invoice\.sent_at, undefined, tz\)\}/],
  ];
  for (const [f, re] of cases) it(f, () => expect(read(f)).toMatch(re));
});

describe("overdue is decided on the business's today everywhere", () => {
  it("invoice page", () => {
    const src = read("src/routes/_authenticated/invoices.$invoiceId.tsx");
    expect(src).not.toMatch(/dueOn < new Date\(\)\.toISOString\(\)/);
    expect(src).toMatch(/isInvoiceOverdue\(invoice\.status, dueOn, orgToday\(tz\)\)/);
  });
  it("portal invoices", () => {
    const src = read("src/lib/portal.functions.ts");
    expect(src).toMatch(/overdue: isInvoiceOverdue\(r\.status, due_on, today\)/);
    expect(src).toMatch(/summarizeOpenInvoices\(invoices, today\)/);
  });
  it("AR aging's default as-of day", () => {
    const src = read("src/routes/_authenticated/reports.tsx");
    expect(src).toMatch(/useOrgToday\(\)/);
    expect(src).toMatch(/presetRange\("last30", todayDate\)/);
  });
  it("dashboard (already right; pinned so the three stay together)", () => {
    expect(read("src/lib/dashboard.functions.ts")).toMatch(/const today = orgToday\(\(orgRow/);
  });
});
