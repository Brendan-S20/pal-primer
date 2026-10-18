import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { invoicePeriodLabel, invoicePeriodLabelCompact } from "@/components/InvoiceRow";

// The invoice table's period column (#497). "Fri, Sep 11 to Fri, Sep 11"
// wrapped onto two lines at 1024 px; the table now says each range in the
// fewest words that are still unambiguous. The phone card keeps the long
// form, so invoicePeriodLabel is pinned as unchanged too.

describe("the compact invoice period", () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-18T12:00:00"));
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it("names one day once", () => {
    expect(invoicePeriodLabelCompact("2026-09-11", "2026-09-11")).toBe("Fri, Sep 11");
  });

  it("names the month once within a month", () => {
    expect(invoicePeriodLabelCompact("2026-10-01", "2026-10-31")).toBe("Oct 1 to 31");
    expect(invoicePeriodLabelCompact("2026-09-01", "2026-09-30")).toBe("Sep 1 to 30");
  });

  it("names both months across a month", () => {
    expect(invoicePeriodLabelCompact("2026-09-28", "2026-10-04")).toBe("Sep 28 to Oct 4");
  });

  it("names both years across a year", () => {
    expect(invoicePeriodLabelCompact("2025-12-29", "2026-01-04")).toBe(
      "Dec 29, 2025 to Jan 4, 2026",
    );
  });

  it("adds a year that is not this one at the end", () => {
    expect(invoicePeriodLabelCompact("2025-09-01", "2025-09-30")).toBe("Sep 1 to 30, 2025");
    expect(invoicePeriodLabelCompact("2025-09-28", "2025-10-04")).toBe("Sep 28 to Oct 4, 2025");
    expect(invoicePeriodLabelCompact("2025-09-11", "2025-09-11")).toBe("Thu, Sep 11, 2025");
  });

  it("falls back to the long label when an end is missing", () => {
    expect(invoicePeriodLabelCompact("2026-09-11", null)).toBe(
      invoicePeriodLabel("2026-09-11", null),
    );
    expect(invoicePeriodLabelCompact(null, "2026-09-11")).toBe(
      invoicePeriodLabel(null, "2026-09-11"),
    );
    expect(invoicePeriodLabelCompact(null, null)).toBe("-");
  });

  it("says to, never a dash", () => {
    const label = invoicePeriodLabelCompact("2026-09-28", "2026-10-04");
    const dashes = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
    expect(label).not.toMatch(dashes);
    expect(label).toContain(" to ");
  });
});
