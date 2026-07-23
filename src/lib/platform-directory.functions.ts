import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

async function assertAdmin(supabase: any, userId: string) {
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
  } catch { /* audit best-effort */ }
}

// ─────────── Announcements ───────────

export type AnnouncementRow = {
  id: string;
  title: string;
  body: string;
  severity: string;
  audience: string;
  starts_at: string | null;
  ends_at: string | null;
  send_email: boolean;
  email_sent_at: string | null;
  created_by: string | null;
  created_at: string;
};

export const listAnnouncements = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { data, error } = await context.supabase
      .from("platform_announcements")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return { rows: (data ?? []) as AnnouncementRow[] };
  });

const createAnnouncementSchema = z.object({
  title: z.string().min(2).max(200),
  body: z.string().min(2).max(5000),
  severity: z.enum(["info", "success", "warning", "critical"]).default("info"),
  audience: z.enum(["all", "active", "trialing", "past_due", "admins"]).default("all"),
  starts_at: z.string().nullable().optional(),
  ends_at: z.string().nullable().optional(),
  send_email: z.boolean().default(false),
});

export const createAnnouncement = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => createAnnouncementSchema.parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await supabaseAdmin
      .from("platform_announcements")
      .insert({
        title: data.title,
        body: data.body,
        severity: data.severity,
        audience: data.audience,
        starts_at: data.starts_at ?? undefined,
        ends_at: data.ends_at ?? undefined,
        send_email: data.send_email,
        created_by: context.userId,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);

    try {
      await supabaseAdmin.from("platform_admin_audit").insert({
        actor_user_id: context.userId,
        organization_id: null,
        action: "create_announcement",
        after_json: { id: row.id, title: data.title, audience: data.audience, severity: data.severity },
      });
    } catch {}
    return { id: row.id };
  });

export const deleteAnnouncement = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("platform_announcements").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    try {
      await supabaseAdmin.from("platform_admin_audit").insert({
        actor_user_id: context.userId,
        organization_id: null,
        action: "delete_announcement",
        before_json: { id: data.id },
      });
    } catch {}
    return { ok: true };
  });

// ─────────── Global user directory ───────────

export type PlatformUserRow = {
  user_id: string;
  email: string | null;
  last_sign_in_at: string | null;
  created_at: string | null;
  organizations: Array<{ id: string; name: string; role: string }>;
};

const listUsersSchema = z.object({
  search: z.string().max(200).optional(),
  role: z.enum(["owner", "office_manager", "dispatcher", "tech"]).optional(),
  organization_id: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(200).default(100),
});

export const listPlatformUsers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => listUsersSchema.parse(d ?? {}))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Pull user_roles as our source of truth for org membership.
    let rolesQ = supabaseAdmin
      .from("user_roles")
      .select("user_id, role, organization_id")
      .limit(2000);
    if (data.organization_id) rolesQ = rolesQ.eq("organization_id", data.organization_id);
    if (data.role) rolesQ = rolesQ.eq("role", data.role);
    const { data: roles, error: rErr } = await rolesQ;
    if (rErr) throw new Error(rErr.message);

    const userIds = Array.from(new Set((roles ?? []).map((r) => r.user_id)));
    const orgIds = Array.from(new Set((roles ?? []).map((r) => r.organization_id).filter(Boolean))) as string[];
    const { data: orgs } = orgIds.length
      ? await supabaseAdmin.from("organizations").select("id, name").in("id", orgIds)
      : { data: [] as { id: string; name: string }[] };
    const orgName = new Map((orgs ?? []).map((o) => [o.id, o.name] as const));

    // Batch-fetch emails. Auth admin has no bulk-by-id, so cap parallelism.
    const emailInfo = new Map<string, { email: string | null; last_sign_in_at: string | null; created_at: string | null }>();
    const capped = userIds.slice(0, data.limit);
    await Promise.all(
      capped.map(async (uid) => {
        try {
          const { data: u } = await supabaseAdmin.auth.admin.getUserById(uid);
          if (u?.user) {
            emailInfo.set(uid, {
              email: u.user.email ?? null,
              last_sign_in_at: u.user.last_sign_in_at ?? null,
              created_at: u.user.created_at ?? null,
            });
          }
        } catch { /* ignore */ }
      }),
    );

    const rows: PlatformUserRow[] = capped.map((uid) => {
      const info = emailInfo.get(uid);
      return {
        user_id: uid,
        email: info?.email ?? null,
        last_sign_in_at: info?.last_sign_in_at ?? null,
        created_at: info?.created_at ?? null,
        organizations: (roles ?? [])
          .filter((r) => r.user_id === uid && r.organization_id)
          .map((r) => ({
            id: r.organization_id as string,
            name: orgName.get(r.organization_id as string) ?? "-",
            role: r.role,
          })),
      };
    });

    const search = data.search?.toLowerCase().trim();
    const filtered = search
      ? rows.filter((r) =>
          (r.email ?? "").toLowerCase().includes(search) ||
          r.user_id.toLowerCase().includes(search) ||
          r.organizations.some((o) => o.name.toLowerCase().includes(search)),
        )
      : rows;

    return { rows: filtered, total: userIds.length };
  });

// ─────────── User detail + auth admin actions ───────────
// All platform-admin gated, audit-logged, and executed with
// supabaseAdmin.auth.admin.* (service role) — never the caller's session.

const userIdSchema = z.object({ userId: z.string().uuid() });

export type PlatformUserDetail = {
  user_id: string;
  email: string | null;
  phone: string | null;
  created_at: string | null;
  last_sign_in_at: string | null;
  email_confirmed_at: string | null;
  organizations: Array<{ id: string; name: string; role: string }>;
  mfa_factors: Array<{
    id: string;
    factor_type: string;
    friendly_name: string | null;
    status: string;
    created_at: string | null;
  }>;
};

export const getPlatformUserDetail = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => userIdSchema.parse(d))
  .handler(async ({ data, context }): Promise<PlatformUserDetail> => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const [{ data: userRes, error: userErr }, factorsRes, rolesRes] = await Promise.all([
      supabaseAdmin.auth.admin.getUserById(data.userId),
      supabaseAdmin.auth.admin.mfa.listFactors({ userId: data.userId }),
      supabaseAdmin.from("user_roles").select("organization_id, role").eq("user_id", data.userId),
    ]);
    if (userErr) throw new Error(userErr.message);
    const user = userRes.user;
    if (!user) throw new Error("User not found");

    const orgIds = Array.from(
      new Set((rolesRes.data ?? []).map((r) => r.organization_id).filter(Boolean)),
    ) as string[];
    const { data: orgs } = orgIds.length
      ? await supabaseAdmin.from("organizations").select("id, name").in("id", orgIds)
      : { data: [] as { id: string; name: string }[] };
    const orgName = new Map((orgs ?? []).map((o) => [o.id, o.name] as const));

    return {
      user_id: user.id,
      email: user.email ?? null,
      phone: user.phone || null,
      created_at: user.created_at ?? null,
      last_sign_in_at: user.last_sign_in_at ?? null,
      email_confirmed_at: user.email_confirmed_at ?? null,
      organizations: (rolesRes.data ?? [])
        .filter((r) => r.organization_id)
        .map((r) => ({
          id: r.organization_id as string,
          name: orgName.get(r.organization_id as string) ?? "-",
          role: r.role,
        })),
      mfa_factors: (factorsRes.data?.factors ?? []).map((f: any) => ({
        id: f.id,
        factor_type: f.factor_type,
        friendly_name: f.friendly_name ?? null,
        status: f.status,
        created_at: f.created_at ?? null,
      })),
    };
  });

/**
 * Generates a Supabase recovery link for the user and emails it via Resend
 * (the same direct-send pattern the concerns reply / invite emails use).
 * If email isn't configured, the link is returned so the admin can hand it
 * to the user out of band (the UI shows a copy button + a warning).
 */
export const sendPasswordReset = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => userIdSchema.parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: userRes, error: userErr } = await supabaseAdmin.auth.admin.getUserById(data.userId);
    if (userErr) throw new Error(userErr.message);
    const email = userRes.user?.email;
    if (!email) throw new Error("This user has no email on file.");

    const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
      type: "recovery",
      email,
    });
    if (linkErr) throw new Error(linkErr.message);
    const actionLink = linkData.properties?.action_link;
    if (!actionLink) throw new Error("Failed to generate a recovery link.");

    let delivered = false;
    const resendApiKey = process.env.RESEND_API_KEY;
    if (resendApiKey) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "HoundStack <noreply@notify.houndstack.com>",
          to: [email],
          subject: "Reset your HoundStack password",
          html:
            `<p>A password reset was requested for your HoundStack account by platform support.</p>` +
            `<p><a href="${actionLink}">Click here to set a new password</a>. The link expires shortly and can only be used once.</p>` +
            `<p>If you didn't expect this, you can ignore this email — your password is unchanged.</p>`,
          text: `A password reset was requested for your HoundStack account by platform support. Set a new password here: ${actionLink}\n\nIf you didn't expect this, ignore this email.`,
        }),
      });
      if (!res.ok) {
        const b = await res.text().catch(() => "");
        throw new Error(`Couldn't send the reset email${b ? `: ${b.slice(0, 140)}` : ""}`);
      }
      delivered = true;
    }

    await audit(supabaseAdmin, context.userId, null, "send_password_reset", null, {
      target_user_id: data.userId,
      email,
      delivered_via: delivered ? "email" : "link_returned_to_admin",
    });

    // Only expose the raw link when there's no way to deliver it directly.
    return delivered
      ? { sent: true as const, email }
      : { sent: false as const, email, actionLink };
  });

const updateEmailSchema = z.object({
  userId: z.string().uuid(),
  email: z.string().trim().email().max(254),
});

export const updatePlatformUserEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => updateEmailSchema.parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: beforeRes, error: beforeErr } = await supabaseAdmin.auth.admin.getUserById(data.userId);
    if (beforeErr) throw new Error(beforeErr.message);
    if (!beforeRes.user) throw new Error("User not found");
    const oldEmail = beforeRes.user.email ?? null;

    const { error } = await supabaseAdmin.auth.admin.updateUserById(data.userId, {
      email: data.email,
      email_confirm: true,
    });
    if (error) throw new Error(error.message);

    await audit(
      supabaseAdmin,
      context.userId,
      null,
      "update_user_email",
      { target_user_id: data.userId, email: oldEmail },
      { target_user_id: data.userId, email: data.email },
    );
    return { ok: true };
  });

const updatePhoneSchema = z.object({
  userId: z.string().uuid(),
  // E.164-ish: "+" then 7-15 digits. null clears the phone.
  phone: z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{6,14}$/, "Phone must be E.164, e.g. +15555550123")
    .nullable(),
});

export const updatePlatformUserPhone = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => updatePhoneSchema.parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: beforeRes, error: beforeErr } = await supabaseAdmin.auth.admin.getUserById(data.userId);
    if (beforeErr) throw new Error(beforeErr.message);
    if (!beforeRes.user) throw new Error("User not found");
    const oldPhone = beforeRes.user.phone || null;

    // GoTrue clears the phone when given an empty string.
    const { error } = await supabaseAdmin.auth.admin.updateUserById(data.userId, {
      phone: data.phone ?? "",
    });
    if (error) throw new Error(error.message);

    await audit(
      supabaseAdmin,
      context.userId,
      null,
      "update_user_phone",
      { target_user_id: data.userId, phone: oldPhone },
      { target_user_id: data.userId, phone: data.phone },
    );
    return { ok: true };
  });

export const removePlatformUserMfa = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => userIdSchema.parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: factorsData, error: listErr } = await supabaseAdmin.auth.admin.mfa.listFactors({
      userId: data.userId,
    });
    if (listErr) throw new Error(listErr.message);
    const factors = factorsData?.factors ?? [];

    for (const f of factors) {
      const { error } = await supabaseAdmin.auth.admin.mfa.deleteFactor({
        id: f.id,
        userId: data.userId,
      });
      if (error) throw new Error(error.message);
    }

    await audit(
      supabaseAdmin,
      context.userId,
      null,
      "remove_user_mfa",
      { target_user_id: data.userId, factor_count: factors.length },
      { target_user_id: data.userId, factor_count: 0 },
    );
    return { ok: true, removed: factors.length };
  });
