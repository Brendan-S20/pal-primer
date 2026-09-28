// A bid had nothing to accept.
//
// Found 2026-09-28 by the product review: a price in this product was only
// ever a number computed from zone pricing, so an HOA board, a property
// manager or a homeowner who wanted it in writing had nothing to read and
// nothing to say yes to. Quotes, version one: write one, send it by link, the
// customer accepts (typing their name as the signature) or declines without a
// password, and an accepted quote becomes work.
//
// This file pins the parts that can be checked without a database: the
// arithmetic and labels, the rules as the migration writes them, the email,
// and the wiring. tests/a-quote-is-answered-once.test.ts proves the same rules
// against a real Postgres when one is reachable.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { render } from "react-email";
import {
  convertTarget,
  defaultQuoteValidUntil,
  effectiveQuoteStatus,
  formatQuantity,
  formatQuoteDay,
  isUsableSignature,
  lineAmountCents,
  normalizeSignature,
  parseMoneyToCents,
  parseQuantity,
  quoteConversion,
  quoteNumberLabel,
  quoteRespondErrorMessage,
  quoteToWizardPrefill,
  quoteTotals,
  sendResultMessage,
} from "@/lib/quotes";
import { TEMPLATES } from "@/lib/email-templates/registry";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const MIGRATION = "supabase/migrations/20260928170000_a-bid-had-nothing-to-accept.sql";

/** Comment lines out, so an assertion cannot be met by the prose about it. */
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*(--|\/\/|\*|\/\*)/.test(l))
    .join("\n");

/** The body of one CREATE FUNCTION in the migration. */
function fnBody(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is created`).toBeGreaterThan(-1);
  const open = sql.indexOf("$function$", start);
  const close = sql.indexOf("$function$", open + 1);
  return sql.slice(open, close);
}

// ── The arithmetic ─────────────────────────────────────────────────────────

describe("a line total is the arithmetic the database checks", () => {
  it("multiplies in hundredths, so 1.15 x 100 is 115 and not 114.99", () => {
    expect(lineAmountCents(1.15, 100)).toBe(115);
    expect(lineAmountCents(2, 2400)).toBe(4800);
    expect(lineAmountCents(0.5, 3)).toBe(2);
  });

  it("rounds half away from zero, the way Postgres rounds numeric", () => {
    // 1.5 x 333 = 499.5: numeric round() gives 500; the CHECK constraint
    // quote_line_items_amount_is_quantity_times_price refuses 499.
    expect(lineAmountCents(1.5, 333)).toBe(500);
    expect(lineAmountCents(0.25, 2)).toBe(1); // 0.5 -> 1
    expect(lineAmountCents(0.01, 49)).toBe(0); // 0.49 -> 0
    // The case the obvious Math.round(quantity * unit) gets wrong: 1.13 x 50
    // is 56.5 exactly in numeric, and 56.49999999999999 in a double.
    expect(1.13 * 50).toBeLessThan(56.5);
    expect(lineAmountCents(1.13, 50)).toBe(57);
  });

  it("parses what an owner types, and refuses what the column cannot hold", () => {
    expect(parseQuantity("1")).toBe(1);
    expect(parseQuantity("2.5")).toBe(2.5);
    expect(parseQuantity(".75")).toBe(0.75);
    expect(parseQuantity("0")).toBeNull();
    expect(parseQuantity("1.234")).toBeNull();
    expect(parseQuantity("-1")).toBeNull();
    expect(parseQuantity("10001")).toBeNull();
    expect(parseMoneyToCents("24")).toBe(2400);
    expect(parseMoneyToCents("$1,200.5")).toBe(120050);
    expect(parseMoneyToCents("19.99")).toBe(1999);
    expect(parseMoneyToCents("0")).toBe(0);
    expect(parseMoneyToCents("12.345")).toBeNull();
    expect(parseMoneyToCents("abc")).toBeNull();
    expect(parseMoneyToCents("-5")).toBeNull();
  });

  it("totals one-time and per-visit separately, never together", () => {
    const t = quoteTotals([
      { amount_cents: 12000, recurring: false },
      { amount_cents: 2400, recurring: true },
      { amount_cents: 500, recurring: true },
      { amount_cents: 1500, recurring: false },
    ]);
    expect(t).toEqual({
      oneTimeCents: 13500,
      recurringCents: 2900,
      oneTimeCount: 2,
      recurringCount: 2,
    });
  });

  it("formats a quantity without trailing zeros", () => {
    expect(formatQuantity(1)).toBe("1");
    expect(formatQuantity("1.50")).toBe("1.5");
    expect(formatQuantity(2.25)).toBe("2.25");
  });
});

// ── Labels and dates ───────────────────────────────────────────────────────

describe("labels a customer reads", () => {
  it("numbers read aloud on a phone call", () => {
    expect(quoteNumberLabel(1001)).toBe("Q-1001");
    expect(quoteNumberLabel(null)).toBe("Quote");
  });

  it("a day in words that cannot slip in the browser's zone", () => {
    expect(formatQuoteDay("2026-10-28")).toBe("October 28, 2026");
    expect(formatQuoteDay(null)).toBe("");
    expect(formatQuoteDay("not a day")).toBe("");
  });

  it("valid for thirty days on the org's calendar, across a month end", () => {
    expect(defaultQuoteValidUntil("2026-09-28")).toBe("2026-10-28");
    expect(defaultQuoteValidUntil("2026-12-15")).toBe("2027-01-14");
  });

  it("a sent quote past its date is expired on the org's today, not before", () => {
    expect(effectiveQuoteStatus("sent", "2026-09-28", "2026-09-28")).toBe("sent");
    expect(effectiveQuoteStatus("sent", "2026-09-27", "2026-09-28")).toBe("expired");
    expect(effectiveQuoteStatus("sent", null, "2030-01-01")).toBe("sent");
    // An answer is an answer, whatever the date.
    expect(effectiveQuoteStatus("accepted", "2020-01-01", "2026-09-28")).toBe("accepted");
    expect(effectiveQuoteStatus("draft", "2020-01-01", "2026-09-28")).toBe("draft");
  });

  it("the signature is a real name, whitespace collapsed", () => {
    expect(normalizeSignature("  Jane   Q.  Customer ")).toBe("Jane Q. Customer");
    expect(isUsableSignature(" J ")).toBe(false);
    expect(isUsableSignature("Jo")).toBe(true);
    expect(isUsableSignature("x".repeat(121))).toBe(false);
  });

  it("every refusal the database raises becomes a sentence, never the code", () => {
    for (const code of [
      "quote_expired",
      "quote_already_accepted",
      "quote_already_declined",
      "signature_required",
      "quote_not_found",
    ]) {
      const msg = quoteRespondErrorMessage(code);
      expect(msg, code).not.toMatch(/_/);
      expect(msg.length, code).toBeGreaterThan(10);
    }
    expect(quoteRespondErrorMessage('duplicate key value violates "x"')).toMatch(
      /Something went wrong/,
    );
  });

  it("never tells the office an email went when it did not", () => {
    expect(sendResultMessage({ emailed: true, reason: null, recipient: "a@b.co" })).toEqual({
      ok: true,
      text: "Quote emailed to a@b.co.",
    });
    for (const reason of [
      "no_email",
      "org_toggle_off",
      "client_opted_out",
      "suppressed",
      "enqueue_failed",
      null,
    ]) {
      const m = sendResultMessage({ emailed: false, reason, recipient: "a@b.co" });
      expect(m.ok, String(reason)).toBe(false);
      expect(m.text, String(reason)).not.toMatch(/emailed/i);
      expect(m.text, String(reason)).toMatch(/Copy the link/);
    }
  });
});

// ── Turning it into work ───────────────────────────────────────────────────

describe("an accepted quote becomes work", () => {
  it("prices the service at the per-visit total, and says so when there is none", () => {
    expect(
      quoteConversion([
        { amount_cents: 12000, recurring: false },
        { amount_cents: 2400, recurring: true },
        { amount_cents: 600, recurring: true },
      ]),
    ).toEqual({ priceCents: 3000, oneTimeCents: 12000 });
    expect(quoteConversion([{ amount_cents: 12000, recurring: false }])).toEqual({
      priceCents: null,
      oneTimeCents: 12000,
    });
  });

  it("goes to the client's services, or the new-client wizard, and only once", () => {
    const base = { client_id: null, lead_id: null, converted_at: null };
    expect(convertTarget({ ...base, status: "accepted", client_id: "c1" })).toEqual({
      kind: "client",
      clientId: "c1",
    });
    expect(convertTarget({ ...base, status: "accepted", lead_id: "l1" })).toEqual({
      kind: "prospect",
      leadId: "l1",
    });
    expect(convertTarget({ ...base, status: "sent", client_id: "c1" }).kind).toBe("not-ready");
    expect(
      convertTarget({
        ...base,
        status: "accepted",
        client_id: "c1",
        converted_at: "2026-09-28T00:00:00Z",
      }).kind,
    ).toBe("not-ready");
  });

  it("a prospect's wizard starts with who they are and where they came from", () => {
    const p = quoteToWizardPrefill({
      label: "Q-1004",
      title: "Common areas",
      prospectName: " Oakwood Terrace HOA ",
      prospectEmail: "Board@Oakwood.example",
      prospectPhone: "+1 312 555 0100",
      acceptedName: "Pat Rivera",
      acceptedAt: "2026-09-28T15:00:00Z",
    });
    expect(p.displayName).toBe("Oakwood Terrace HOA");
    expect(p.primaryEmail).toBe("board@oakwood.example");
    expect(p.officeNote).toMatch(/From quote Q-1004: Common areas/);
    expect(p.officeNote).toMatch(/Accepted by Pat Rivera/);
    // A made-up SMS lead address is not a mailbox.
    expect(
      quoteToWizardPrefill({
        label: "Q-1",
        title: null,
        prospectName: "x",
        prospectEmail: "13125550100@sms.lead",
        prospectPhone: null,
        acceptedName: null,
        acceptedAt: null,
      }).primaryEmail,
    ).toBe("");
  });
});

// ── The migration, as written ──────────────────────────────────────────────

describe("the migration", () => {
  const sql = read(MIGRATION);
  const code = codeOnly(sql);

  it("is the latest migration's successor and nothing collides with it", () => {
    const files = readdirSync(join(ROOT, "supabase/migrations")).filter((f) => f.endsWith(".sql"));
    expect(files.filter((f) => f.startsWith("20260928170000")).length).toBe(1);
  });

  it("numbers quotes per organization from a counter on the org row, like invoices", () => {
    expect(code).toMatch(
      /ADD COLUMN IF NOT EXISTS next_quote_number integer NOT NULL DEFAULT 1001/,
    );
    expect(code).toMatch(/SET next_quote_number = next_quote_number \+ 1/);
    expect(code).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS quotes_org_number_key ON public\.quotes \(organization_id, number\)/,
    );
  });

  it("checks that a line total is quantity times price", () => {
    expect(code).toMatch(/quantity numeric\(10,2\) NOT NULL DEFAULT 1/);
    expect(code).toMatch(/amount_cents = round\(quantity \* unit_amount_cents\)/);
  });

  it("has the email switch every other customer email has", () => {
    expect(code).toMatch(
      /ADD COLUMN IF NOT EXISTS notify_email_quote_sent boolean NOT NULL DEFAULT true/,
    );
  });

  describe("anon reads nothing", () => {
    it("takes back the default grants from anon on both tables", () => {
      expect(code).toMatch(/REVOKE ALL ON public\.quotes FROM anon, authenticated;/);
      expect(code).toMatch(/REVOKE ALL ON public\.quote_line_items FROM anon, authenticated;/);
      expect(code).not.toMatch(/GRANT[^;]*ON public\.quotes[^;]*TO[^;]*\banon\b/);
      expect(code).not.toMatch(/GRANT[^;]*ON public\.quote_line_items[^;]*TO[^;]*\banon\b/);
    });

    it("and no policy names anon or public", () => {
      const policies = code.match(/CREATE POLICY[\s\S]*?;/g) ?? [];
      expect(policies.length).toBe(8);
      for (const p of policies) {
        expect(p, p.slice(0, 80)).toMatch(/TO authenticated/);
        expect(p).not.toMatch(/TO (anon|public)\b/i);
      }
    });

    it("and the migration asserts it rather than assuming it", () => {
      expect(sql).toMatch(/has_table_privilege\('anon', _t, 'SELECT'\)/);
    });
  });

  it("gates every write on manage_client_billing, and a delete on a draft", () => {
    const policies = code.match(/CREATE POLICY[\s\S]*?;/g) ?? [];
    const writes = policies.filter((p) => /FOR (INSERT|UPDATE|DELETE)/.test(p));
    expect(writes.length).toBe(6);
    for (const p of writes) expect(p).toMatch(/'manage_client_billing'/);
    for (const p of writes.filter((p) => /ON public\.quote_line_items/.test(p))) {
      expect(p, "lines can only change on a draft").toMatch(/q\.status = 'draft'/);
    }
    const del = policies.find((p) => /ON public\.quotes\s+FOR DELETE/.test(p));
    expect(del).toMatch(/status = 'draft'/);
    // Never FOR ALL beside a FOR SELECT: 20260810120000.
    for (const p of policies) expect(p).not.toMatch(/FOR ALL/);
  });

  describe("the two public functions", () => {
    it("are SECURITY DEFINER with a fixed search_path", () => {
      for (const name of ["public_quote_document", "public_quote_respond"]) {
        const decl = code.slice(code.indexOf(`FUNCTION public.${name}(`));
        expect(decl.slice(0, 400), name).toMatch(/SECURITY DEFINER/);
        expect(decl.slice(0, 400), name).toMatch(/SET search_path TO 'public', 'pg_temp'/);
      }
    });

    it("are granted the way the public invoice path reaches the database: service_role only", () => {
      expect(code).toMatch(
        /REVOKE ALL ON FUNCTION public\.public_quote_document\(uuid\) FROM PUBLIC, anon, authenticated;/,
      );
      expect(code).toMatch(
        /GRANT EXECUTE ON FUNCTION public\.public_quote_document\(uuid\) TO service_role;/,
      );
      expect(code).toMatch(
        /REVOKE ALL ON FUNCTION public\.public_quote_respond\(uuid, boolean, text, text\) FROM PUBLIC, anon, authenticated;/,
      );
      expect(code).toMatch(
        /GRANT EXECUTE ON FUNCTION public\.public_quote_respond\(uuid, boolean, text, text\) TO service_role;/,
      );
      expect(code).not.toMatch(
        /GRANT EXECUTE ON FUNCTION public\.public_quote_(document|respond)[^;]*\b(anon|authenticated)\b/,
      );
    });

    it("do not overload the signup page's anon-callable public_quote", () => {
      expect(code).not.toMatch(/FUNCTION public\.public_quote\(/);
    });

    it("never publish a draft", () => {
      const doc = fnBody(sql, "public_quote_document");
      expect(doc).toMatch(/IF _q\.id IS NULL OR _q\.status = 'draft' THEN\s+RETURN NULL;/);
      const respond = fnBody(sql, "public_quote_respond");
      expect(respond).toMatch(
        /IF _q\.id IS NULL OR _q\.status = 'draft' THEN\s+RAISE EXCEPTION 'quote_not_found';/,
      );
    });

    it("answer under a row lock, so two taps take turns", () => {
      expect(fnBody(sql, "public_quote_respond")).toMatch(
        /SELECT \* INTO _q FROM public\.quotes WHERE public_token = _token FOR UPDATE;/,
      );
    });

    it("return the first answer to a second tap instead of an error or a second timestamp", () => {
      const respond = codeOnly(fnBody(sql, "public_quote_respond"));
      // Already accepted + accept again: no exception, no UPDATE, changed=false.
      expect(respond).toMatch(
        /IF _q\.status = 'accepted' THEN\s+IF NOT _accept THEN RAISE EXCEPTION 'quote_already_accepted'; END IF;/,
      );
      expect(respond).toMatch(
        /ELSIF _q\.status = 'declined' THEN\s+IF _accept THEN RAISE EXCEPTION 'quote_already_declined'; END IF;/,
      );
      expect(respond).toMatch(/_changed boolean := false;/);
      // The only UPDATEs are in the branch where the quote was still open.
      const openBranch = respond.slice(respond.indexOf("ELSE"));
      expect(respond.slice(0, respond.indexOf("ELSE"))).not.toMatch(/UPDATE public\.quotes/);
      expect(openBranch.match(/UPDATE public\.quotes/g)?.length).toBe(2);
    });

    it("refuse an expired or withdrawn quote, on the org's calendar", () => {
      const respond = fnBody(sql, "public_quote_respond");
      expect(respond).toMatch(
        /now\(\) AT TIME ZONE COALESCE\(NULLIF\(_tz, ''\), 'America\/Chicago'\)/,
      );
      expect(respond).toMatch(
        /IF _q\.status = 'expired' OR \(_q\.valid_until IS NOT NULL AND _q\.valid_until < _today\) THEN\s+RAISE EXCEPTION 'quote_expired';/,
      );
    });

    it("need a typed name to accept", () => {
      expect(fnBody(sql, "public_quote_respond")).toMatch(/RAISE EXCEPTION 'signature_required';/);
    });
  });

  it("keeps a sent quote as sent, and the answer the customer's", () => {
    const guard = fnBody(sql, "quotes_guard_answer");
    expect(guard).toMatch(/A quote cannot be edited once it has been sent/);
    expect(guard).toMatch(/current_user IN \('authenticated', 'anon'\)/);
    // current_user only means the writer when the function runs as invoker.
    const decl = code.slice(code.indexOf("FUNCTION public.quotes_guard_answer()"));
    expect(decl.slice(0, 200)).toMatch(/SECURITY INVOKER/);
  });

  it("keeps every reference inside the tenant", () => {
    const before = fnBody(sql, "quotes_before_write");
    expect(before).toMatch(/c\.id = NEW\.client_id AND c\.organization_id = NEW\.organization_id/);
    expect(before).toMatch(/l\.id = NEW\.lead_id AND l\.organization_id = NEW\.organization_id/);
    expect(before).toMatch(/NEW\.public_token := OLD\.public_token;/);
  });

  it("locks both trigger functions away from the API roles", () => {
    expect(code).toMatch(
      /REVOKE ALL ON FUNCTION public\.quotes_before_write\(\) FROM PUBLIC, anon, authenticated;/,
    );
    expect(code).toMatch(
      /REVOKE ALL ON FUNCTION public\.quotes_guard_answer\(\) FROM PUBLIC, anon, authenticated;/,
    );
  });
});

// ── The email ──────────────────────────────────────────────────────────────

describe("the quote email", () => {
  it("is registered under the name the sender uses, and renders the link and both totals", async () => {
    const entry = TEMPLATES["quote-sent"];
    expect(entry, "registered").toBeTruthy();
    const html = await render(
      React.createElement(entry.component, {
        orgName: "Whitfield & Ramirez Yard and Waste Services",
        clientName: "Oakwood Terrace HOA",
        quoteLabel: "Q-1042",
        title: "Common areas",
        oneTimeCents: 12000,
        recurringCents: 2900,
        validUntilLabel: "October 28, 2026",
        message: "Thanks for walking the grounds with me.",
        quoteUrl: "https://app.houndstack.com/q/9f0c3c2e-2b41-4f7b-9a53-0f0f7bb0c001",
        orgPhone: "+1 312 555 0142",
      }),
    );
    expect(html).toContain("https://app.houndstack.com/q/9f0c3c2e-2b41-4f7b-9a53-0f0f7bb0c001");
    expect(html).toContain("$29.00");
    expect(html).toContain("per visit");
    expect(html).toContain("$120.00");
    expect(html).toContain("Q-1042");
    expect(html).toContain("October 28, 2026");
    expect(html).toContain("+1 312 555 0142");
    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    const subject =
      typeof entry.subject === "function"
        ? entry.subject({ quoteLabel: "Q-1042", orgName: "Acme" })
        : entry.subject;
    expect(subject).toBe("Quote Q-1042 from Acme");
  });

  it("is sent as an explicit user action, through the org's switch, by link", () => {
    const fns = read("src/lib/quotes.functions.ts");
    const send = fns.slice(
      fns.indexOf("export const sendQuote"),
      fns.indexOf("export const withdrawQuote"),
    );
    expect(send).toMatch(/templateName: "quote-sent"/);
    expect(send).toMatch(/notifyKey: "notify_email_quote_sent"/);
    expect(send).toMatch(/manual: true/);
    // The link names the host the product lives at, never the page's origin.
    expect(fns).toMatch(/return `\$\{appOrigin\(\)\}\/q\/\$\{token\}`;/);
    expect(codeOnly(fns)).not.toMatch(/window\.location/);
  });

  it("can reach a prospect with no client row, and still honours the suppression list", () => {
    const enqueue = read("src/lib/email/enqueue.server.ts");
    expect(enqueue).toMatch(/clientId: string \| null;/);
    expect(enqueue).toMatch(/\| "notify_email_quote_sent"/);
    // With no client there must be an explicit address, or nothing is sent.
    expect(enqueue).toMatch(
      /\} else if \(!params\.toOverride\) \{\s+return \{ ok: false, reason: "no_recipient" \};/,
    );
    // The suppression check is below the branch, so it applies to both.
    expect(enqueue.indexOf('.from("suppressed_emails")')).toBeGreaterThan(
      enqueue.indexOf("} else if (!params.toOverride) {"),
    );
  });

  it("the owner can switch it off", () => {
    expect(read("src/routes/_authenticated/settings.emails.tsx")).toMatch(
      /key: "notify_email_quote_sent"/,
    );
    expect(
      read("src/lib/email-settings.functions.ts").match(/notify_email_quote_sent/g)?.length,
    ).toBe(2);
  });
});

// ── The wiring ─────────────────────────────────────────────────────────────

describe("the wiring", () => {
  const fns = read("src/lib/quotes.functions.ts");
  const handler = (name: string) => {
    const start = fns.indexOf(`export const ${name} = createServerFn`);
    expect(start, name).toBeGreaterThan(-1);
    const next = fns.indexOf("export const ", start + 10);
    return fns.slice(start, next === -1 ? undefined : next);
  };

  it("every office function asks for manage_client_billing, the manual-invoice permission", () => {
    for (const name of [
      "listQuotes",
      "getQuote",
      "saveQuoteDraft",
      "deleteQuoteDraft",
      "duplicateQuote",
      "sendQuote",
      "withdrawQuote",
      "markQuoteConverted",
    ]) {
      const h = handler(name);
      expect(h, name).toMatch(/\.middleware\(\[requireSupabaseAuth\]\)/);
      expect(h, name).toMatch(
        /requirePermission\(supabase, (context\.)?userId, "manage_client_billing"\)/,
      );
    }
  });

  it("the customer's two functions take no session and go through the service-role RPCs", () => {
    for (const [name, rpc] of [
      ["getPublicQuote", "public_quote_document"],
      ["respondToPublicQuote", "public_quote_respond"],
    ] as const) {
      const h = handler(name);
      expect(h, name).not.toMatch(/requireSupabaseAuth/);
      // `supabaseAdmin`: the name scripts/check-rpc-grants.mjs recognises as
      // a service-role call site, so the lockdown is not reported as a fault.
      expect(h, name).toMatch(new RegExp(`supabaseAdmin\\.rpc\\("${rpc}"`));
      // Never the table: the rules live in the function.
      expect(h, name).not.toMatch(/\.from\("quotes"\)/);
    }
  });

  it("tells the office once, when the answer is new", () => {
    const h = handler("respondToPublicQuote");
    expect(h).toMatch(/if \(r\.changed\) \{/);
    expect(h).toMatch(/notifyRoles\(\["owner", "office_manager"\]/);
    expect(h).toMatch(/type: "quote_response"/);
    expect(read("src/lib/notifications-center.functions.ts")).toMatch(/type: "quote_response"/);
  });

  it("is in the nav beside Invoices, and gated like it", () => {
    const nav = read("src/components/AppSidebar.tsx");
    expect(nav).toMatch(
      /\{ title: "Invoices", url: "\/invoices", icon: Receipt \},\s+\{ title: "Quotes", url: "\/quotes", icon: FileSignature \},/,
    );
    expect(read("src/hooks/useMyRole.ts")).toMatch(/"\/quotes": \["owner", "office_manager"\]/);
  });

  it("a lead can be quoted, with only its id in the URL", () => {
    const leads = read("src/routes/_authenticated/leads.tsx");
    expect(leads).toMatch(/navigate\(\{ to: "\/quotes\/new", search: \{ fromLead: id \} \}\)/);
    expect(leads).toMatch(/label: "Send a quote"/);
    const page = read("src/routes/_authenticated/quotes.new.tsx");
    const validate = page.slice(
      page.indexOf("validateSearch"),
      page.indexOf("component: NewQuotePage"),
    );
    expect(validate).toMatch(/UUID\.test/);
    expect(validate).not.toMatch(/name|email|phone/i);
  });

  it("convert opens the existing flows with ?fromQuote, and the flows mark the quote converted", () => {
    const detail = read("src/routes/_authenticated/quotes.$quoteId.tsx");
    expect(detail).toMatch(/search: \{ tab: "services", fromQuote: quote\.id \}/);
    expect(detail).toMatch(/to: "\/clients\/new",\s+search: \{ fromQuote: quote\.id/);
    const client = read("src/routes/_authenticated/clients.$clientId.tsx");
    expect(client).toMatch(/UUID_RE\.test\(search\.fromQuote\)/);
    const services = read("src/components/client-detail/ServicesTab.tsx");
    expect(services).toMatch(
      /blank\.priceDollars = \(fromQuote\.priceCents \/ 100\)\.toFixed\(2\)/,
    );
    expect(services).toMatch(/convertedFn\(\{ data: \{ id: fromQuote\.quoteId, clientId \} \}\)/);
    const wizard = read("src/routes/_authenticated/clients.new.tsx");
    expect(wizard).toMatch(
      /fromQuote: typeof s\.fromQuote === "string" && UUID\.test\(s\.fromQuote\)/,
    );
    expect(wizard).toMatch(/convertedFn\(\{ data: \{ id: fromQuote\.id, clientId: id \} \}\)/);
  });

  it("the public page has no session and reads its answer back rather than remembering it", () => {
    const page = read("src/routes/q.$token.tsx");
    expect(page).toMatch(/createFileRoute\("\/q\/\$token"\)/);
    expect(page).toMatch(/qc\.invalidateQueries\(\{ queryKey: \["public-quote", token\] \}\)/);
    expect(codeOnly(page)).not.toMatch(/\b(localStorage|sessionStorage)\s*\./);
  });
});
