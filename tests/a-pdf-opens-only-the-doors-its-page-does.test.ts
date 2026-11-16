// A PDF opens only the doors its page does.
//
// Every "Download PDF" is a second way to read a document, and a second way
// in is exactly where an access rule gets forgotten. So nothing here is a new
// rule; each entry point in src/lib/document-pdf.server.ts is held to the gate
// its page already passes:
//
//   * the customer's quote link answers a DRAFT exactly as it answers a
//     mistyped token: nothing. It reads through public_quote_document, never
//     the quotes table, and refuses a draft itself as well;
//   * the pay link answers an unknown token with nothing, and leaves the
//     customer's email off, as getPublicInvoice does;
//   * the office needs manage_client_billing (a technician and a dispatcher
//     are refused before a single invoice or quote row is read), and gets only
//     its own org's documents;
//   * the portal gets only its own client's invoices;
//   * the invoice email carries the PDF, drawn only when the email is going,
//     and still goes when the PDF cannot be drawn.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { repoRelative } from "./support/repo-paths";

vi.mock("@/lib/impersonation-session.server", () => ({
  assertImpersonationSessionActive: async () => {},
}));

// enqueueAppEmail's service-role client, swapped per test below.
const adminHolder: { current: any } = { current: null };
vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    return adminHolder.current;
  },
}));

import {
  pdfResponse,
  portalInvoicePdf,
  publicInvoicePdf,
  publicQuotePdf,
  staffInvoicePdf,
  staffQuotePdf,
} from "@/lib/document-pdf.server";
import { enqueueAppEmail } from "@/lib/email/enqueue.server";
import { resendAttachments } from "@/lib/email/attachments";
import { pdfText } from "./helpers/pdf-text";

type Row = Record<string, any>;

/** Just enough of supabase-js: filters by equality, records what was read. */
function fakeDb(
  tables: Record<string, Row[]>,
  opts: {
    rpc?: (name: string, args: any) => { data: any; error: any };
    forbid?: string[];
  } = {},
) {
  const reads: string[] = [];
  const inserts: Array<{ table: string; row: any }> = [];
  const rpcs: Array<{ name: string; args: any }> = [];
  const db = {
    reads,
    inserts,
    rpcs,
    from(table: string) {
      if (opts.forbid?.includes(table)) throw new Error(`read of ${table} on this path`);
      reads.push(table);
      let rows = [...(tables[table] ?? [])];
      const q: any = {
        select: () => q,
        eq: (c: string, v: unknown) => {
          rows = rows.filter((r) => r[c] === v);
          return q;
        },
        in: (c: string, vs: unknown[]) => {
          rows = rows.filter((r) => vs.includes(r[c]));
          return q;
        },
        is: () => q,
        order: () => q,
        limit: () => q,
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        single: async () =>
          rows[0] ? { data: rows[0], error: null } : { data: null, error: { message: "0 rows" } },
        insert: async (row: any) => {
          inserts.push({ table, row });
          return { error: null };
        },
        // enqueueAppEmail mints the unsubscribe token with an upsert (#275).
        upsert: async () => ({ error: null }),
        update: () => q,
        then: (res: any, rej: any) => Promise.resolve({ data: rows, error: null }).then(res, rej),
      };
      return q;
    },
    async rpc(name: string, args: any) {
      rpcs.push({ name, args });
      return opts.rpc ? opts.rpc(name, args) : { data: null, error: null };
    },
  };
  return db;
}

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const CLIENT = "33333333-3333-4333-8333-333333333333";
const OTHER_CLIENT = "44444444-4444-4444-8444-444444444444";
const INVOICE = "55555555-5555-4555-8555-555555555555";
const FOREIGN_INVOICE = "66666666-6666-4666-8666-666666666666";
const QUOTE = "77777777-7777-4777-8777-777777777777";
const PAY_TOKEN = "88888888-8888-4888-8888-888888888888";
const UNKNOWN = "99999999-9999-4999-8999-999999999999";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const org = {
  name: "Doo Right Pet Services",
  timezone: "America/Chicago",
  contact_email: "office@dooright.example.com",
  contact_phone: "7343093494",
  contact_address: null,
};

function invoiceRow(over: Row = {}): Row {
  return {
    id: INVOICE,
    number: 1042,
    organization_id: ORG,
    client_id: CLIENT,
    status: "open",
    currency: "usd",
    subtotal_cents: 4500,
    total_cents: 4500,
    credit_applied_cents: 0,
    period_start: "2026-09-01",
    period_end: "2026-09-30",
    issued_at: "2026-09-30T23:30:00Z",
    paid_at: null,
    due_on: "2026-10-15",
    public_token: PAY_TOKEN,
    stripe_payment_intent_id: null,
    stripe_checkout_session_id: null,
    organizations: org,
    clients: { display_name: "Jane Q. Customer", primary_email: "jane.customer@example.com" },
    ...over,
  };
}

function billingTables(role: string): Record<string, Row[]> {
  return {
    user_roles: [{ user_id: USER, organization_id: ORG, role }],
    invoices: [
      invoiceRow(),
      invoiceRow({ id: FOREIGN_INVOICE, organization_id: OTHER_ORG, client_id: OTHER_CLIENT }),
    ],
    invoice_line_items: [
      {
        invoice_id: INVOICE,
        description: "Weekly service",
        amount_cents: 4500,
        quantity: 3,
        unit_amount_cents: 1500,
      },
    ],
    payments: [],
    quotes: [
      {
        id: QUOTE,
        organization_id: ORG,
        number: 1001,
        status: "draft",
        title: "Spring clean-up",
        message: null,
        valid_until: "2026-10-30",
        public_token: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        sent_at: null,
        accepted_at: null,
        declined_at: null,
        accepted_name: null,
        client_id: null,
        prospect_name: "Pat Prospect",
        prospect_email: "pat@example.com",
        clients: null,
      },
    ],
    quote_line_items: [
      {
        quote_id: QUOTE,
        description: "Initial clean-up",
        quantity: 1,
        unit_amount_cents: 7500,
        amount_cents: 7500,
        recurring: false,
      },
    ],
    organizations: [{ id: ORG, ...org, currency: "usd" }],
  };
}

const isPdf = (bytes: Uint8Array) => Buffer.from(bytes.slice(0, 5)).toString("latin1") === "%PDF-";

// ── The customer's quote link ──────────────────────────────────────────────

const QUOTE_TOKENS = {
  draft: "cccccccc-0000-4000-8000-000000000001",
  sent: "cccccccc-0000-4000-8000-000000000002",
};

/** public_quote_document as the migration writes it: NULL for a draft and for
 *  an unknown token alike. See 20260928170000_a-bid-had-nothing-to-accept.sql. */
function quoteRpc(statusByToken: Record<string, string>) {
  return (name: string, args: { _token: string }) => {
    expect(name).toBe("public_quote_document");
    const status = statusByToken[args._token];
    if (!status || status === "draft") return { data: null, error: null };
    return { data: quoteDoc(status), error: null };
  };
}

function quoteDoc(status: string) {
  return {
    number: 1001,
    status,
    title: "Spring clean-up",
    message: null,
    valid_until: "2026-10-30",
    sent_at: "2026-09-01T15:00:00Z",
    accepted_at: null,
    accepted_name: null,
    declined_at: null,
    recipient_name: "Pat Prospect",
    org_name: "Doo Right Pet Services",
    org_email: null,
    org_phone: null,
    org_timezone: "America/Chicago",
    currency: "usd",
    lines: [
      {
        description: "Initial clean-up",
        quantity: 1,
        unit_amount_cents: 7500,
        amount_cents: 7500,
        recurring: false,
      },
    ],
  };
}

describe("the customer's quote link", () => {
  it("answers a draft exactly as it answers a token that does not exist", async () => {
    const admin = fakeDb(
      {},
      { rpc: quoteRpc({ [QUOTE_TOKENS.draft]: "draft" }), forbid: ["quotes", "quote_line_items"] },
    );
    expect(await publicQuotePdf(admin, QUOTE_TOKENS.draft)).toBeNull();
    expect(await publicQuotePdf(admin, UNKNOWN)).toBeNull();
    expect(pdfResponse(null).status).toBe(404);
  });

  it("does not ask the database about something that is not a token", async () => {
    const admin = fakeDb({}, { rpc: quoteRpc({}) });
    expect(await publicQuotePdf(admin, "not-a-uuid")).toBeNull();
    expect(await publicQuotePdf(admin, "")).toBeNull();
    expect(admin.rpcs).toEqual([]);
  });

  it("refuses a draft itself, even if the function in front of it ever stopped doing so", async () => {
    // A regression in the SQL would hand this path a draft document.
    const admin = fakeDb({}, { rpc: () => ({ data: quoteDoc("draft"), error: null }) });
    expect(await publicQuotePdf(admin, QUOTE_TOKENS.draft)).toBeNull();
  });

  it("serves a sent quote, through public_quote_document and never the table", async () => {
    const admin = fakeDb(
      {},
      { rpc: quoteRpc({ [QUOTE_TOKENS.sent]: "sent" }), forbid: ["quotes", "quote_line_items"] },
    );
    const file = await publicQuotePdf(admin, QUOTE_TOKENS.sent);
    expect(file).not.toBeNull();
    expect(isPdf(file!.bytes)).toBe(true);
    expect(file!.filename).toBe("Doo-Right-Pet-Services-Quote-Q-1001.pdf");
    const text = (await pdfText(file!.bytes)).replace(/\n/g, "");
    expect(text).toContain(`/q/${QUOTE_TOKENS.sent}`);
    const res = pdfResponse(file);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Cache-Control")).toContain("no-store");
  });
});

// ── The pay link ───────────────────────────────────────────────────────────

describe("the pay link", () => {
  it("answers an unknown or malformed token with nothing", async () => {
    const admin = fakeDb(billingTables("owner"));
    expect(await publicInvoicePdf(admin, UNKNOWN)).toBeNull();
    const before = admin.reads.length;
    expect(await publicInvoicePdf(admin, "../../etc/passwd")).toBeNull();
    expect(admin.reads.length).toBe(before);
  });

  it("serves the invoice by its token, with the name and not the email", async () => {
    const file = await publicInvoicePdf(fakeDb(billingTables("owner")), PAY_TOKEN);
    expect(file && isPdf(file.bytes)).toBe(true);
    const text = await pdfText(file!.bytes);
    expect(text).toContain("INV-1042");
    expect(text).toContain("Jane Q. Customer");
    expect(text).not.toContain("jane.customer@example.com");
    // Issued 23:30 UTC on the 30th is the 30th in Chicago, not October 1st.
    expect(text).toContain("Issued: Sep 30, 2026");
  });
});

// ── The office ─────────────────────────────────────────────────────────────

describe("the office", () => {
  for (const role of ["tech", "dispatcher"]) {
    it(`refuses a ${role} before reading any invoice or quote`, async () => {
      const db = fakeDb(billingTables(role));
      await expect(staffInvoicePdf(db, USER, INVOICE)).rejects.toThrow("Not authorized");
      await expect(staffQuotePdf(db, USER, QUOTE)).rejects.toThrow("Not authorized");
      // Resolving the caller reads user_roles and, since #863, the business's
      // overrides for their role; nothing else is read before the refusal.
      expect(db.reads.filter((t) => t !== "user_roles" && t !== "role_permission_overrides")).toEqual(
        [],
      );
    });
  }

  it("refuses somebody who belongs to no organization", async () => {
    const db = fakeDb({ ...billingTables("owner"), user_roles: [] });
    await expect(staffInvoicePdf(db, USER, INVOICE)).rejects.toThrow("No organization for user");
  });

  it("gives an owner or office manager their own invoice, email included", async () => {
    for (const role of ["owner", "office_manager"]) {
      const file = await staffInvoicePdf(fakeDb(billingTables(role)), USER, INVOICE);
      expect(isPdf(file.bytes)).toBe(true);
      const text = await pdfText(file.bytes);
      expect(text).toContain("jane.customer@example.com");
      expect(text).toContain("3 × $15.00");
    }
  });

  it("does not give them another org's invoice", async () => {
    await expect(
      staffInvoicePdf(fakeDb(billingTables("owner")), USER, FOREIGN_INVOICE),
    ).rejects.toThrow("Invoice not found");
  });

  it("draws a draft quote for the office as a DRAFT, with no link", async () => {
    const file = await staffQuotePdf(fakeDb(billingTables("owner")), USER, QUOTE);
    const text = await pdfText(file.bytes);
    expect(text).toContain("DRAFT");
    expect(text).toContain("pat@example.com");
    expect(text).not.toContain("/q/");
  });
});

// ── The portal ─────────────────────────────────────────────────────────────

describe("the customer portal", () => {
  it("gives a client their own invoice and nobody else's", async () => {
    const admin = fakeDb(billingTables("owner"));
    const mine = await portalInvoicePdf(admin, { clientId: CLIENT }, INVOICE);
    expect(isPdf(mine.bytes)).toBe(true);
    await expect(portalInvoicePdf(admin, { clientId: CLIENT }, FOREIGN_INVOICE)).rejects.toThrow(
      "Invoice not found",
    );
    await expect(portalInvoicePdf(admin, { clientId: CLIENT }, UNKNOWN)).rejects.toThrow(
      "Invoice not found",
    );
  });
});

// ── The wiring a unit test cannot reach ────────────────────────────────────

describe("the entry points", () => {
  const root = join(__dirname, "..");
  const fns = readFileSync(join(root, "src/lib/document-pdf.functions.ts"), "utf8");

  it("puts the office's two functions behind the sign-in middleware", () => {
    for (const name of ["downloadInvoicePdf", "downloadQuotePdf"]) {
      const body = fns.slice(fns.indexOf(`export const ${name}`)).split("export const")[1];
      expect(body, name).toMatch(/\.middleware\(\[requireSupabaseAuth\]\)/);
      expect(body, name).toMatch(/context\.supabase, context\.userId/);
    }
  });

  it("checks the portal session before it draws anything", () => {
    const body = fns.slice(fns.indexOf("export const portalDownloadInvoicePdf"));
    // `readOnly: true` since the owner's preview: a PDF is a read.
    expect(body.indexOf("requirePortalSession(data.token")).toBeGreaterThan(-1);
    expect(body.indexOf("requirePortalSession(data.token")).toBeLessThan(
      body.indexOf("portalInvoicePdf(supabaseAdmin"),
    );
  });

  it("sends each public route through its public gate and nothing else", () => {
    const inv = readFileSync(join(root, "src/routes/api/public/invoice-pdf.ts"), "utf8");
    const quo = readFileSync(join(root, "src/routes/api/public/quote-pdf.ts"), "utf8");
    expect(inv).toMatch(/publicInvoicePdf\(supabaseAdmin, token\)/);
    expect(quo).toMatch(/publicQuotePdf\(supabaseAdmin, token\)/);
    for (const src of [inv, quo]) expect(src).not.toMatch(/staff|portal/i);
  });

  it("imports pdf-lib only through the bundle that runs in the worker", () => {
    // See src/lib/pdf/pdf-lib.ts: the package entry builds, passes in Node,
    // and throws on evaluation in workerd.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && /from\s+["']pdf-lib["']/.test(readFileSync(p, "utf8")))
          // Forward slashes on every OS: `allowed` is written that way, and on
          // Windows join() hands back backslashes (windows-probe, 2026-10-02).
          offenders.push(repoRelative(p, root));
      }
    };
    walk(join(root, "src"));
    // The shim itself names the entry it avoids, and the types come from it.
    const allowed = ["src/lib/pdf/pdf-lib.ts"];
    expect(offenders.filter((f) => !allowed.includes(f))).toEqual([]);
    const shim = readFileSync(join(root, "src/lib/pdf/pdf-lib.ts"), "utf8");
    expect(shim).toMatch(/import \* as bundle from "pdf-lib\/dist\/pdf-lib\.esm\.min\.js";/);
    // Its one mention of the package entry is for types, erased at build.
    const code = shim.split("\n").filter((l) => !/^\s*\/\//.test(l));
    for (const line of code.filter((l) => /from\s+"pdf-lib"/.test(l)))
      expect(line).toMatch(/^import type /);
  });

  it("offers the PDF on every surface it was asked for", () => {
    const has = (p: string, s: RegExp) => expect(readFileSync(join(root, p), "utf8"), p).toMatch(s);
    has("src/routes/_authenticated/invoices.$invoiceId.tsx", /<DownloadPdfButton/);
    has("src/components/InvoiceDrawer.tsx", /<DownloadPdfButton/);
    has("src/routes/_authenticated/quotes.$quoteId.tsx", /<DownloadPdfButton/);
    has(
      "src/routes/pay.i.$token.tsx",
      /<DownloadPdfLink href=\{`\/api\/public\/invoice-pdf\?token=/,
    );
    has("src/routes/q.$token.tsx", /<DownloadPdfLink href=\{`\/api\/public\/quote-pdf\?token=/);
    has("src/routes/portal.$slug.$token.billing.tsx", /<DownloadPdfButton/);
  });
});

// ── The invoice email ──────────────────────────────────────────────────────

describe("the invoice email", () => {
  function emailAdmin(clientOver: Row = {}) {
    return fakeDb({
      organizations: [
        {
          id: ORG,
          name: "Doo Right Pet Services",
          contact_email: null,
          contact_phone: null,
          contact_address: null,
          notify_email_invoice_sent: true,
        },
      ],
      clients: [
        {
          id: CLIENT,
          display_name: "Jane",
          primary_email: "jane@example.com",
          email_opt_out: false,
          comms_paused: false,
          ...clientOver,
        },
      ],
      suppressed_emails: [],
    });
  }
  const send = (attachments: () => Promise<any[]>) =>
    enqueueAppEmail({
      organizationId: ORG,
      clientId: CLIENT,
      templateName: "invoice-sent",
      notifyKey: "notify_email_invoice_sent",
      templateData: { amountCents: 4500, invoiceUrl: "https://app.houndstack.com/pay/i/x" },
      manual: true,
      attachments,
    });

  beforeEach(() => {
    adminHolder.current = null;
  });

  it("carries the PDF into the queue in the shape Resend takes", async () => {
    adminHolder.current = emailAdmin();
    const res = await send(async () => [{ filename: "INV-1042.pdf", contentBase64: "JVBERi0=" }]);
    expect(res.ok).toBe(true);
    const payload = adminHolder.current.rpcs.find((r: any) => r.name === "enqueue_email").args
      .payload;
    expect(payload.attachments).toEqual([{ filename: "INV-1042.pdf", content: "JVBERi0=" }]);
    // And the processor forwards exactly that.
    expect(resendAttachments(payload.attachments)).toEqual(payload.attachments);
  });

  it("does not draw the PDF for an email that is not going", async () => {
    adminHolder.current = emailAdmin({ email_opt_out: true });
    const draw = vi.fn(async () => [{ filename: "x.pdf", contentBase64: "JVBERi0=" }]);
    const res = await send(draw);
    expect(res).toMatchObject({ ok: false, reason: "client_opted_out" });
    expect(draw).not.toHaveBeenCalled();
  });

  it("still sends the invoice when the PDF cannot be drawn", async () => {
    adminHolder.current = emailAdmin();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await send(async () => {
      throw new Error("font table exploded");
    });
    errSpy.mockRestore();
    expect(res.ok).toBe(true);
    const payload = adminHolder.current.rpcs.find((r: any) => r.name === "enqueue_email").args
      .payload;
    expect(payload.attachments).toBeUndefined();
  });

  it("forwards only well-formed attachments to Resend", () => {
    expect(resendAttachments(undefined)).toEqual([]);
    expect(
      resendAttachments([
        { filename: "a.pdf", content: "JVBERi0=" },
        { filename: "", content: "JVBERi0=" },
        { filename: "b.pdf", content: "" },
        { filename: "c.pdf", content: "not base64!" },
        null,
        "string",
      ]),
    ).toEqual([{ filename: "a.pdf", content: "JVBERi0=" }]);
  });

  it("is attached by both paths that send invoice-sent", () => {
    const root = join(__dirname, "..");
    for (const p of [
      "src/lib/notifications.functions.ts",
      "src/routes/api/public/hooks/nightly.ts",
    ]) {
      const src = readFileSync(join(root, p), "utf8");
      expect(src, p).toMatch(/invoicePdfAttachment\(supabaseAdmin, inv\.id\)/);
      expect(src, p).toMatch(/attachments: pdfAttachment/);
    }
  });
});
