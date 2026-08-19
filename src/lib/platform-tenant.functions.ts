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

// ── Audit evidence: what actually changed ────────────────────────────
//
// `before_json` and `after_json` have been written by every action on this
// page since the table existed, are selected by `listTenantAudit`, and were
// rendered by nothing: the Audit tab said a tenant was suspended and never
// what changed. These are the read-side helpers for that, kept pure and
// exported from here so they can be tested without a browser.
//
// Two things about the LIVE data shaped them (checked 2026-08-19):
//
//   Most rows have no before.  `before_json IS NULL` on every impersonation
//     event, every promo capture and every coupon creation — 140 of the 154
//     rows in production. "There was no before state" is not the same fact as
//     "the before state was empty", and a diff that renders both as an empty
//     list has thrown away the only thing that distinguishes a create from a
//     no-op. `shape` carries that distinction.
//   A value is not necessarily a scalar.  `send_announcement_emails` files
//     `{ processed, summary: [ … ] }`, so this walks to the leaves and names
//     them by path rather than looping over top-level keys.

/** One leaf that differs between the two sides.
 *
 *  `null` on a side means the path is not PRESENT there — rendered as added or
 *  removed. It never means the JSON value `null`, which is a value a leaf can
 *  legitimately hold and which formats as the string "null". */
export type AuditDiffRow = { path: string; before: string | null; after: string | null };

export type AuditDiff = {
  /** Which sides were recorded at all. `after-only` had no before to compare
   *  against; `both` with no rows had one, and nothing moved. */
  shape: "both" | "after-only" | "before-only" | "neither";
  rows: AuditDiffRow[];
  /** Leaves present and equal on both sides — noise on screen, but the COUNT
   *  is what separates "nothing changed" from "nothing was recorded". */
  unchanged: number;
  /** The walk hit its depth or size ceiling, so `rows` is not the whole story. */
  truncated: boolean;
};

const DIFF_MAX_DEPTH = 6;
const DIFF_MAX_LEAVES = 400;
const DIFF_MAX_VALUE_CHARS = 300;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A leaf as one line of text. Strings are shown raw — these are reasons,
 *  emails and ids that people read — and everything else goes through
 *  JSON.stringify, so `null`, `true`, `{}` and `[]` all say what they are. */
function formatLeaf(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v) ?? "undefined";
  return s.length > DIFF_MAX_VALUE_CHARS ? `${s.slice(0, DIFF_MAX_VALUE_CHARS)}…` : s;
}

/** Path → leaf for arbitrary JSON. Objects and arrays are walked; a NESTED
 *  empty object or array is itself a leaf, because "this key became {}" is a
 *  change worth seeing. Keys are sorted so two rows written in different key
 *  orders still line up — jsonb does not preserve insertion order.
 *
 *  The one asymmetry: an empty object at the ROOT contributes no leaf at all.
 *  `{}` as a whole record is "recorded, and empty", which `shape` and the row
 *  count already say; giving it a nameless leaf would make every field of the
 *  other side read as a change against `{}` and add a phantom row of its own. */
function flattenJson(root: unknown): { leaves: Map<string, unknown>; truncated: boolean } {
  const leaves = new Map<string, unknown>();
  let truncated = false;
  const walk = (v: unknown, path: string, depth: number) => {
    if (leaves.size >= DIFF_MAX_LEAVES) { truncated = true; return; }
    if (depth < DIFF_MAX_DEPTH) {
      if (Array.isArray(v)) {
        if (v.length === 0) { if (depth > 0) leaves.set(path, v); return; }
        v.forEach((item, i) => walk(item, `${path}[${i}]`, depth + 1));
        return;
      }
      if (isPlainObject(v)) {
        const keys = Object.keys(v).sort();
        if (keys.length === 0) { if (depth > 0) leaves.set(path, v); return; }
        for (const k of keys) walk(v[k], path ? `${path}.${k}` : k, depth + 1);
        return;
      }
    } else if (Array.isArray(v) || isPlainObject(v)) {
      truncated = true;
    }
    leaves.set(path, v);
  };
  walk(root, "", 0);
  return { leaves, truncated };
}

/** Undefined maps to null so a key that is present-and-undefined compares
 *  equal to one that is present-and-null, which is how Postgres will have
 *  stored it either way. */
const sameLeaf = (a: unknown, b: unknown) => JSON.stringify([a]) === JSON.stringify([b]);

export function diffAuditJson(before: unknown, after: unknown): AuditDiff {
  const hasBefore = before !== null && before !== undefined;
  const hasAfter = after !== null && after !== undefined;
  if (!hasBefore && !hasAfter) {
    return { shape: "neither", rows: [], unchanged: 0, truncated: false };
  }

  const b = hasBefore ? flattenJson(before) : null;
  const a = hasAfter ? flattenJson(after) : null;
  const truncated = Boolean(b?.truncated || a?.truncated);

  if (!b) {
    return {
      shape: "after-only",
      rows: [...a!.leaves].map(([path, v]) => ({ path, before: null, after: formatLeaf(v) })),
      unchanged: 0,
      truncated,
    };
  }
  if (!a) {
    return {
      shape: "before-only",
      rows: [...b.leaves].map(([path, v]) => ({ path, before: formatLeaf(v), after: null })),
      unchanged: 0,
      truncated,
    };
  }

  const rows: AuditDiffRow[] = [];
  let unchanged = 0;
  for (const [path, av] of a.leaves) {
    if (!b.leaves.has(path)) { rows.push({ path, before: null, after: formatLeaf(av) }); continue; }
    const bv = b.leaves.get(path);
    if (sameLeaf(bv, av)) { unchanged += 1; continue; }
    rows.push({ path, before: formatLeaf(bv), after: formatLeaf(av) });
  }
  for (const [path, bv] of b.leaves) {
    if (a.leaves.has(path)) continue;
    rows.push({ path, before: formatLeaf(bv), after: null });
  }
  return { shape: "both", rows, unchanged, truncated };
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
      .select("billing_status, plan_status, suspended_at, suspended_reason, grace_expires_at, stripe_subscription_id")
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
      // Owner decision, 2026-08-19: "Clear grace on reactivate, and add End
      // grace." Reactivating says the problem that earned the concession is
      // resolved, so the concession ends with it. Without this line the column
      // survives — and `org_can_add_client` honours `grace_expires_at > now()`
      // in its own branch, regardless of plan_status — so a reactivated tenant
      // kept a client-limit allowance nobody re-granted, silently, until the
      // date some admin picked weeks earlier happened to pass.
      grace_expires_at: null,
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

/**
 * The other half of the same owner decision: a grace period could be SHORTENED
 * by re-granting one (minimum 1 day) and could not be REVOKED at all. Nothing
 * in this repo ever wrote `grace_expires_at` back to NULL, so a concession
 * granted by mistake — wrong tenant, wrong duration — ran to its date.
 *
 * What it writes, and what it deliberately does not:
 *
 *   grace_expires_at   NULL. This is the whole action; it is the only column
 *                      `org_can_add_client` reads for grace.
 *   billing_status     only when it currently reads "grace", which is a state
 *                      nothing but `grantGracePeriod` produces. Leaving it
 *                      would show a Grace badge for a grace period that no
 *                      longer exists. It resolves to "suspended" if the tenant
 *                      is suspended, otherwise to their own `plan_status` —
 *                      the truth about their entitlement, which is what the
 *                      grant was covering over.
 *   plan_status        never. Ending a concession must not change what the
 *                      tenant is entitled to underneath it, in either
 *                      direction. That is what Reactivate is for.
 *
 * An already-EXPIRED grace window is still endable. It is inert to the gate
 * (`> now()`), but it still reads as a live concession on the Overview tab and
 * still leaves the Grace badge up, and hiding the control would leave an admin
 * looking at a date they cannot clear. The result says which case it was, so
 * "it is ended" and "it had already lapsed" do not read the same.
 */
export const endGracePeriod = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => idSchema.parse(d))
  .handler(async ({ data, context }) => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: before } = await supabaseAdmin.from("organizations")
      .select("name, billing_status, plan_status, grace_expires_at, suspended_at")
      .eq("id", data.organization_id).maybeSingle();
    if (!before) throw new Error("Tenant not found");
    // Never a silent no-op: with nothing to end there is no audit row to write
    // and nothing to say, and a cheerful toast would claim otherwise.
    if (!before.grace_expires_at) throw new Error("This tenant has no grace period to end");

    const wasLive = new Date(before.grace_expires_at).getTime() > Date.now();
    // "grace" is a billing_status nothing but grantGracePeriod produces, so it
    // is the only one this resolves; anything else is written back unchanged.
    const nextBillingStatus =
      before.billing_status === "grace"
        ? (before.suspended_at ? "suspended" : before.plan_status)
        : before.billing_status;
    const patch = {
      grace_expires_at: null,
      billing_status: nextBillingStatus as any,
    };
    const { error } = await supabaseAdmin.from("organizations").update(patch).eq("id", data.organization_id);
    if (error) throw new Error(error.message);
    await audit(supabaseAdmin, context.userId, data.organization_id, "end_grace_period", {
      billing_status: before.billing_status,
      plan_status: before.plan_status,
      grace_expires_at: before.grace_expires_at,
      suspended_at: before.suspended_at,
    }, patch);
    return { ok: true, name: before.name as string, was_live: wasLive, ended_at: before.grace_expires_at as string };
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
