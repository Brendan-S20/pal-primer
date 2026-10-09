// The QuickBooks connection row, and everything that reads or writes it on
// the server: tokens (encrypted at rest, AES-256-GCM, the same
// secret-encryption.server.ts the Twilio and webhook secrets use), status,
// the sync log, and the database side of a sync.
//
// Runs on the service role, so EVERY query here is scoped by org_id /
// organization_id explicitly. Callers prove the user may act for the org
// (manage_settings) before they get here.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { decryptSecret, encryptSecret } from "@/lib/secret-encryption.server";
import { qboCredentials, qboEnvironment } from "@/lib/qbo-config.server";
import { realHttpDeps } from "@/lib/qbo-http.server";
import { QboReconnectRequired, revokeQboToken, type QboOAuthDeps, type QboTokens } from "@/lib/qbo-oauth.server";
import { QboClient } from "@/lib/qbo-client.server";
import type { QboMapping } from "@/lib/accounting.server";
import { errorLogFields, type InvoiceToSync, type QboSyncStore, type SyncLogEntry } from "@/lib/qbo-sync.server";

const db = supabaseAdmin as any;

export type QboStatus = "connected" | "needs_reconnect" | "disconnected";

export type QboConnectionRow = {
  id: string;
  org_id: string;
  realm_id: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  refresh_token_expires_at: string | null;
  status: QboStatus;
  status_reason: string | null;
  service_item_id: string | null;
  sales_tax_item_id: string | null;
  deposit_account_id: string | null;
};

export class QboNotConnected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QboNotConnected";
  }
}

export function oauthDeps(): QboOAuthDeps {
  const credentials = qboCredentials();
  if (!credentials) throw new QboNotConnected("QuickBooks isn't set up on this server yet. Contact support.");
  return { ...realHttpDeps(), now: Date.now, environment: qboEnvironment(), credentials };
}

export async function loadQboConnection(orgId: string): Promise<QboConnectionRow | null> {
  const { data, error } = await db
    .from("accounting_connections")
    .select(
      "id, org_id, realm_id, access_token, refresh_token, token_expires_at, refresh_token_expires_at, status, status_reason, service_item_id, sales_tax_item_id, deposit_account_id",
    )
    .eq("org_id", orgId)
    .eq("provider", "quickbooks")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as QboConnectionRow | null) ?? null;
}

export function mappingOf(row: QboConnectionRow): QboMapping {
  return {
    service_item_id: row.service_item_id,
    sales_tax_item_id: row.sales_tax_item_id,
    deposit_account_id: row.deposit_account_id,
  };
}

export async function writeSyncLog(orgId: string, connectionId: string | null, entry: SyncLogEntry): Promise<void> {
  const { error } = await db.from("accounting_sync_log").insert({
    org_id: orgId,
    connection_id: connectionId,
    direction: "push",
    ...entry,
    message: entry.message ? String(entry.message).slice(0, 1000) : null,
  });
  // A log that cannot be written must not turn a successful push into a
  // failure; say so where an operator will see it, without the payload.
  if (error) console.error("qbo: sync log insert failed", error.code ?? "", error.message);
}

async function markNeedsReconnect(orgId: string, connectionId: string, reason: string, intuitTid: string | null) {
  await db
    .from("accounting_connections")
    .update({ status: "needs_reconnect", status_reason: reason, status_changed_at: new Date().toISOString() })
    .eq("id", connectionId)
    .eq("org_id", orgId);
  await writeSyncLog(orgId, connectionId, {
    entity_type: "connection",
    entity_id: connectionId,
    status: "error",
    error_code: reason,
    intuit_tid: intuitTid,
    message: new QboReconnectRequired(reason as QboReconnectRequired["reason"]).message,
  });
}

async function persistTokens(orgId: string, connectionId: string, t: QboTokens) {
  const { error } = await db
    .from("accounting_connections")
    // Encrypted on the way down. The rotated refresh token is as sensitive as
    // the original and replaces it every time.
    .update({
      access_token: encryptSecret(t.accessToken),
      refresh_token: encryptSecret(t.refreshToken),
      token_expires_at: t.accessExpiresAt,
      ...(t.refreshExpiresAt ? { refresh_token_expires_at: t.refreshExpiresAt } : {}),
    })
    .eq("id", connectionId)
    .eq("org_id", orgId);
  if (error) throw new Error(`Could not store the refreshed QuickBooks token: ${error.message}`);
}

/** A client for the org's connected company. Refuses a connection that is
 *  not `connected`: a connection that needs reconnecting stops syncing. */
export async function qboClientForOrg(orgId: string): Promise<{ qbo: QboClient; row: QboConnectionRow }> {
  const row = await loadQboConnection(orgId);
  if (!row || row.status === "disconnected" || !row.realm_id) {
    throw new QboNotConnected("QuickBooks isn't connected. Connect it on Settings → Accounting.");
  }
  if (row.status === "needs_reconnect") {
    throw new QboNotConnected("QuickBooks needs to be reconnected before anything else can sync.");
  }
  const deps = oauthDeps();
  const qbo = new QboClient(
    {
      id: row.id,
      realmId: row.realm_id,
      accessToken: row.access_token ? decryptSecret(row.access_token) : null,
      refreshToken: row.refresh_token ? decryptSecret(row.refresh_token) : null,
      accessExpiresAt: row.token_expires_at,
      refreshExpiresAt: row.refresh_token_expires_at,
    },
    {
      ...deps,
      persistTokens: (id, t) => persistTokens(orgId, id, t),
      markNeedsReconnect: (id, reason, tid) => markNeedsReconnect(orgId, id, reason, tid),
    },
  );
  return { qbo, row };
}

/** Store a fresh grant from the OAuth callback. Connecting a DIFFERENT
 *  company than before clears the item choices and every stored QuickBooks
 *  Id, because they name objects in the other company's books. */
export async function saveQboGrant(orgId: string, realmId: string, t: QboTokens): Promise<void> {
  const existing = await loadQboConnection(orgId);
  const companyChanged = !!existing?.realm_id && existing.realm_id !== realmId;
  if (companyChanged) {
    for (const table of ["clients", "invoices", "payments"] as const) {
      await db
        .from(table)
        .update({ accounting_remote_id: null })
        .eq("organization_id", orgId)
        .not("accounting_remote_id", "is", null);
    }
  }
  const { data, error } = await db
    .from("accounting_connections")
    .upsert(
      {
        org_id: orgId,
        provider: "quickbooks",
        realm_id: realmId,
        access_token: encryptSecret(t.accessToken),
        refresh_token: encryptSecret(t.refreshToken),
        token_expires_at: t.accessExpiresAt,
        refresh_token_expires_at: t.refreshExpiresAt,
        status: "connected",
        status_reason: null,
        status_changed_at: new Date().toISOString(),
        connected_at: new Date().toISOString(),
        disconnected_at: null,
        ...(companyChanged ? { service_item_id: null, sales_tax_item_id: null, deposit_account_id: null } : {}),
      },
      { onConflict: "org_id,provider" },
    )
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  await writeSyncLog(orgId, data.id, {
    entity_type: "connection",
    entity_id: data.id,
    status: "success",
    message: companyChanged
      ? "Connected to a different QuickBooks company. Links to the previous company were cleared."
      : "Connected",
  });
}

/** Revoke at Intuit (when asked and there is a token), then delete the
 *  tokens here whatever Intuit said: a disconnect the user asked for must not
 *  be undone by Intuit being unreachable. */
export async function disconnectQbo(orgId: string, opts: { revoke: boolean; reason: string }): Promise<void> {
  const row = await loadQboConnection(orgId);
  if (!row) return;
  if (opts.revoke && (row.refresh_token || row.access_token)) {
    try {
      const token = decryptSecret((row.refresh_token ?? row.access_token)!);
      const { intuitTid } = await revokeQboToken(token, oauthDeps());
      await writeSyncLog(orgId, row.id, {
        entity_type: "connection",
        entity_id: row.id,
        status: "success",
        intuit_tid: intuitTid,
        message: "Access revoked at Intuit",
      });
    } catch (e) {
      await writeSyncLog(orgId, row.id, { entity_type: "connection", entity_id: row.id, status: "error", ...errorLogFields(e) });
    }
  }
  const { error } = await db
    .from("accounting_connections")
    .update({
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      refresh_token_expires_at: null,
      status: "disconnected",
      status_reason: opts.reason,
      status_changed_at: new Date().toISOString(),
      disconnected_at: new Date().toISOString(),
    })
    .eq("id", row.id)
    .eq("org_id", orgId);
  if (error) throw new Error(error.message);
  await writeSyncLog(orgId, row.id, {
    entity_type: "connection",
    entity_id: row.id,
    status: "success",
    message: `Disconnected (${opts.reason})`,
  });
}

/** The database half of a sync for one org. */
export function supabaseSyncStore(orgId: string, connectionId: string): QboSyncStore {
  return {
    async loadInvoice(invoiceId) {
      const { data: inv, error } = await db
        .from("invoices")
        .select(
          "id, number, status, total_cents, tax_cents, tax_rate_bps, tax_label, credit_applied_cents, currency, issued_at, due_on, accounting_remote_id, " +
            "clients(id, display_name, first_name, last_name, company, primary_email, accounting_remote_id), " +
            "invoice_line_items(description, amount_cents, quantity, unit_amount_cents, created_at), " +
            "payments(id, amount_cents, paid_at, created_at, method, reference, accounting_remote_id, status)",
        )
        .eq("id", invoiceId)
        .eq("organization_id", orgId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!inv) return null;
      const { data: org } = await db.from("organizations").select("timezone").eq("id", orgId).maybeSingle();
      const client = Array.isArray(inv.clients) ? inv.clients[0] : inv.clients;
      const lines = [...(inv.invoice_line_items ?? [])].sort((a: any, b: any) =>
        String(a.created_at).localeCompare(String(b.created_at)),
      );
      const payments = (inv.payments ?? [])
        .filter((p: any) => p.status === "succeeded" && Number(p.amount_cents) > 0)
        .sort((a: any, b: any) => String(a.paid_at ?? a.created_at).localeCompare(String(b.paid_at ?? b.created_at)));
      return { ...inv, client: client ?? null, lines, payments, timezone: org?.timezone ?? null } as InvoiceToSync;
    },
    async saveRemoteId(table, id, remoteId) {
      const { error } = await db
        .from(table)
        .update({ accounting_remote_id: remoteId })
        .eq("id", id)
        .eq("organization_id", orgId);
      if (error) throw new Error(`Saved in QuickBooks (Id ${remoteId}) but could not record it here: ${error.message}`);
    },
    log: (entry) => writeSyncLog(orgId, connectionId, entry),
    async touchLastSync() {
      await db
        .from("accounting_connections")
        .update({ last_sync_at: new Date().toISOString() })
        .eq("id", connectionId)
        .eq("org_id", orgId);
    },
  };
}
