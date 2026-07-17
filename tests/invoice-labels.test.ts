import { describe, expect, it } from "vitest";
import { invoiceKindLabel, formatLineItemDescription } from "@/lib/invoice-labels";
import { formatDay } from "@/lib/format";

// QA round 3, C6.2 + I3: one shared helper maps the invoice_kind enum to human
// copy so no surface (drawer, list row, portal) shows "prepaid_topup" raw.
describe("invoiceKindLabel", () => {
  it("humanizes the known invoice kinds", () => {
    expect(invoiceKindLabel("prepaid_topup")).toBe("Prepaid top-up");
    expect(invoiceKindLabel("postpaid")).toBe("Service");
  });

  it("never returns the raw enum for a known kind", () => {
    expect(invoiceKindLabel("prepaid_topup")).not.toContain("_");
  });

  it("sentence-cases unknown kinds instead of leaking snake_case", () => {
    expect(invoiceKindLabel("some_new_kind")).toBe("Some new kind");
  });

  it("returns an empty string for null/undefined", () => {
    expect(invoiceKindLabel(null)).toBe("");
    expect(invoiceKindLabel(undefined)).toBe("");
  });
});

// QA round 3, C6.1: line-item descriptions store canonical ISO dates (baked in
// the generation RPCs). They must render humanized ("Thu, Jul 16"), for both
// new rows and legacy rows, across every description shape.
describe("formatLineItemDescription", () => {
  it("humanizes a prepaid-service ISO date", () => {
    expect(formatLineItemDescription("Prepaid service on 2026-07-16")).toBe(
      `Prepaid service on ${formatDay("2026-07-16")}`,
    );
    expect(formatLineItemDescription("Prepaid service on 2026-07-16")).not.toContain("2026-07-16");
  });

  it("humanizes a postpaid 'Service on' line with a trailing address", () => {
    expect(formatLineItemDescription("Service on 2026-07-16 - 412 Congress Ave")).toBe(
      `Service on ${formatDay("2026-07-16")} - 412 Congress Ave`,
    );
  });

  it("humanizes a skipped-visit line", () => {
    expect(formatLineItemDescription("Skipped visit 2026-07-09 (weather)")).toBe(
      `Skipped visit ${formatDay("2026-07-09")} (weather)`,
    );
  });

  it("humanizes an add-on line with a parenthesized date and quantity", () => {
    expect(formatLineItemDescription("Deep clean (2026-07-01) x 2")).toBe(
      `Deep clean (${formatDay("2026-07-01")}) x 2`,
    );
  });

  it("leaves descriptions without a date untouched", () => {
    expect(formatLineItemDescription("One-time cleanup")).toBe("One-time cleanup");
  });

  it("humanizes multiple dates in one description", () => {
    expect(formatLineItemDescription("Service 2026-07-16 and 2026-07-23")).toBe(
      `Service ${formatDay("2026-07-16")} and ${formatDay("2026-07-23")}`,
    );
  });

  it("does not mangle a date embedded in a longer digit run", () => {
    // (?<!\d)/(?!\d) boundaries: an id that happens to contain a date-like
    // substring must be left alone rather than partially rewritten.
    expect(formatLineItemDescription("Order 12026-07-16")).toBe("Order 12026-07-16");
    expect(formatLineItemDescription("ref 2026-07-1600")).toBe("ref 2026-07-1600");
  });

  it("passes a malformed date through unchanged", () => {
    // formatDay can't parse it, so the original text is preserved.
    expect(formatLineItemDescription("Service on 2026-13-45")).toBe("Service on 2026-13-45");
  });

  it("returns an empty string for null/undefined", () => {
    expect(formatLineItemDescription(null)).toBe("");
    expect(formatLineItemDescription(undefined)).toBe("");
  });
});
