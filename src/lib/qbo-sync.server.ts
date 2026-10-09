// Push one paid invoice, and every payment against it, to QuickBooks.
//
// The order is fixed by what QuickBooks links to what: the customer first
// (an invoice names it), then the invoice (a payment is applied to it), then
// each payment. Each step's QuickBooks Id is stored before the next step
// runs, so a sync that fails halfway resumes where it stopped and re-creates
// nothing. Every outcome, success or error, goes in the sync log with the
// intuit_tid of the call that produced it.
//
// Storage is behind QboSyncStore so this file has no database in it and the
// sequence can be tested against a mocked QuickBooks.

import {
  findOrCreateQboCustomer,
  SyncValidationError,
  upsertQboInvoice,
  upsertQboPayment,
  type InvoiceForSync,
  type PaymentForSync,
  type QboMapping,
} from "@/lib/accounting.server";
import type { QboClient } from "@/lib/qbo-client.server";
import { QboApiError } from "@/lib/qbo-http.server";
import { QboReconnectRequired } from "@/lib/qbo-oauth.server";

export type SyncLogEntry = {
  entity_type: "invoice" | "payment" | "client" | "connection";
  entity_id: string;
  status: "success" | "error";
  remote_id?: string | null;
  message?: string | null;
  intuit_tid?: string | null;
  http_status?: number | null;
  error_code?: string | null;
  attempts?: number | null;
};

export type InvoiceToSync = InvoiceForSync & { status: string; payments: PaymentForSync[] };

export interface QboSyncStore {
  loadInvoice(invoiceId: string): Promise<InvoiceToSync | null>;
  saveRemoteId(table: "clients" | "invoices" | "payments", id: string, remoteId: string): Promise<void>;
  log(entry: SyncLogEntry): Promise<void>;
  touchLastSync(): Promise<void>;
}

/** The sync-log fields for an error. Built from the error's own fields, which
 *  never include a token: see qbo-http.server.ts. */
export function errorLogFields(e: unknown): Pick<SyncLogEntry, "message" | "intuit_tid" | "http_status" | "error_code" | "attempts"> {
  if (e instanceof QboApiError) {
    return { message: e.message, intuit_tid: e.intuitTid, http_status: e.status || null, error_code: e.code ?? e.kind, attempts: e.attempts };
  }
  if (e instanceof QboReconnectRequired) {
    return { message: e.message, intuit_tid: e.intuitTid, http_status: null, error_code: e.reason, attempts: null };
  }
  if (e instanceof SyncValidationError) {
    return { message: e.message, intuit_tid: null, http_status: null, error_code: "validation", attempts: null };
  }
  return { message: e instanceof Error ? e.message.slice(0, 400) : "Sync failed", intuit_tid: null, http_status: null, error_code: null, attempts: null };
}

export type SyncResult = {
  invoiceRemoteId: string;
  invoiceCreated: boolean;
  payments: Array<{ id: string; remoteId: string }>;
  paymentErrors: string[];
};

export async function syncInvoiceToQbo(
  qbo: QboClient,
  mapping: QboMapping,
  store: QboSyncStore,
  invoiceId: string,
  newRequestId: () => string = () => crypto.randomUUID(),
): Promise<SyncResult> {
  const invoice = await store.loadInvoice(invoiceId);
  if (!invoice) throw new Error("Invoice not found");
  if (invoice.status !== "paid") throw new SyncValidationError("Only paid invoices are sent to QuickBooks.");
  if (!invoice.client) throw new SyncValidationError("This invoice has no client to bill in QuickBooks.");

  let invoiceRemoteId: string;
  let invoiceCreated: boolean;
  let customerId: string;
  try {
    const customer = await findOrCreateQboCustomer(qbo, invoice.client, newRequestId());
    customerId = customer.id;
    if (customer.store) {
      await store.saveRemoteId("clients", invoice.client.id, customer.id);
      await store.log({
        entity_type: "client",
        entity_id: invoice.client.id,
        status: "success",
        remote_id: customer.id,
        intuit_tid: qbo.lastIntuitTid,
      });
    }
    const res = await upsertQboInvoice(qbo, mapping, invoice, customerId, newRequestId());
    invoiceRemoteId = res.id;
    invoiceCreated = res.created;
    if (res.id !== invoice.accounting_remote_id) await store.saveRemoteId("invoices", invoice.id, res.id);
    const credit = Number(invoice.credit_applied_cents ?? 0);
    await store.log({
      entity_type: "invoice",
      entity_id: invoice.id,
      status: "success",
      remote_id: res.id,
      intuit_tid: qbo.lastIntuitTid,
      attempts: qbo.lastAttempts,
      message:
        (res.created ? "Created" : "Updated") +
        (credit > 0
          ? `. $${(credit / 100).toFixed(2)} of account credit was applied in HoundStack; apply the same credit in QuickBooks to close the balance.`
          : ""),
    });
  } catch (e) {
    await store.log({ entity_type: "invoice", entity_id: invoice.id, status: "error", ...errorLogFields(e) });
    throw e;
  }

  const payments: SyncResult["payments"] = [];
  const paymentErrors: string[] = [];
  for (const p of invoice.payments) {
    try {
      const res = await upsertQboPayment(
        qbo,
        mapping,
        p,
        { invoiceRemoteId, customerId, timezone: invoice.timezone, currency: invoice.currency },
        newRequestId(),
      );
      if (res.id !== p.accounting_remote_id) await store.saveRemoteId("payments", p.id, res.id);
      payments.push({ id: p.id, remoteId: res.id });
      await store.log({
        entity_type: "payment",
        entity_id: p.id,
        status: "success",
        remote_id: res.id,
        intuit_tid: qbo.lastIntuitTid,
        attempts: qbo.lastAttempts,
        message: res.created ? "Created" : "Updated",
      });
    } catch (e) {
      await store.log({ entity_type: "payment", entity_id: p.id, status: "error", ...errorLogFields(e) });
      // Without a token nothing else will go either; stop here.
      if (e instanceof QboReconnectRequired) throw e;
      paymentErrors.push(e instanceof Error ? e.message : String(e));
    }
  }

  await store.touchLastSync();
  return { invoiceRemoteId, invoiceCreated, payments, paymentErrors };
}
