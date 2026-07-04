import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

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

function hexToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function anonServer() {
  return createClient<Database>(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_PUBLISHABLE_KEY!,
    { auth: { storage: undefined, persistSession: false, autoRefreshToken: false } },
  );
}

// ═══════════════════════════ INVITES ═══════════════════════════

export type PlatformInviteRow = {
  id: string;
  email: string;
  role: string;
  organization_id: string | null;
  organization_name: string | null;
  token: string;
  invite_url: string | null;
  invited_by: string | null;
  invited_by_email: string | null;
  accepted_at: string | null;
  accepted_by: string | null;
  revoked_at: string | null;
  expires_at: string;
  created_at: string;
  is_expired: boolean;
  status: "pending" | "accepted" | "revoked" | "expired";
};

export const listPlatformInvites = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ rows: PlatformInviteRow[] }> => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("platform_invites")
      .select("*, organizations:organization_id(name)")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);

    const inviterIds = Array.from(new Set((data ?? []).map((r) => r.invited_by).filter(Boolean))) as string[];
    const emails = new Map<string, string>();
    await Promise.all(inviterIds.slice(0, 50).map(async (uid) => {
      try {
        const { data: u } = await supabaseAdmin.auth.admin.getUserById(uid);
        if (u?.user?.email) emails.set(uid, u.user.email);
      } catch { /* ignore */ }
    }));

    const now = Date.now();
    const rows: PlatformInviteRow[] = (data ?? []).map((r: any) => {
      const isExpired = new Date(r.expires_at).getTime() < now;
      const status: PlatformInviteRow["status"] =
        r.accepted_at ? "accepted" :
        r.revoked_at ? "revoked" :
        isExpired ? "expired" : "pending";
      return {
        id: r.id,
        email: r.email,
        role: r.role,
        organization_id: r.organization_id,
        organization_name: r.organization_name ?? r.organizations?.name ?? null,
        token: r.token,
        invite_url: null, // filled in by client-side w/ origin
        invited_by: r.invited_by,
        invited_by_email: r.invited_by ? emails.get(r.invited_by) ?? null : null,
        accepted_at: r.accepted_at,
        accepted_by: r.accepted_by,
        revoked_at: r.revoked_at,
        expires_at: r.expires_at,
        created_at: r.created_at,
        is_expired: isExpired,
        status,
      };
    });
    return { rows };
  });

const createInviteSchema = z.object({
  email: z.string().trim().email().max(255),
  role: z.enum(["owner", "office_manager", "dispatcher", "tech", "platform_admin"]).default("owner"),
  // When organization_id is set, invite joins that org. Otherwise organization_name creates a NEW org on acceptance.
  organization_id: z.string().uuid().nullable().optional(),
  organization_name: z.string().trim().min(1).max(200).nullable().optional(),
  expires_in_days: z.number().int().min(1).max(30).default(7),
});

export const createPlatformInvite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => createInviteSchema.parse(d))
  .handler(async ({ data, context }) => {
    await assertPlatformAdmin(context.supabase, context.userId);
    if (!data.organization_id && !data.organization_name) {
      throw new Error("Provide organization_id (join existing) or organization_name (create new).");
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const token = hexToken(24);
    const expiresAt = new Date(Date.now() + data.expires_in_days * 24 * 60 * 60 * 1000).toISOString();
    const { data: inv, error } = await supabaseAdmin
      .from("platform_invites")
      .insert({
        email: data.email.toLowerCase(),
        role: data.role,
        organization_id: data.organization_id ?? null,
        organization_name: data.organization_name ?? null,
        token,
        expires_at: expiresAt,
        invited_by: context.userId,
      })
      .select("id, token")
      .single();
    if (error) throw new Error(error.message);
    await audit(supabaseAdmin, context.userId, data.organization_id ?? null, "create_invite", null, {
      email: data.email, role: data.role, organization_name: data.organization_name,
    });
    return { id: inv.id, token: inv.token };
  });

export const revokePlatformInvite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: before } = await supabaseAdmin.from("platform_invites")
      .select("email, organization_id, revoked_at").eq("id", data.id).maybeSingle();
    const { error } = await supabaseAdmin
      .from("platform_invites")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    await audit(supabaseAdmin, context.userId, before?.organization_id ?? null, "revoke_invite", before, null);
    return { ok: true };
  });

export const resendPlatformInvite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid(), extra_days: z.number().int().min(1).max(30).default(7) }).parse(d))
  .handler(async ({ data, context }) => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const newExpires = new Date(Date.now() + data.extra_days * 24 * 60 * 60 * 1000).toISOString();
    const newToken = hexToken(24);
    const { data: inv, error } = await supabaseAdmin
      .from("platform_invites")
      .update({ expires_at: newExpires, token: newToken, revoked_at: null })
      .eq("id", data.id)
      .select("email, organization_id, token")
      .single();
    if (error) throw new Error(error.message);
    await audit(supabaseAdmin, context.userId, inv.organization_id ?? null, "resend_invite", null, { new_expires: newExpires });
    return { token: inv.token };
  });

// ═══════════════════════════ SIGNUP REQUESTS ═══════════════════════════

export type PlatformSignupRequestRow = {
  id: string;
  organization_name: string;
  contact_name: string;
  contact_email: string;
  contact_phone: string | null;
  website: string | null;
  approx_client_count: number | null;
  notes: string | null;
  status: "pending" | "approved" | "denied";
  reviewed_by: string | null;
  reviewed_by_email: string | null;
  reviewed_at: string | null;
  denial_reason: string | null;
  created_invite_id: string | null;
  created_at: string;
};

// PUBLIC — no auth required. Called from the /request-access form.
const submitSignupSchema = z.object({
  organization_name: z.string().trim().min(1).max(200),
  contact_name: z.string().trim().min(1).max(120),
  contact_email: z.string().trim().email().max(255),
  contact_phone: z.string().trim().max(40).optional().or(z.literal("")),
  website: z.string().trim().max(255).optional().or(z.literal("")),
  approx_client_count: z.coerce.number().int().min(0).max(100000).optional().nullable(),
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
});

export const submitPlatformSignupRequest = createServerFn({ method: "POST" })
  .inputValidator((d) => submitSignupSchema.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const email = data.contact_email.toLowerCase();

    // De-dupe: reject if a pending request exists for same email + org.
    const { data: existing } = await supabaseAdmin
      .from("platform_signup_requests")
      .select("id, status")
      .eq("contact_email", email)
      .eq("status", "pending")
      .maybeSingle();
    if (existing) return { ok: true as const, id: existing.id, dedup: true };

    const { data: row, error } = await supabaseAdmin
      .from("platform_signup_requests")
      .insert({
        organization_name: data.organization_name,
        contact_name: data.contact_name,
        contact_email: email,
        contact_phone: data.contact_phone || null,
        website: data.website || null,
        approx_client_count: data.approx_client_count ?? null,
        notes: data.notes || null,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    void anonServer;
    return { ok: true as const, id: row.id, dedup: false };
  });

export const listPlatformSignupRequests = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ rows: PlatformSignupRequestRow[] }> => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("platform_signup_requests")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);

    const reviewerIds = Array.from(new Set((data ?? []).map((r) => r.reviewed_by).filter(Boolean))) as string[];
    const emails = new Map<string, string>();
    await Promise.all(reviewerIds.slice(0, 50).map(async (uid) => {
      try {
        const { data: u } = await supabaseAdmin.auth.admin.getUserById(uid);
        if (u?.user?.email) emails.set(uid, u.user.email);
      } catch { /* ignore */ }
    }));

    return {
      rows: (data ?? []).map((r) => ({
        ...(r as any),
        reviewed_by_email: r.reviewed_by ? emails.get(r.reviewed_by) ?? null : null,
      })) as PlatformSignupRequestRow[],
    };
  });

export const approvePlatformSignupRequest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: req, error: reqErr } = await supabaseAdmin
      .from("platform_signup_requests")
      .select("id, organization_name, contact_email, status")
      .eq("id", data.id)
      .maybeSingle();
    if (reqErr) throw new Error(reqErr.message);
    if (!req) throw new Error("Request not found");
    if (req.status !== "pending") throw new Error(`Already ${req.status}`);

    // Create invite that on acceptance will create a new org.
    const token = hexToken(24);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: inv, error: invErr } = await supabaseAdmin
      .from("platform_invites")
      .insert({
        email: req.contact_email,
        role: "owner",
        organization_id: null,
        organization_name: req.organization_name,
        token,
        expires_at: expiresAt,
        invited_by: context.userId,
      })
      .select("id, token")
      .single();
    if (invErr) throw new Error(invErr.message);

    const { error: updErr } = await supabaseAdmin
      .from("platform_signup_requests")
      .update({
        status: "approved",
        reviewed_by: context.userId,
        reviewed_at: new Date().toISOString(),
        created_invite_id: inv.id,
      })
      .eq("id", data.id);
    if (updErr) throw new Error(updErr.message);

    await audit(supabaseAdmin, context.userId, null, "approve_signup_request", { request_id: req.id }, { invite_id: inv.id });
    return { ok: true, invite_id: inv.id, invite_token: inv.token };
  });

export const denyPlatformSignupRequest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid(), reason: z.string().min(1).max(500) }).parse(d))
  .handler(async ({ data, context }) => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("platform_signup_requests")
      .update({
        status: "denied",
        reviewed_by: context.userId,
        reviewed_at: new Date().toISOString(),
        denial_reason: data.reason,
      })
      .eq("id", data.id)
      .eq("status", "pending");
    if (error) throw new Error(error.message);
    await audit(supabaseAdmin, context.userId, null, "deny_signup_request", { request_id: data.id }, { reason: data.reason });
    return { ok: true };
  });

// ═══════════════════════════ INVITE ACCEPTANCE (public) ═══════════════════════════

export type InviteLookupResult = {
  ok: boolean;
  reason?: "not_found" | "expired" | "revoked" | "accepted";
  email?: string;
  role?: string;
  organization_id?: string | null;
  organization_name?: string | null;
};

export const lookupInviteByToken = createServerFn({ method: "GET" })
  .inputValidator((d) => z.object({ token: z.string().min(10).max(200) }).parse(d))
  .handler(async ({ data }): Promise<InviteLookupResult> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: inv, error } = await supabaseAdmin
      .from("platform_invites")
      .select("email, role, organization_id, organization_name, expires_at, accepted_at, revoked_at, organizations:organization_id(name)")
      .eq("token", data.token)
      .maybeSingle();
    if (error || !inv) return { ok: false, reason: "not_found" };
    if (inv.accepted_at) return { ok: false, reason: "accepted" };
    if (inv.revoked_at) return { ok: false, reason: "revoked" };
    if (new Date(inv.expires_at).getTime() < Date.now()) return { ok: false, reason: "expired" };
    return {
      ok: true,
      email: inv.email,
      role: inv.role,
      organization_id: inv.organization_id,
      organization_name: inv.organization_name ?? (inv as any).organizations?.name ?? null,
    };
  });

const acceptInviteSchema = z.object({
  token: z.string().min(10).max(200),
});

export const acceptPlatformInvite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => acceptInviteSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Load user email to validate match.
    const { data: userRes } = await supabaseAdmin.auth.admin.getUserById(context.userId);
    const userEmail = userRes?.user?.email?.toLowerCase();
    if (!userEmail) throw new Error("Your account has no email address.");

    const { data: inv, error: invErr } = await supabaseAdmin
      .from("platform_invites")
      .select("id, email, role, organization_id, organization_name, expires_at, accepted_at, revoked_at")
      .eq("token", data.token)
      .maybeSingle();
    if (invErr) throw new Error(invErr.message);
    if (!inv) throw new Error("Invite not found.");
    if (inv.accepted_at) throw new Error("Invite already accepted.");
    if (inv.revoked_at) throw new Error("Invite was revoked.");
    if (new Date(inv.expires_at).getTime() < Date.now()) throw new Error("Invite expired.");
    if (inv.email.toLowerCase() !== userEmail) {
      throw new Error(`Invite is for ${inv.email}. Sign in with that email.`);
    }

    // Create org if this is a "new org" invite.
    let organizationId = inv.organization_id as string | null;
    if (!organizationId) {
      const orgName = inv.organization_name || `${inv.email.split("@")[0]}'s Organization`;
      const { data: org, error: orgErr } = await supabaseAdmin
        .from("organizations")
        .insert({ name: orgName, billing_status: "free" })
        .select("id")
        .single();
      if (orgErr) throw new Error(orgErr.message);
      organizationId = org.id;
    }

    // Grant role — idempotent via unique (user_id, role) already; add org scope.
    const { error: roleErr } = await supabaseAdmin
      .from("user_roles")
      .upsert(
        {
          user_id: context.userId,
          role: inv.role as any,
          organization_id: organizationId,
        } as any,
        { onConflict: "user_id,organization_id,role" as any },
      );
    if (roleErr) throw new Error(roleErr.message);

    // Mark accepted.
    await supabaseAdmin
      .from("platform_invites")
      .update({ accepted_at: new Date().toISOString(), accepted_by: context.userId })
      .eq("id", inv.id);

    await audit(supabaseAdmin, context.userId, organizationId, "accept_invite", null, { invite_id: inv.id });

    return { ok: true, organization_id: organizationId };
  });

// Helper for admin UI: list orgs for the "join existing org" select
export const listOrgsMinimal = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("organizations")
      .select("id, name")
      .is("deleted_at", null)
      .order("name", { ascending: true })
      .limit(500);
    if (error) throw new Error(error.message);
    return { rows: (data ?? []) as { id: string; name: string }[] };
  });
