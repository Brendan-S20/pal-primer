// A double click made two invoices, and two emails (#607).
//
// createManualInvoice had no way to tell a second click, or a retry after a
// lost response, from a new invoice: each one took a number and each one was
// emailed. And the email that went out said only an amount: no invoice
// number, no due date, nothing about what it was for.
//
// The fix: the dialog sends one creation key with every attempt, the database
// holds it unique per organization, create_manual_invoice returns the invoice
// a key already made, and the dialog's email queues under a message id derived
// from the invoice, which the queue processor and Resend each send once.
// (It used to claim sent_at before queueing; #612 moved sent_at to the
// provider's acceptance, see tests/sent-means-the-provider-took-it.test.ts.)
// The real-Postgres half is tests/integration/a-double-click-made-two-invoices.db.test.ts.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { render } from "react-email";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TEMPLATES } from "@/lib/email-templates/registry";
import { invoiceEmailDetails, EMAIL_LINE_LIMIT } from "@/lib/invoice-email-details";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const strip = (s: string) => s.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

const MIGRATION = "supabase/migrations/20261030120000_a-double-click-made-two-invoices.sql";

describe("one key, one invoice", () => {
  const page = strip(read("src/routes/_authenticated/invoices.index.tsx"));
  const dialog = page.slice(
    page.indexOf("function NewInvoiceDialog"),
    page.indexOf("function UninvoicedWorkList"),
  );

  it("the dialog sends the same key with every attempt", () => {
    expect(dialog).toMatch(/useState\(\(\) => crypto\.randomUUID\(\)\)/);
    expect(dialog).toMatch(
      /createFn\(\{ data: \{ clientId, items: parsedItems, creationKey \} \}\)/,
    );
    // A new key only once an invoice is made, or for another client.
    const onSuccess = dialog.slice(dialog.indexOf("onSuccess:"), dialog.indexOf("onError:"));
    expect(onSuccess).toMatch(/setCreationKey\(crypto\.randomUUID\(\)\)/);
  });

  it("the button cannot start a second request while one is in flight", () => {
    expect(dialog).toMatch(/disabled=\{[^}]*createM\.isPending/);
    expect(dialog).toMatch(/if \(createM\.isPending \|\| submitting\.current\) return;/);
    expect(dialog).toMatch(/onSettled: \(\) => \{\s*submitting\.current = false;/);
  });

  it("the server answers a key it has seen with the invoice it made", () => {
    const fns = strip(read("src/lib/invoices.functions.ts"));
    const create = fns.slice(
      fns.indexOf("export const createManualInvoice"),
      fns.indexOf("export const listUninvoicedWork"),
    );
    expect(fns).toMatch(/creationKey: z\.string\(\)\.uuid\(\)\.optional\(\)/);
    expect(create).toMatch(/\.eq\("creation_key", data\.creationKey\)/);
    expect(create).toMatch(/creationKey: data\.creationKey/);
    // Found before insertManualInvoice, so it logs no second activity line.
    expect(create.indexOf('eq("creation_key"')).toBeLessThan(
      create.indexOf("insertManualInvoice("),
    );
    expect(read("src/lib/manual-invoice.server.ts")).toMatch(
      /creation_key: p\.creationKey \?\? null/,
    );
  });

  it("the database holds the key unique per organization and returns the first invoice", () => {
    const sql = read(MIGRATION);
    expect(sql).toMatch(
      /ADD CONSTRAINT invoices_creation_key_unique UNIQUE \(organization_id, creation_key\)/,
    );
    // Two requests at once: the loser's insert is undone in its own block,
    // so it takes no number, and it returns the winner's id.
    expect(sql).toMatch(
      /EXCEPTION WHEN unique_violation THEN[\s\S]*?'invoices_creation_key_unique'[\s\S]*?RAISE;[\s\S]*?RETURN _id;/,
    );
    expect(sql).toMatch(
      /FUNCTION public\.create_manual_invoice\(_invoice jsonb, _lines jsonb\)[\s\S]*?SECURITY INVOKER/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.create_manual_invoice\(jsonb, jsonb\) TO authenticated, service_role/,
    );
  });
});

describe("one invoice, one email", () => {
  const send = strip(read("src/lib/notifications.functions.ts"));

  it("the dialog asks for a first send", () => {
    const page = strip(read("src/routes/_authenticated/invoices.index.tsx"));
    expect(page).toMatch(/emailFn\(\{ data: \{ invoiceId: r\.invoiceId, firstSend: true \} \}\)/);
  });

  it("a first send is once per invoice, and never stamps sent_at on queueing", () => {
    expect(send).toMatch(/idempotencyKey: data\.reminder[\s\S]*?: invoiceSendKey\(inv\.id\)/);
    expect(send).toMatch(/oncePerKey: firstSend,/);
    expect(send).toMatch(/alreadySent: true/);
    expect(send).toMatch(/if \(res\.reason === "already_sent"\)/);
    expect(send).not.toMatch(/\.update\(\{ sent_at/);
  });
});

describe("the email says which invoice, when it is due, and what it is for", () => {
  const details = invoiceEmailDetails(
    { id: "11111111-1111-4111-8111-111111111111", number: 1001, due_on: "2026-11-14" },
    [
      {
        description: "Weekly cleanup on 2026-10-30",
        quantity: 1,
        unit_amount_cents: null,
        amount_cents: 2_500,
      },
      { description: "Gate fee", quantity: "2", unit_amount_cents: 500, amount_cents: 1_000 },
    ],
  );

  it("builds the number, the due date and the lines", () => {
    expect(details).toEqual({
      invoiceLabel: "INV-1001",
      dueLabel: "Nov 14, 2026",
      lines: [
        {
          description: "Weekly cleanup on Oct 30, 2026",
          quantity: 1,
          unitAmountCents: null,
          amountCents: 2_500,
        },
        { description: "Gate fee", quantity: 2, unitAmountCents: 500, amountCents: 1_000 },
      ],
    });
  });

  it("renders INV-1001 · due <date> and every line", async () => {
    const html = await render(
      createElement(TEMPLATES["invoice-sent"].component, {
        orgName: "Detroit Doo Disposal",
        amountCents: 3_500,
        invoiceUrl: "https://x/pay",
        ...details,
      }),
    );
    expect(html).toContain("INV-1001 · due Nov 14, 2026");
    expect(html).toContain("Weekly cleanup on Oct 30, 2026");
    expect(html).toContain("$25.00");
    expect(html).toContain("Gate fee");
    expect(html).toMatch(/2(<!-- -->)? × (<!-- -->)?\$5\.00/);
    expect(html).toContain("$10.00");
    expect(html).not.toContain(String.fromCharCode(0x2014));
  });

  it("puts the number in the subject", () => {
    const subject = TEMPLATES["invoice-sent"].subject({
      ...details,
      amountCents: 3_500,
      orgName: "Acme",
    });
    expect(subject).toBe("Invoice INV-1001 $35.00 from Acme");
  });

  it("a long invoice lists the first lines and says how many more", async () => {
    const rows = Array.from({ length: EMAIL_LINE_LIMIT + 3 }, (_, i) => ({
      description: `Visit ${i + 1}`,
      amount_cents: 100,
    }));
    const long = invoiceEmailDetails({ id: "x", number: 7, due_on: null }, rows);
    expect(long.lines).toHaveLength(EMAIL_LINE_LIMIT);
    expect(long.moreLines).toBe(3);
    expect(long.dueLabel).toBeUndefined();
    const html = await render(
      createElement(TEMPLATES["invoice-sent"].component, { amountCents: 2_800, ...long }),
    );
    expect(html).toContain("and 3 more lines on the invoice");
  });

  it("both senders pass it", () => {
    for (const file of [
      "src/lib/notifications.functions.ts",
      "src/routes/api/public/hooks/nightly.ts",
    ]) {
      const src = read(file);
      expect(src, file).toMatch(/\.\.\.invoiceEmailDetails\(inv, lineRows \?\? \[\]\)/);
      expect(src, file).toMatch(/"id, number, due_on, /);
    }
  });
});
