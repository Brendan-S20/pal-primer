/** #859: completing a visit never ran the #605 invoice path. Decision D2
 *  (Oct 30) is "invoice at completion", so a postpaid client billed after
 *  each visit gets the invoice when the visit is completed, from the office
 *  or by the tech, once however often it is asked, and a prepaid visit still
 *  gets none.
 *
 *  The pure rules and the wiring are here. The round trip through Postgres
 *  (one invoice on a retry, on two at once, and beside "Invoice this visit")
 *  is tests/integration/a-visit-billed-after-each-visit-is-invoiced-once.db.test.ts. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  invoicesAtCompletion,
  voidedInvoiceCount,
  type BillableVisit,
  type CompletionBilling,
  type VisitLink,
} from "@/lib/visit-invoicing";
import { visitInvoiceCreationKey } from "@/lib/visit-completion-invoice.server";

const visit = (over: Partial<BillableVisit> = {}): BillableVisit => ({
  id: "v1",
  scheduled_on: "2026-11-10",
  status: "completed",
  skip_billable: false,
  skip_charge_cents: 0,
  skip_reason_code: null,
  is_deepclean: false,
  deepclean_charge_cents: 0,
  price_cents: 2000,
  client_package_id: null,
  subscription: { price_cents: 2000, billing_cadence: "postpaid" },
  service_name: "Weekly scoop",
  street: "1 Elm St",
  ...over,
});

const afterEachVisit: CompletionBilling = {
  billingFrequency: "after_each_visit",
  clientActive: true,
  autoInvoiceEnabled: true,
};

describe("which completions invoice the visit", () => {
  it("a completed postpaid visit for a client billed after each visit does", () => {
    expect(invoicesAtCompletion(visit(), afterEachVisit)).toBe(true);
  });

  it("a prepaid visit does not: finalize_visit_completion debited the balance", () => {
    const v = visit({ subscription: { price_cents: 2000, billing_cadence: "prepaid" } });
    expect(invoicesAtCompletion(v, afterEachVisit)).toBe(false);
  });

  it("a visit on no plan does not: only a postpaid plan is billed per visit", () => {
    expect(invoicesAtCompletion(visit({ subscription: null }), afterEachVisit)).toBe(false);
  });

  it("a weekly or monthly client does not: the run bills the period", () => {
    for (const f of ["weekly", "monthly", "quarterly", "yearly", null]) {
      expect(invoicesAtCompletion(visit(), { ...afterEachVisit, billingFrequency: f })).toBe(false);
    }
  });

  it("a package lesson does not: it is on the package invoice", () => {
    expect(invoicesAtCompletion(visit({ client_package_id: "p1" }), afterEachVisit)).toBe(false);
  });

  it("an org with automatic invoicing off, or an inactive client, does not, as the run does not", () => {
    expect(invoicesAtCompletion(visit(), { ...afterEachVisit, autoInvoiceEnabled: false })).toBe(
      false,
    );
    expect(invoicesAtCompletion(visit(), { ...afterEachVisit, clientActive: false })).toBe(false);
  });

  it("a skipped or still-scheduled visit does not", () => {
    expect(invoicesAtCompletion(visit({ status: "skipped" }), afterEachVisit)).toBe(false);
    expect(invoicesAtCompletion(visit({ status: "scheduled" }), afterEachVisit)).toBe(false);
  });
});

describe("one key per visit, so a retry makes one invoice", () => {
  const V = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it("is a UUID, which is what invoices.creation_key holds", () => {
    expect(visitInvoiceCreationKey(V, 0)).toMatch(UUID);
  });

  it("is the same every time it is asked for the same visit", () => {
    expect(visitInvoiceCreationKey(V, 0)).toBe(visitInvoiceCreationKey(V, 0));
    expect(visitInvoiceCreationKey(V.toUpperCase(), 0)).toBe(visitInvoiceCreationKey(V, 0));
  });

  it("differs for another visit, and after a void", () => {
    expect(visitInvoiceCreationKey(V, 0)).not.toBe(
      visitInvoiceCreationKey("00000000-0000-4000-8000-000000000001", 0),
    );
    expect(visitInvoiceCreationKey(V, 1)).not.toBe(visitInvoiceCreationKey(V, 0));
  });

  it("counts each void invoice once, and only void ones", () => {
    const l = (id: string, status: string, visit_id = "v1"): VisitLink => ({
      visit_id,
      invoice: { id, number: 1, status },
    });
    expect(voidedInvoiceCount("v1", [])).toBe(0);
    expect(voidedInvoiceCount("v1", [l("a", "open")])).toBe(0);
    expect(
      voidedInvoiceCount("v1", [l("a", "void"), l("a", "void"), l("b", "void"), l("c", "open")]),
    ).toBe(2);
    expect(voidedInvoiceCount("v1", [l("a", "void", "v2")])).toBe(0);
  });
});

// ── The wiring: both completions reach it, and the button shares the key ──
const root = join(import.meta.dirname, "..");
const strip = (s: string) => s.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const read = (p: string) => strip(readFileSync(join(root, p), "utf8"));
const between = (s: string, a: string, b: string) => {
  const i = s.indexOf(a);
  expect(i, `${a} not found`).toBeGreaterThanOrEqual(0);
  const j = s.indexOf(b, i + a.length);
  return s.slice(i, j < 0 ? undefined : j);
};

describe("both completions invoice the visit", () => {
  it("the office's completion does, after office_complete_visit succeeds", () => {
    const fn = between(
      read("src/lib/visits.functions.ts"),
      "export const completeVisitFromOffice",
      "export const rescheduleVisitFromOffice",
    );
    const rpc = fn.indexOf('rpc("office_complete_visit"');
    const call = fn.indexOf("invoiceAtCompletionSafely(");
    expect(rpc).toBeGreaterThanOrEqual(0);
    expect(call).toBeGreaterThan(rpc);
    // Not before the override question is answered: a completion that asks
    // "why is there no photo?" has not happened yet.
    expect(call).toBeGreaterThan(fn.indexOf("needsOverride: ask"));
  });

  it("the tech's completion does, after complete_visit succeeds", () => {
    const fn = between(
      read("src/lib/my-day.functions.ts"),
      "export const completeVisit ",
      "export const ",
    );
    const rpc = fn.indexOf('rpc("complete_visit"');
    const thrown = fn.indexOf("if (error) throw", rpc);
    const call = fn.indexOf("invoiceAtCompletionSafely(");
    expect(rpc).toBeGreaterThanOrEqual(0);
    expect(call).toBeGreaterThan(thrown);
  });

  it("is made with the service role, because a tech holds no billing permission", () => {
    const safe = between(
      read("src/lib/visit-completion-invoice.server.ts"),
      "export async function invoiceAtCompletionSafely",
      "\n}\n",
    );
    expect(safe).toMatch(/supabaseAdmin/);
    // A failure never fails a completion that already happened.
    expect(safe).toMatch(/catch \(e\)/);
  });

  it("carries the visit's key, and Invoice this visit carries the same one", () => {
    const server = read("src/lib/visit-completion-invoice.server.ts");
    const made = between(server, "export async function invoiceVisitAtCompletion", "\n}\n");
    expect(made).toMatch(/creationKey = await nextVisitInvoiceKey\(db, p\.visitId\)/);
    expect(made).toMatch(/insertManualInvoice\(db, \{[\s\S]*creationKey,/);
    const button = between(
      read("src/lib/invoices.functions.ts"),
      "export const invoiceVisit",
      "async function refuseIfInvoiceChanged",
    );
    expect(button).toMatch(/creationKey: await nextVisitInvoiceKey\(supabase, data\.visitId\)/);
  });
});
