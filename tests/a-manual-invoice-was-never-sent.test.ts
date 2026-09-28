// A manual invoice was never sent.
//
// "New invoice" created the invoice Open and navigated to it, and that was
// all. Nothing emailed it: the nightly auto-send only picks up invoices with a
// `send_after`, which the billing run stamps and a manual invoice never has.
// So the customer heard nothing until somebody found the Send button, and the
// invoice sat in "Open" looking exactly like one that had been sent.
//
// And its dates were the UTC day. Created at 8 PM in California, it was dated
// tomorrow and fell due a day late.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addDaysToDay } from "@/lib/reclean";
import { orgToday } from "@/lib/org-day";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const strip = (s: string) => s.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

const fns = strip(read("src/lib/invoices.functions.ts"));
const create = fns.slice(
  fns.indexOf("export const createManualInvoice"),
  fns.indexOf("export const voidInvoice"),
);
const page = strip(read("src/routes/_authenticated/invoices.index.tsx"));
const dialog = page.slice(
  page.indexOf("function NewInvoiceDialog"),
  page.indexOf("function StatCard"),
);

describe("the dialog sends what it creates", () => {
  it("emails the invoice after creating it, when asked to", () => {
    const mut = dialog.slice(dialog.indexOf("mutationFn:"), dialog.indexOf("onSuccess:"));
    expect(mut).toMatch(/await createFn\(/);
    expect(mut).toMatch(/await emailFn\(\{ data: \{ invoiceId: r\.invoiceId \} \}\)/);
    // Created first, then emailed: never an email for an invoice that failed.
    expect(mut.indexOf("createFn(")).toBeLessThan(mut.indexOf("emailFn("));
  });

  it("does not turn a failed email into a failed invoice", () => {
    // If the email error escaped the mutation, the dialog would stay open
    // saying the invoice failed, and pressing the button again would create a
    // SECOND invoice. The email is caught and reported alongside success.
    const mut = dialog.slice(dialog.indexOf("mutationFn:"), dialog.indexOf("onSuccess:"));
    expect(mut).toMatch(/try \{\s*await emailFn/);
    expect(mut).toMatch(/emailed: \{ ok: false/);
    expect(dialog).toMatch(/Invoice created, but it was not emailed/);
  });

  it("defaults to sending, and cannot claim to send to a client with no address", () => {
    expect(dialog).toMatch(/useState\(true\)/);
    expect(dialog).toMatch(/const willEmail = sendNow && !!pickedEmail/);
    expect(dialog).toMatch(/disabled=\{!pickedEmail\}/);
    expect(dialog).toMatch(/"Create and send"/);
  });
});

describe("the invoice is dated in the organization's day", () => {
  it("uses the org's timezone, not the server's UTC day", () => {
    expect(create).toMatch(/select\("invoice_net_days, timezone"\)/);
    expect(create).toMatch(/const today = orgToday\(/);
    expect(create).toMatch(/const dueOn = addDaysToDay\(today, netDays\)/);
    expect(create).not.toMatch(/nowIso\.slice\(0, 10\)/);
    expect(create).not.toMatch(/Date\.now\(\) \+ netDays/);
  });

  it("which is a different day for the evening that used to be wrong", () => {
    // 8 PM Pacific on Sep 28 is 03:00 UTC on Sep 29.
    const evening = new Date("2026-09-29T03:00:00Z");
    expect(evening.toISOString().slice(0, 10)).toBe("2026-09-29");
    const today = orgToday("America/Los_Angeles", evening);
    expect(today).toBe("2026-09-28");
    expect(addDaysToDay(today, 15)).toBe("2026-10-13");
  });
});
