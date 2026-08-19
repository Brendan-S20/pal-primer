import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

async function assertPlatformAdmin(supabase: any, userId: string) {
  const { data, error } = await supabase.rpc("is_platform_admin", { _user_id: userId });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden");
}

async function audit(
  supabaseAdmin: any,
  actor_user_id: string,
  organization_id: string | null,
  action: string,
  before_json: any,
  after_json: any,
) {
  try {
    await supabaseAdmin.from("platform_admin_audit").insert({
      actor_user_id, organization_id, action, before_json, after_json,
    });
  } catch { /* ignore */ }
}

export type TenantUserRow = {
  user_id: string;
  email: string | null;
  role: string;
  created_at: string;
};

export type TenantDetail = {
  id: string;
  name: string;
  billing_status: string;
  plan_status: string;
  plan_id: string | null;
  plan_name: string | null;
  plan_slug: string | null;
  active_client_count: number;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  grace_expires_at: string | null;
  suspended_at: string | null;
  suspended_reason: string | null;
  created_at: string;
  deleted_at: string | null;
  users: TenantUserRow[];
};

const idSchema = z.object({ organization_id: z.string().uuid() });

export const getTenantDetail = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => idSchema.parse(d))
  .handler(async ({ data, context }): Promise<TenantDetail> => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: org, error } = await supabaseAdmin
      .from("organizations")
      .select("id, name, billing_status, plan_status, plan_id, active_client_count, stripe_customer_id, stripe_subscription_id, grace_expires_at, suspended_at, suspended_reason, created_at, deleted_at")
      .eq("id", data.organization_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!org) throw new Error("Tenant not found");

    const [planRes, rolesRes] = await Promise.all([
      org.plan_id
        ? supabaseAdmin.from("platform_plans").select("name, slug").eq("id", org.plan_id).maybeSingle()
        : Promise.resolve({ data: null as null | { name: string; slug: string } }),
      supabaseAdmin
        .from("user_roles")
        .select("user_id, role, created_at")
        .eq("organization_id", data.organization_id),
    ]);

    const users: TenantUserRow[] = [];
    for (const r of rolesRes.data ?? []) {
      let email: string | null = null;
      try {
        const { data: u } = await supabaseAdmin.auth.admin.getUserById(r.user_id);
        email = u?.user?.email ?? null;
      } catch { /* ignore */ }
      users.push({ user_id: r.user_id, email, role: r.role, created_at: r.created_at });
    }

    return {
      id: org.id,
      name: org.name,
      billing_status: org.billing_status,
      plan_status: org.plan_status ?? "free",
      plan_id: org.plan_id ?? null,
      plan_name: planRes.data?.name ?? null,
      plan_slug: planRes.data?.slug ?? null,
      active_client_count: org.active_client_count ?? 0,
      stripe_customer_id: org.stripe_customer_id ?? null,
      stripe_subscription_id: org.stripe_subscription_id ?? null,
      grace_expires_at: org.grace_expires_at ?? null,
      suspended_at: org.suspended_at ?? null,
      suspended_reason: org.suspended_reason ?? null,
      created_at: org.created_at,
      deleted_at: org.deleted_at ?? null,
      users,
    };
  });

// ── Notes ────────────────────────────────────────────────────────────
export type TenantNote = {
  id: string;
  body: string;
  kind: string;
  author_user_id: string | null;
  author_email: string | null;
  created_at: string;
};

export const listTenantNotes = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => idSchema.parse(d))
  .handler(async ({ data, context }): Promise<{ rows: TenantNote[] }> => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: notes, error } = await supabaseAdmin
      .from("platform_support_notes")
      .select("id, body, kind, author_user_id, created_at")
      .eq("organization_id", data.organization_id)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    const rows: TenantNote[] = [];
    for (const n of notes ?? []) {
      let email: string | null = null;
      if (n.author_user_id) {
        try {
          const { data: u } = await supabaseAdmin.auth.admin.getUserById(n.author_user_id);
          email = u?.user?.email ?? null;
        } catch { /* ignore */ }
      }
      rows.push({ ...n, author_email: email });
    }
    return { rows };
  });

const addNoteSchema = z.object({
  organization_id: z.string().uuid(),
  body: z.string().min(1).max(4000),
  kind: z.enum(["note", "call", "email", "incident"]).default("note"),
});

export const addTenantNote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => addNoteSchema.parse(d))
  .handler(async ({ data, context }) => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("platform_support_notes").insert({
      organization_id: data.organization_id,
      body: data.body,
      kind: data.kind,
      author_user_id: context.userId,
    });
    if (error) throw new Error(error.message);
    await audit(supabaseAdmin, context.userId, data.organization_id, "add_support_note", null, { kind: data.kind });
    return { ok: true };
  });

export const deleteTenantNote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ note_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: existing } = await supabaseAdmin
      .from("platform_support_notes").select("organization_id").eq("id", data.note_id).maybeSingle();
    const { error } = await supabaseAdmin.from("platform_support_notes").delete().eq("id", data.note_id);
    if (error) throw new Error(error.message);
    await audit(supabaseAdmin, context.userId, existing?.organization_id ?? null, "delete_support_note", null, null);
    return { ok: true };
  });

// ── Feature flags ────────────────────────────────────────────────────
export type TenantFlagRow = {
  key: string;
  label: string;
  description: string | null;
  default_value: boolean;
  override_value: boolean | null;
  justification: string | null;
  effective: boolean;
};

export const listTenantFeatureFlags = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => idSchema.parse(d))
  .handler(async ({ data, context }): Promise<{ rows: TenantFlagRow[] }> => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const [catalog, overrides] = await Promise.all([
      supabaseAdmin.from("platform_feature_flags").select("key, label, description, default_value").order("label"),
      supabaseAdmin.from("platform_org_feature_flags").select("key, value, justification")
        .eq("organization_id", data.organization_id),
    ]);
    if (catalog.error) throw new Error(catalog.error.message);
    const ovMap = new Map((overrides.data ?? []).map((o) => [o.key, o] as const));
    const rows: TenantFlagRow[] = (catalog.data ?? []).map((f) => {
      const ov = ovMap.get(f.key);
      return {
        key: f.key,
        label: f.label,
        description: f.description,
        default_value: f.default_value,
        override_value: ov ? ov.value : null,
        justification: ov?.justification ?? null,
        effective: ov ? ov.value : f.default_value,
      };
    });
    return { rows };
  });

const setFlagSchema = z.object({
  organization_id: z.string().uuid(),
  key: z.string().min(1),
  value: z.boolean().nullable(), // null = clear override
  justification: z.string().max(500).optional().nullable(),
});

export const setTenantFeatureFlag = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => setFlagSchema.parse(d))
  .handler(async ({ data, context }) => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    if (data.value === null) {
      const { error } = await supabaseAdmin
        .from("platform_org_feature_flags").delete()
        .eq("organization_id", data.organization_id).eq("key", data.key);
      if (error) throw new Error(error.message);
      await audit(supabaseAdmin, context.userId, data.organization_id, "clear_feature_flag", null, { key: data.key });
    } else {
      const { error } = await supabaseAdmin.from("platform_org_feature_flags").upsert({
        organization_id: data.organization_id,
        key: data.key,
        value: data.value,
        justification: data.justification ?? null,
        updated_by: context.userId,
      }, { onConflict: "organization_id,key" });
      if (error) throw new Error(error.message);
      await audit(supabaseAdmin, context.userId, data.organization_id, "set_feature_flag", null, {
        key: data.key, value: data.value, justification: data.justification ?? null,
      });
    }
    return { ok: true };
  });

// ── Invoices ─────────────────────────────────────────────────────────
export type TenantInvoiceRow = {
  id: string;
  number: string | null;
  status: string;
  amount_due_cents: number;
  amount_paid_cents: number;
  currency: string;
  issued_at: string | null;
  due_at: string | null;
  paid_at: string | null;
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
};

export const listTenantInvoices = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => idSchema.parse(d))
  .handler(async ({ data, context }): Promise<{ rows: TenantInvoiceRow[] }> => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: rows, error } = await supabaseAdmin
      .from("platform_invoices")
      .select("id, number, status, amount_due_cents, amount_paid_cents, currency, issued_at, due_at, paid_at, hosted_invoice_url, invoice_pdf")
      .eq("organization_id", data.organization_id)
      .order("issued_at", { ascending: false, nullsFirst: false });
    if (error) throw new Error(error.message);
    return { rows: rows ?? [] };
  });

// ── Audit (per tenant) ───────────────────────────────────────────────
export type TenantAuditRow = {
  id: string;
  actor_user_id: string | null;
  actor_email: string | null;
  action: string;
  before_json: any;
  after_json: any;
  created_at: string;
};

export const listTenantAudit = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => idSchema.parse(d))
  .handler(async ({ data, context }): Promise<{ rows: TenantAuditRow[] }> => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: rows, error } = await supabaseAdmin
      .from("platform_admin_audit")
      .select("id, actor_user_id, action, before_json, after_json, created_at")
      .eq("organization_id", data.organization_id)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    const actorIds = Array.from(new Set((rows ?? []).map((r) => r.actor_user_id).filter(Boolean))) as string[];
    const emails = new Map<string, string>();
    await Promise.all(actorIds.slice(0, 50).map(async (uid) => {
      try {
        const { data: u } = await supabaseAdmin.auth.admin.getUserById(uid);
        if (u?.user?.email) emails.set(uid, u.user.email);
      } catch { /* ignore */ }
    }));
    return {
      // actor_user_id is null on a webhook-written row; the label falls back.
      rows: (rows ?? []).map((r) => ({
        ...r,
        actor_email: r.actor_user_id ? (emails.get(r.actor_user_id) ?? null) : null,
      })),
    };
  });

// ── Lifecycle: suspend / reactivate / soft-delete ────────────────────
const suspendSchema = z.object({
  organization_id: z.string().uuid(),
  reason: z.string().min(1).max(500),
});

export const suspendTenant = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => suspendSchema.parse(d))
  .handler(async ({ data, context }) => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: before } = await supabaseAdmin.from("organizations")
      .select("billing_status, suspended_at, suspended_reason").eq("id", data.organization_id).maybeSingle();
    const patch = {
      billing_status: "suspended" as const,
      suspended_at: new Date().toISOString(),
      suspended_reason: data.reason,
    };
    const { error } = await supabaseAdmin.from("organizations").update(patch).eq("id", data.organization_id);
    if (error) throw new Error(error.message);
    await audit(supabaseAdmin, context.userId, data.organization_id, "suspend_tenant", before, patch);
    return { ok: true };
  });

export const reactivateTenant = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => idSchema.parse(d))
  .handler(async ({ data, context }) => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: before } = await supabaseAdmin.from("organizations")
      .select("billing_status, plan_status, suspended_at, suspended_reason, stripe_subscription_id")
      .eq("id", data.organization_id).maybeSingle();
    // If there's an active subscription, restore to "active"; otherwise "free".
    // plan_status must be written too — it (not billing_status) is what the
    // client-creation gate reads, so a canceled tenant stays blocked otherwise.
    const nextStatus = before?.stripe_subscription_id ? "active" : "free";
    const patch = {
      billing_status: nextStatus as any,
      plan_status: nextStatus as any,
      suspended_at: null,
      suspended_reason: null,
    };
    const { error } = await supabaseAdmin.from("organizations").update(patch).eq("id", data.organization_id);
    if (error) throw new Error(error.message);
    await audit(supabaseAdmin, context.userId, data.organization_id, "reactivate_tenant", before, patch);
    return { ok: true };
  });

const graceSchema = z.object({
  organization_id: z.string().uuid(),
  days: z.number().int().min(1).max(90),
});

export const grantGracePeriod = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => graceSchema.parse(d))
  .handler(async ({ data, context }) => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: before } = await supabaseAdmin.from("organizations")
      .select("billing_status, plan_status, grace_expires_at")
      .eq("id", data.organization_id).maybeSingle();
    if (!before) throw new Error("Tenant not found");
    const expires = new Date(Date.now() + data.days * 24 * 60 * 60 * 1000).toISOString();
    // grace_expires_at is what org_can_add_client honors; billing_status is
    // display-only but set for consistency across admin/tenant surfaces.
    const patch = {
      grace_expires_at: expires,
      billing_status: "grace" as any,
    };
    const { error } = await supabaseAdmin.from("organizations").update(patch).eq("id", data.organization_id);
    if (error) throw new Error(error.message);
    await audit(supabaseAdmin, context.userId, data.organization_id, "grant_grace_period", before, patch);
    return { ok: true, grace_expires_at: expires };
  });

const deleteSchema = z.object({
  organization_id: z.string().uuid(),
  confirm_name: z.string().min(1),
});

export const softDeleteTenant = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => deleteSchema.parse(d))
  .handler(async ({ data, context }) => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: org } = await supabaseAdmin.from("organizations")
      .select("id, name, deleted_at").eq("id", data.organization_id).maybeSingle();
    if (!org) throw new Error("Tenant not found");
    if (org.name.trim() !== data.confirm_name.trim())
      throw new Error("Confirmation name does not match");
    const patch = { deleted_at: new Date().toISOString() };
    const { error } = await supabaseAdmin.from("organizations").update(patch).eq("id", data.organization_id);
    if (error) throw new Error(error.message);
    await audit(supabaseAdmin, context.userId, data.organization_id, "soft_delete_tenant", { deleted_at: org.deleted_at }, patch);
    return { ok: true };
  });

/**
 * The inverse of softDeleteTenant, and the reason it exists: soft-delete was a
 * one-way door. It writes `deleted_at`, listPlatformTenants filters the row out
 * of the console, and every action on the detail page is disabled once the
 * column is set — so a platform admin who deleted the wrong tenant had no way
 * back to that organization from inside the product at all.
 *
 * It restores exactly what soft-delete took away and nothing else: `deleted_at`
 * back to NULL. Billing status, suspension, plan and grace are untouched,
 * because soft-delete never touched them either — a tenant that was suspended
 * when it was deleted comes back suspended.
 */
export const restoreTenant = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => idSchema.parse(d))
  .handler(async ({ data, context }) => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: org } = await supabaseAdmin.from("organizations")
      .select("id, name, deleted_at").eq("id", data.organization_id).maybeSingle();
    if (!org) throw new Error("Tenant not found");
    if (!org.deleted_at) throw new Error("This tenant is not deleted");
    const patch = { deleted_at: null };
    const { error } = await supabaseAdmin.from("organizations").update(patch).eq("id", data.organization_id);
    if (error) throw new Error(error.message);
    await audit(supabaseAdmin, context.userId, data.organization_id, "restore_tenant", { deleted_at: org.deleted_at }, patch);
    return { ok: true, name: org.name };
  });
