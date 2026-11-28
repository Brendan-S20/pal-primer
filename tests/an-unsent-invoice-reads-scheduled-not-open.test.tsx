// An unsent first invoice read "Open" with a due date counted from creation
// (#1042). The label is now "Scheduled" while the invoice is held for a send
// date still ahead; the stored status and the due date are not touched, and
// the Settings copy says what the code does: due_on is set when the invoice is
// CREATED and sending only stamps sent_at.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { invoiceStatusChip } from "@/lib/refund-outcome";
import { InvoiceStatusBadge } from "@/components/InvoiceStatusBadge";

const read = (f: string) => readFileSync(f, "utf8");
const TODAY = "2026-11-24";
const held = { status: "open", sent_at: null };

describe("which open invoices read Scheduled (the org's today is 2026-11-24)", () => {
  it("send_after tomorrow: Scheduled", () => {
    expect(invoiceStatusChip({ ...held, send_after: "2026-11-25" }, TODAY)).toEqual({
      status: "scheduled",
      label: "Scheduled",
    });
  });

  it("send_after a few days out, the first-invoice case: Scheduled", () => {
    expect(invoiceStatusChip({ ...held, send_after: "2026-11-27" }, TODAY).label).toBe("Scheduled");
  });

  it("send_after today: the send date has come, so it is Open", () => {
    expect(invoiceStatusChip({ ...held, send_after: TODAY }, TODAY)).toEqual({ status: "open" });
  });

  it("send_after yesterday and not sent: Open", () => {
    expect(invoiceStatusChip({ ...held, send_after: "2026-11-23" }, TODAY)).toEqual({
      status: "open",
    });
  });

  it("no send_after (a manual invoice): Open", () => {
    expect(invoiceStatusChip({ ...held, send_after: null }, TODAY)).toEqual({ status: "open" });
    expect(invoiceStatusChip({ ...held }, TODAY)).toEqual({ status: "open" });
  });

  it("already sent, even with a send_after still ahead: Open", () => {
    expect(
      invoiceStatusChip(
        { status: "open", sent_at: "2026-11-24T15:00:00Z", send_after: "2026-11-27" },
        TODAY,
      ),
    ).toEqual({ status: "open" });
  });

  it("paid, void and refunded keep what they said", () => {
    const ahead = { sent_at: null, send_after: "2026-11-27" };
    expect(invoiceStatusChip({ ...ahead, status: "paid" }, TODAY)).toEqual({ status: "paid" });
    expect(invoiceStatusChip({ ...ahead, status: "void" }, TODAY)).toEqual({ status: "void" });
    expect(
      invoiceStatusChip(
        { ...ahead, status: "paid", amount_paid_cents: 0, amount_refunded_cents: 2500 },
        TODAY,
      ).label,
    ).toBe("Refunded");
  });

  it("with no today to compare against, nothing reads as scheduled", () => {
    expect(invoiceStatusChip({ ...held, send_after: "2026-11-27" })).toEqual({ status: "open" });
  });
});

describe("the drawer badge", () => {
  const html = (p: Record<string, unknown>) =>
    renderToStaticMarkup(<InvoiceStatusBadge status="open" {...p} />);

  it("says Scheduled when told the invoice is held, Open otherwise", () => {
    expect(html({ scheduled: true })).toContain("Scheduled");
    expect(html({ scheduled: true })).not.toContain("Open");
    expect(html({})).toContain("Open");
  });

  it("the customer pages never pass it, so they still say Open", () => {
    for (const f of ["src/routes/pay.i.$token.tsx", "src/routes/portal.$slug.$token.billing.tsx"]) {
      expect(read(f)).not.toMatch(/scheduled=/);
    }
  });
});

describe("every staff surface asks with the org's today", () => {
  it("the row and the phone card", () => {
    const row = read("src/components/InvoiceRow.tsx");
    // Today is withheld only where there is no address to send to (#1065).
    expect(row.match(/invoiceStatusChip\(invoice, noEmail \? undefined : today\)/g)).toHaveLength(
      2,
    );
    expect(row).not.toMatch(/invoiceStatusChip\(invoice\)/);
  });

  it("the drawer", () => {
    expect(read("src/components/InvoiceDrawer.tsx")).toMatch(
      /scheduled=\{!noEmail && isScheduledToSend\(inv, today\)\}/,
    );
  });

  it("the detail page shows Scheduled on screen and prints the Open it always printed", () => {
    const page = read("src/routes/_authenticated/invoices.$invoiceId.tsx");
    expect(page).toMatch(/invoiceStatusChip\(invoice, noEmail \? undefined : today\)/);
    expect(page).toMatch(/className="print:hidden"/);
    expect(page).toMatch(/className="hidden print:inline-flex"/);
  });
});

describe("sending does not write due_on", () => {
  const senders = [
    "src/routes/email/queue/process.ts",
    "src/routes/api/public/hooks/nightly.ts",
    "src/lib/notifications.functions.ts",
  ];
  it.each(senders)("%s stamps sent_at and nothing else on the invoice", (f) => {
    const src = read(f);
    const stamps = [...src.matchAll(/\.update\(\{\s*sent_at:[^}]*\}\)/g)].map((x) => x[0]);
    expect(stamps.length).toBeGreaterThan(0);
    for (const s of stamps) expect(s).not.toMatch(/due_on/);
  });

  it("no code path updates due_on after the invoice exists", () => {
    // due_on only appears in inserts (newInvoice / create_manual_invoice).
    for (const f of [...senders, "src/lib/visit-completion-invoice.server.ts"]) {
      expect(read(f)).not.toMatch(/\.update\(\{[^}]*due_on/);
    }
  });
});

describe("Settings > Invoicing says when the due date is set", () => {
  const src = read("src/routes/_authenticated/settings.invoicing.tsx");

  it("counted from creation, not from sending", () => {
    expect(src).toMatch(/after the day they're created/);
    expect(src).toMatch(/not after they're sent/);
  });

  it("says some invoices set their own due date, without claiming a full list", () => {
    // Stays (due on the start date, or today for a change, deposit or
    // cancellation fee), payments at online signup (due today) and imported
    // balances (the file's date) do not follow the net-terms default.
    expect(src).toMatch(
      /Some invoices set their own due date, such as pet-sitting stays, payments at online\s+signup and imported balances\./,
    );
    expect(src).not.toMatch(/Invoices paid at online signup are due/);
  });

  it("no longer says sending starts the countdown", () => {
    expect(src).not.toMatch(/after they're sent \(net/);
    expect(src).not.toMatch(/net-terms countdown/);
    expect(src).toMatch(/Sending does\s+not change the due date/);
  });

  it("names the Scheduled label", () => {
    expect(src).toMatch(/Scheduled<\/span>\s*instead of Open/);
  });
});
