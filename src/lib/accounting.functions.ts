import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";

// QuickBooks Online sync. Every read and write is gated at manage_settings
// (owner and office manager): it connects the business's real books, and a
// dispatcher or tech must not view, post or disconnect it (#31). The tables
// underneath say the same in RLS (accounting_connections and
// accounting_sync_log: manage_settings), so PostgREST cannot be used around
// these functions.
async function requireAccountingOrg(supabase: unknown, userId: string): Promise<string> {
  const { orgId } = await requirePermission(supabase, userId, "manage_settings");
  return orgId;
}

/** What Settings → Accounting and the dashboard need to draw. Read through the
 *  caller's own client, so RLS decides what comes back. Never returns a token. */
export const getQuickBooksStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const orgId = await requireAccountingOrg(supabase, userId);
    const { qboCredentials, qboEnvironment } = await import("@/lib/qbo-config.server");
    const { data, error } = await (supabase as any)
      .from("accounting_connections")
      .select(
        "id, realm_id, status, status_reason, status_changed_at, connected_at, disconnected_at, last_sync_at, service_item_id, sales_tax_item_id, deposit_account_id",
      )
      .eq("org_id", orgId)
      .eq("provider", "quickbooks")
      .maybeSingle();
    if (error) throw new Error(error.message);
    return {
      configured: qboCredentials() !== null,
      environment: qboEnvironment(),
      connection: (data ?? null) as null | {
        id: string;
        realm_id: string | null;
        status: "connected" | "needs_reconnect" | "disconnected";
        status_reason: string | null;
        status_changed_at: string | null;
        connected_at: string;
        disconnected_at: string | null;
        last_sync_at: string | null;
        service_item_id: string | null;
        sales_tax_item_id: string | null;
        deposit_account_id: string | null;
      },
    };
  });

/** The connected company's products/services and deposit accounts, for the
 *  three choices on the settings page. Read from QuickBooks each time. */
export const listQuickBooksChoices = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const orgId = await requireAccountingOrg(supabase, userId);
    const { qboClientForOrg, writeSyncLog } = await import("@/lib/qbo-connection.server");
    const { errorLogFields } = await import("@/lib/qbo-sync.server");
    const { qbo, row } = await qboClientForOrg(orgId);
    try {
      const items = await qbo.query<{ Item?: Array<{ Id: string; Name: string; Type?: string }> }>(
        "select Id, Name, Type from Item where Active = true MAXRESULTS 1000",
      );
      const accounts = await qbo.query<{ Account?: Array<{ Id: string; Name: string; AccountType?: string }> }>(
        "select Id, Name, AccountType from Account where Active = true MAXRESULTS 1000",
      );
      return {
        items: (items.QueryResponse?.Item ?? [])
          .filter((i) => i.Type === "Service" || i.Type === "NonInventory")
          .map((i) => ({ id: i.Id, name: i.Name })),
        depositAccounts: (accounts.QueryResponse?.Account ?? [])
          .filter((a) => a.AccountType === "Bank" || a.AccountType === "Other Current Asset")
          .map((a) => ({ id: a.Id, name: a.Name })),
      };
    } catch (e) {
      await writeSyncLog(orgId, row.id, { entity_type: "connection", entity_id: row.id, status: "error", ...errorLogFields(e) });
      throw e;
    }
  });

/**
 * Save the item and account choices. Writes ONLY those three columns: the
 * old upsert rebuilt the whole row from the form, and the form had no realm
 * field filled in, so saving the mapping wiped `realm_id` (INV-7).
 */
export const saveQuickBooksMapping = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        service_item_id: z.string().trim().max(32).nullable(),
        sales_tax_item_id: z.string().trim().max(32).nullable(),
        deposit_account_id: z.string().trim().max(32).nullable(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await requireAccountingOrg(supabase, userId);
    const { data: updated, error } = await (supabase as any)
      .from("accounting_connections")
      .update({
        service_item_id: data.service_item_id || null,
        sales_tax_item_id: data.sales_tax_item_id || null,
        deposit_account_id: data.deposit_account_id || null,
      })
      .eq("org_id", orgId)
      .eq("provider", "quickbooks")
      .select("id");
    if (error) throw new Error(error.message);
    if (!updated?.length) throw new Error("Connect QuickBooks first.");
    return { ok: true };
  });

/** Disconnect from inside HoundStack: revoke at Intuit, delete the tokens. */
export const disconnectQuickBooks = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const orgId = await requireAccountingOrg(supabase, userId);
    const { disconnectQbo } = await import("@/lib/qbo-connection.server");
    await disconnectQbo(orgId, { revoke: true, reason: "disconnected in HoundStack" });
    return { ok: true };
  });

/**
 * Intuit's Disconnect URL lands here after the user disconnects from inside
 * QuickBooks. A link anyone could send must not be able to cut a working
 * connection, so it is believed only if QuickBooks agrees: one cheap read
 * (CompanyInfo) on the stored token. If QuickBooks refuses it, the tokens are
 * deleted and the connection is marked disconnected. If it still answers, the
 * connection is left alone and the page says so.
 */
export const confirmQuickBooksDisconnected = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const orgId = await requireAccountingOrg(supabase, userId);
    const { loadQboConnection, qboClientForOrg, disconnectQbo } = await import("@/lib/qbo-connection.server");
    const { QboReconnectRequired } = await import("@/lib/qbo-oauth.server");
    const row = await loadQboConnection(orgId);
    if (!row) return { state: "disconnected" as const };
    if (row.status === "connected" && row.realm_id) {
      try {
        const { qbo } = await qboClientForOrg(orgId);
        await qbo.request("GET", `companyinfo/${encodeURIComponent(row.realm_id)}`);
        return { state: "still_connected" as const };
      } catch (e) {
        if (!(e instanceof QboReconnectRequired)) throw e;
      }
    }
    if (row.status !== "disconnected" || row.access_token || row.refresh_token) {
      await disconnectQbo(orgId, { revoke: false, reason: "disconnected in QuickBooks" });
    }
    return { state: "disconnected" as const };
  });

/** Recent sync activity, newest first, with Intuit's transaction id on each
 *  call so an error can be taken to Intuit support. Through the caller's
 *  client: RLS limits it to their own organization. */
export const listSyncLog = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const orgId = await requireAccountingOrg(supabase, userId);
    const { data, error } = await (supabase as any)
      .from("accounting_sync_log")
      .select("id, entity_type, entity_id, status, remote_id, message, intuit_tid, http_status, error_code, attempts, created_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return (data ?? []) as Array<{
      id: string;
      entity_type: string;
      entity_id: string;
      status: "success" | "error" | "pending";
      remote_id: string | null;
      message: string | null;
      intuit_tid: string | null;
      http_status: number | null;
      error_code: string | null;
      attempts: number | null;
      created_at: string;
    }>;
  });

async function syncOne(orgId: string, invoiceId: string) {
  const { qboClientForOrg, mappingOf, supabaseSyncStore } = await import("@/lib/qbo-connection.server");
  const { syncInvoiceToQbo } = await import("@/lib/qbo-sync.server");
  const { qbo, row } = await qboClientForOrg(orgId);
  return syncInvoiceToQbo(qbo, mappingOf(row), supabaseSyncStore(orgId, row.id), invoiceId);
}

/** Push one paid invoice and its payments. Safe to repeat: a second push
 *  updates what the first created. */
export const syncInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ invoice_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await requireAccountingOrg(supabase, userId);
    const r = await syncOne(orgId, data.invoice_id);
    return {
      remote_id: r.invoiceRemoteId,
      payments: r.payments.length,
      payment_errors: r.paymentErrors,
    };
  });

/**
 * Push what is not in QuickBooks yet: paid invoices never sent, and paid
 * invoices with a payment never sent. Up to 50 per press, so one press stays
 * well inside Intuit's 500-requests-a-minute limit per company.
 */
export const syncAllPaidInvoices = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const orgId = await requireAccountingOrg(supabase, userId);
    const { QboReconnectRequired } = await import("@/lib/qbo-oauth.server");
    const sb = supabase as any;
    const { data: unsentInvoices, error: e1 } = await sb
      .from("invoices")
      .select("id")
      .eq("organization_id", orgId)
      .eq("status", "paid")
      .is("accounting_remote_id", null)
      .order("paid_at", { ascending: true })
      .limit(50);
    if (e1) throw new Error(e1.message);
    const { data: unsentPayments, error: e2 } = await sb
      .from("payments")
      .select("invoice_id, invoices!inner(status, accounting_remote_id)")
      .eq("organization_id", orgId)
      .eq("status", "succeeded")
      .is("accounting_remote_id", null)
      .eq("invoices.status", "paid")
      .not("invoices.accounting_remote_id", "is", null)
      .limit(50);
    if (e2) throw new Error(e2.message);
    const ids = [
      ...new Set([
        ...(unsentInvoices ?? []).map((i: { id: string }) => i.id),
        ...(unsentPayments ?? []).map((p: { invoice_id: string }) => p.invoice_id),
      ]),
    ].slice(0, 50);

    let ok = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        const r = await syncOne(orgId, id);
        if (r.paymentErrors.length) failed++;
        else ok++;
      } catch (e) {
        failed++;
        // A connection that needs reconnecting fails every remaining invoice
        // the same way; stop rather than log fifty copies of it.
        if (e instanceof QboReconnectRequired || (e as Error)?.name === "QboNotConnected") {
          return { ok, failed, total: ids.length, stopped: (e as Error).message };
        }
      }
    }
    return { ok, failed, total: ids.length, stopped: null as string | null };
  });
