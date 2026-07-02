import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const providerSchema = z.enum(["quickbooks", "xero"]);

async function getOrgId(supabase: any, userId: string): Promise<string> {
  const { data, error } = await supabase
    .from("staff")
    .select("org_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) throw new Error("No org membership");
  return data.org_id;
}

export const listAccountingConnections = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const { data, error } = await supabase
      .from("accounting_connections")
      .select("id, provider, realm_id, tenant_id, auto_sync, connected_at, last_sync_at, token_expires_at, default_income_account, default_ar_account, default_payment_account")
      .order("connected_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const upsertAccountingConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({
      provider: providerSchema,
      realm_id: z.string().optional().nullable(),
      tenant_id: z.string().optional().nullable(),
      access_token: z.string().optional().nullable(),
      refresh_token: z.string().optional().nullable(),
      token_expires_at: z.string().optional().nullable(),
      default_income_account: z.string().optional().nullable(),
      default_ar_account: z.string().optional().nullable(),
      default_payment_account: z.string().optional().nullable(),
      auto_sync: z.boolean().optional(),
    }).parse(d)
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await getOrgId(supabase, userId);
    const { data: existing } = await supabase
      .from("accounting_connections")
      .select("id")
      .eq("org_id", orgId)
      .eq("provider", data.provider)
      .maybeSingle();

    const payload: any = {
      org_id: orgId,
      provider: data.provider,
      realm_id: data.realm_id ?? null,
      tenant_id: data.tenant_id ?? null,
      default_income_account: data.default_income_account ?? null,
      default_ar_account: data.default_ar_account ?? null,
      default_payment_account: data.default_payment_account ?? null,
      auto_sync: data.auto_sync ?? false,
    };
    if (data.access_token) payload.access_token = data.access_token;
    if (data.refresh_token) payload.refresh_token = data.refresh_token;
    if (data.token_expires_at) payload.token_expires_at = data.token_expires_at;

    if (existing?.id) {
      const { error } = await supabase
        .from("accounting_connections")
        .update(payload)
        .eq("id", existing.id);
      if (error) throw new Error(error.message);
      return { id: existing.id };
    }
    const { data: inserted, error } = await supabase
      .from("accounting_connections")
      .insert(payload)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: inserted!.id };
  });

export const disconnectAccounting = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { error } = await supabase
      .from("accounting_connections")
      .delete()
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const listSyncLog = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const { data, error } = await supabase
      .from("accounting_sync_log")
      .select("id, entity_type, entity_id, direction, status, remote_id, message, created_at")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

/**
 * Push a paid invoice to the connected accounting provider.
 * Uses the stored access token; caller is responsible for keeping it fresh
 * (OAuth refresh flow is handled by the provider-specific callback route).
 */
export const syncInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ invoice_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await getOrgId(supabase, userId);

    const { data: conn } = await supabase
      .from("accounting_connections")
      .select("*")
      .eq("org_id", orgId)
      .maybeSingle();
    if (!conn) throw new Error("No accounting connection configured");
    if (!conn.access_token) throw new Error("Missing access token — reconnect the integration");

    const { data: invoice, error: invErr } = await supabase
      .from("invoices")
      .select("*, clients(display_name, primary_email, accounting_remote_id), invoice_line_items(description, amount_cents)")
      .eq("id", data.invoice_id)
      .single();
    if (invErr || !invoice) throw new Error(invErr?.message ?? "Invoice not found");

    // Delegate to the provider-specific driver (server-only import).
    const { pushInvoice } = await import("./accounting.server");
    let remoteId: string | null = null;
    let status: "success" | "error" = "success";
    let message: string | null = null;
    try {
      remoteId = await pushInvoice(conn, invoice);
      await supabase
        .from("invoices")
        .update({ accounting_remote_id: remoteId })
        .eq("id", invoice.id);
      await supabase
        .from("accounting_connections")
        .update({ last_sync_at: new Date().toISOString() })
        .eq("id", conn.id);
    } catch (e: any) {
      status = "error";
      message = e?.message ?? String(e);
    }

    await supabase.from("accounting_sync_log").insert({
      org_id: orgId,
      connection_id: conn.id,
      entity_type: "invoice",
      entity_id: invoice.id,
      direction: "push",
      status,
      remote_id: remoteId,
      message,
    });

    if (status === "error") throw new Error(message ?? "Sync failed");
    return { remote_id: remoteId };
  });

export const syncAllPaidInvoices = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    await getOrgId(supabase, userId);
    const { data: invoices } = await supabase
      .from("invoices")
      .select("id")
      .eq("status", "paid")
      .is("accounting_remote_id", null)
      .limit(50);
    let ok = 0, failed = 0;
    for (const inv of invoices ?? []) {
      try {
        await (syncInvoice as any)({ data: { invoice_id: inv.id } });
        ok++;
      } catch {
        failed++;
      }
    }
    return { ok, failed, total: invoices?.length ?? 0 };
  });
