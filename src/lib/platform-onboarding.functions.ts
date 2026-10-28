import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { resolveSupabaseUrl } from "@/lib/supabase-url";

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
    resolveSupabaseUrl(),
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
  role: z.enum(["owner", "office_manager", "dispatcher", "tech"]).default("owner"),
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

// The platform signup-request flow (public /request-access form + admin
// approval queue) was removed per owner direction: tenants arrive via direct
// signup (junk-name validated) or platform invites only.

// ═══════════════════════════ INVITE ACCEPTANCE (public) ═══════════════════════════

export type InviteLookupResult = {
  ok: boolean;
  /** "staff" is a teammate invitation (org_invites), accepted through
   *  accept_org_invite_for_current_user; "platform" is a platform_invites row,
   *  accepted through acceptPlatformInvite. */
  kind?: "platform" | "staff";
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
    // Teammate invitations live in org_invites, and this page only ever read
    // platform_invites, so every staff link said "Invite not found" (#568).
    if (error || !inv) return lookupStaffInvite(supabaseAdmin, data.token);
    if (inv.accepted_at) return { ok: false, reason: "accepted" };
    if (inv.revoked_at) return { ok: false, reason: "revoked" };
    if (new Date(inv.expires_at).getTime() < Date.now()) return { ok: false, reason: "expired" };
    return {
      ok: true,
      kind: "platform",
      email: inv.email,
      role: inv.role,
      organization_id: inv.organization_id,
      organization_name: inv.organization_name ?? (inv as any).organizations?.name ?? null,
    };
  });

async function lookupStaffInvite(admin: any, token: string): Promise<InviteLookupResult> {
  const { data: inv, error } = await admin
    .from("org_invites")
    .select("email, role, status, expires_at, organization_id, organizations:organization_id(name)")
    .eq("token", token)
    .maybeSingle();
  if (error || !inv) return { ok: false, reason: "not_found" };
  if (inv.status === "accepted") return { ok: false, reason: "accepted" };
  if (inv.status !== "pending") return { ok: false, reason: "revoked" };
  if (new Date(inv.expires_at).getTime() < Date.now()) return { ok: false, reason: "expired" };
  return {
    ok: true,
    kind: "staff",
    email: inv.email,
    role: inv.role,
    organization_id: inv.organization_id,
    organization_name: inv.organizations?.name ?? null,
  };
}

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
