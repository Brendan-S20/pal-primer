// An owner sees what each service earns (#410).
//
// /reports gains "Revenue by service": invoice lines before tax, grouped by
// the service of the visit they bill (or of the plan, for a line with no
// visit), on the invoices the Billed tile counts. It is drawn only for a
// business that sells more than one service or runs a line other than pet
// waste, so a pet-waste-only report is exactly what it was. It is its own
// server function and its own query, so reports.functions.ts is unchanged.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  OTHER_CHARGES,
  revenueByService,
  showsRevenueByService,
} from "@/lib/revenue-by-service";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const TZ = "America/Chicago";
const inv = (id: string, issued_at: string | null, status = "open") => ({ id, status, issued_at });

describe("the grouping", () => {
  const invoices = [
    inv("i1", "2026-10-05T15:00:00Z"),
    inv("i2", "2026-10-06T15:00:00Z", "paid"),
    inv("void", "2026-10-06T15:00:00Z", "void"),
    inv("draft", "2026-10-06T15:00:00Z", "draft"),
    inv("late", "2026-11-02T15:00:00Z"),
  ];
  const lines = [
    { invoice_id: "i1", amount_cents: 3000, visit_id: "walk-1", subscription_id: "s-walk" },
    { invoice_id: "i1", amount_cents: 3000, visit_id: "walk-2", subscription_id: "s-walk" },
    { invoice_id: "i2", amount_cents: 2400, visit_id: "scoop-1", subscription_id: "s-scoop" },
    // A prepaid line: no visit, the plan says what it was.
    { invoice_id: "i2", amount_cents: 6000, visit_id: null, subscription_id: "s-walk" },
    // A surcharge or hand-typed line.
    { invoice_id: "i2", amount_cents: 500, visit_id: null, subscription_id: null },
    { invoice_id: "void", amount_cents: 9999, visit_id: "walk-1", subscription_id: null },
    { invoice_id: "draft", amount_cents: 9999, visit_id: "walk-1", subscription_id: null },
    { invoice_id: "late", amount_cents: 9999, visit_id: "walk-1", subscription_id: null },
  ];
  const rows = revenueByService({
    lines,
    invoices,
    from: "2026-10-01",
    to: "2026-10-31",
    timezone: TZ,
    visitService: new Map([
      ["walk-1", "svc-walk"],
      ["walk-2", "svc-walk"],
      ["scoop-1", "svc-scoop"],
    ]),
    subscriptionService: new Map([
      ["s-walk", "svc-walk"],
      ["s-scoop", "svc-scoop"],
    ]),
    serviceName: new Map([
      ["svc-walk", "30-minute walk"],
      ["svc-scoop", "Pet waste removal"],
    ]),
  });

  it("sums each service's lines, biggest first, other charges last", () => {
    expect(rows).toEqual([
      { serviceId: "svc-walk", name: "30-minute walk", cents: 12000, lines: 3 },
      { serviceId: "svc-scoop", name: "Pet waste removal", cents: 2400, lines: 1 },
      { serviceId: null, name: OTHER_CHARGES, cents: 500, lines: 1 },
    ]);
  });

  it("counts only invoices billed in the range: no void, no draft, none outside it", () => {
    expect(rows.reduce((s, r) => s + r.cents, 0)).toBe(14900);
  });
});

describe("who sees it", () => {
  it("not a business selling one pet-waste service", () => {
    expect(showsRevenueByService(1, ["pet_waste"])).toBe(false);
    expect(showsRevenueByService(0, null)).toBe(false);
  });

  it("a business with two services, or any line other than pet waste", () => {
    expect(showsRevenueByService(2, ["pet_waste"])).toBe(true);
    expect(showsRevenueByService(1, ["dog_walking"])).toBe(true);
    expect(showsRevenueByService(1, ["pet_waste", "dog_walking"])).toBe(true);
  });
});

describe("the wiring", () => {
  it("is its own server function, on view_financials, and reports.functions.ts is untouched by it", () => {
    const fn = read("src/lib/revenue-by-service.functions.ts");
    expect(fn).toMatch(/requirePermission\(supabase, context\.userId, "view_financials"\)/);
    expect(fn).toMatch(/return \{ show: false as const, rows: \[\] \}/);
    expect(read("src/lib/reports.functions.ts")).not.toMatch(/revenue-by-service|RevenueByService/);
  });

  it("the page draws the card, which draws nothing unless the server says show", () => {
    expect(read("src/routes/_authenticated/reports.tsx")).toMatch(
      /<RevenueByServiceCard from=\{applied\.from\} to=\{applied\.to\} \/>/,
    );
    expect(read("src/components/reports/RevenueByServiceCard.tsx")).toMatch(
      /if \(!q\.data\?\.show\) return null;/,
    );
  });
});
