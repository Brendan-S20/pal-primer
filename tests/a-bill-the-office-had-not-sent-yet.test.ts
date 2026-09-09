// Money the customer is actually charged.
//
// Three faults, all verified against production before they were changed, all
// in the gap between what a comment promised and what the code beside it did.
//
//  1. Marking an invoice paid out of band left the pay page's PaymentIntent
//     confirmable. The customer could then pay it, and the webhook's guard is
//     `inv.status !== "paid"` -- which this invoice now IS -- so the branch was
//     skipped entirely: no payments row, no receipt, no refund. voidInvoice has
//     cancelled the intent since the day somebody found this on the void path.
//  2. Both portal charge paths carried the comment "net of applied credit (B7)"
//     and neither applied any. `credit_applied_cents` is zero until
//     `apply_credit_to_invoice` has RUN, and only the office screen and the
//     nightly autopay loop ran it -- so the same invoice cost one amount
//     through the office and the gross amount through the customer's own
//     portal, under a header showing the credit balance it was ignoring.
//  3. `portal_list_invoices` had no grace filter, so an invoice the office had
//     not sent yet appeared in the customer's open total with a Pay button.
//     Two live on the day this was written: $30.00 and $25.00, both
//     `send_after` tomorrow, both visible to an active client.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const strip = (s: string) => s.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const SQL = readdirSync(join(root, "supabase/migrations"))
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(root, "supabase/migrations", f), "utf8"))
  .join("\n");

describe("marking an invoice paid closes the door behind it", () => {
  const invoices = strip(read("src/lib/invoices.functions.ts"));

  it("cancels the pay-page intent, as voiding already did", () => {
    // Both handlers set the same condition -- this invoice is no longer
    // collectible through Stripe -- and only one acted on it.
    const marked = invoices.slice(invoices.indexOf("export const bulkMarkInvoicesPaid"));
    const body = marked.slice(0, marked.indexOf("export const", 10));
    expect(body).toMatch(/syncInvoicePaymentIntentAmount\(id\)/);
  });

  it("does not let a Stripe outage block a cheque", () => {
    // The money is already collected; failing to cancel an intent must not
    // fail the operation that records it.
    const marked = invoices.slice(invoices.indexOf("export const bulkMarkInvoicesPaid"));
    const body = marked.slice(0, marked.indexOf("export const", 10));
    const at = body.indexOf("syncInvoicePaymentIntentAmount(id)");
    expect(body.lastIndexOf("try {", at)).toBeGreaterThan(-1);
    expect(body.slice(at)).toMatch(/catch \(e\)/);
  });
});

describe("a portal payment nets the credit the header is showing", () => {
  const portal = strip(read("src/lib/portal.functions.ts"));

  it("applies credit on both charge paths, not just the office's", () => {
    // Saved card and Payment Element. Two paths, one rule.
    expect(portal.match(/apply_credit_to_invoice/g) ?? []).toHaveLength(2);
    const saved = portal.indexOf("portalPayInvoiceWithSavedCard");
    const inline = portal.indexOf("portalCreateInvoicePaymentIntent");
    expect(saved).toBeGreaterThan(-1);
    expect(inline).toBeGreaterThan(-1);
    // One call after each handler starts, before either ends.
    const calls = [...portal.matchAll(/apply_credit_to_invoice/g)].map((m) => m.index!);
    expect(calls.some((i) => i > Math.min(saved, inline) && i < Math.max(saved, inline))).toBe(
      true,
    );
    expect(calls.some((i) => i > Math.max(saved, inline))).toBe(true);
  });

  it("stops rather than charging when the credit covers the whole bill", () => {
    expect(portal).toMatch(/Your account credit covered this invoice/);
    expect(portal.match(/a\.invoice_status === "paid" \|\| dueCents <= 0/g) ?? []).toHaveLength(2);
  });

  it("charges the last known figure rather than failing, if applying credit throws", () => {
    // The fallback can only ever be too HIGH by the credit we failed to apply,
    // which is the behaviour that shipped for months. Throwing a customer out
    // of a payment to avoid it would be a worse trade.
    expect(portal.match(/console\.error\("portal credit application failed"/g) ?? []).toHaveLength(
      2,
    );
  });
});

describe("the portal shows the bills the office has actually sent", () => {
  it("respects the same grace window autopay does", () => {
    const fn = SQL.slice(SQL.lastIndexOf("CREATE OR REPLACE FUNCTION public.portal_list_invoices"));
    const body = fn.slice(0, fn.indexOf("$function$;"));
    expect(body).toMatch(
      /i\.sent_at IS NOT NULL OR i\.send_after IS NULL OR i\.send_after <= current_date/,
    );
  });

  it("keeps drafts and write-offs away from the customer", () => {
    const fn = SQL.slice(SQL.lastIndexOf("CREATE OR REPLACE FUNCTION public.portal_list_invoices"));
    const body = fn.slice(0, fn.indexOf("$function$;"));
    expect(body).toMatch(/i\.status IN \('open', 'paid', 'void'\)/);
  });

  it("says out loud when it had nothing to measure", () => {
    const obs = SQL.slice(SQL.lastIndexOf("DO $exposure$"));
    expect(obs).toMatch(/RAISE WARNING 'no invoices on this build/);
  });
});
