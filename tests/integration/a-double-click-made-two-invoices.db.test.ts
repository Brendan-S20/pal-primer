/** A double click made two invoices (#607).
 *
 *  The New invoice dialog sends one creation key with every attempt, and
 *  create_manual_invoice returns the invoice a key already made. These drive
 *  the app's own insertManualInvoice against real Postgres: the same key
 *  twice in a row (a retry after a lost response), the same key twice at
 *  once (a double click), and no key (every other path) still making two.
 *
 *  Local stack only. CI builds the database from migrations before running
 *  this suite. Skipped without TEST_SUPABASE_* env. */
import { beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { insertManualInvoice } from "@/lib/manual-invoice.server";

const URL = process.env.TEST_SUPABASE_URL;
const SERVICE = process.env.TEST_SUPABASE_SERVICE_KEY;
const enabled = Boolean(URL && SERVICE);
const runId = Math.random().toString(36).slice(2, 10);

let admin: SupabaseClient;
let orgId: string;
let serial = 0;

async function ins(table: string, row: Record<string, unknown>): Promise<string> {
  const { data, error } = await admin.from(table).insert(row).select("id").single();
  if (error) throw new Error(`insert ${table}: ${error.message}`);
  return (data as { id: string }).id;
}

async function newClient(): Promise<string> {
  return ins("clients", {
    organization_id: orgId,
    display_name: `Double click ${++serial} ${runId}`,
    account_type: "residential",
    active: true,
  });
}

async function counter(): Promise<number> {
  const { data, error } = await admin
    .from("organizations")
    .select("next_invoice_number")
    .eq("id", orgId)
    .single();
  if (error) throw new Error(error.message);
  return (data as { next_invoice_number: number }).next_invoice_number;
}

async function invoicesFor(clientId: string): Promise<number> {
  const { count, error } = await admin
    .from("invoices")
    .select("id", { count: "exact", head: true })
    .eq("client_id", clientId);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

async function linesOn(invoiceId: string): Promise<number> {
  const { count, error } = await admin
    .from("invoice_line_items")
    .select("id", { count: "exact", head: true })
    .eq("invoice_id", invoiceId);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

const items = [{ description: "Weekly cleanup", amountCents: 2_500 }];

describe.skipIf(!enabled)("one creation key makes one invoice", () => {
  beforeAll(async () => {
    admin = createClient(URL!, SERVICE!, { auth: { persistSession: false } });
    orgId = await ins("organizations", { name: `Double click ${runId}`, timezone: "UTC" });
  });

  it("a retry with the same key returns the first invoice and takes no number", async () => {
    const clientId = await newClient();
    const creationKey = randomUUID();
    const before = await counter();
    const first = await insertManualInvoice(admin, {
      orgId,
      userId: null,
      clientId,
      items,
      creationKey,
    });
    const again = await insertManualInvoice(admin, {
      orgId,
      userId: null,
      clientId,
      items,
      creationKey,
    });
    expect(again.invoiceId).toBe(first.invoiceId);
    expect(await invoicesFor(clientId)).toBe(1);
    expect(await linesOn(first.invoiceId)).toBe(1);
    expect(await counter()).toBe(before + 1);
  });

  it("two requests with the same key at once make one invoice", async () => {
    const clientId = await newClient();
    const creationKey = randomUUID();
    const before = await counter();
    const [a, b] = await Promise.all([
      insertManualInvoice(admin, { orgId, userId: null, clientId, items, creationKey }),
      insertManualInvoice(admin, { orgId, userId: null, clientId, items, creationKey }),
    ]);
    expect(a.invoiceId).toBe(b.invoiceId);
    expect(await invoicesFor(clientId)).toBe(1);
    expect(await linesOn(a.invoiceId)).toBe(1);
    // The loser's insert was undone with the number it took.
    expect(await counter()).toBe(before + 1);
  });

  it("without a key, two calls still make two invoices", async () => {
    const clientId = await newClient();
    const a = await insertManualInvoice(admin, { orgId, userId: null, clientId, items });
    const b = await insertManualInvoice(admin, { orgId, userId: null, clientId, items });
    expect(a.invoiceId).not.toBe(b.invoiceId);
    expect(await invoicesFor(clientId)).toBe(2);
  });
});
