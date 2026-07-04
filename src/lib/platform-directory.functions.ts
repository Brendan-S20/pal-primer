import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

async function assertAdmin(supabase: any, userId: string) {
  const { data, error } = await supabase.rpc("is_platform_admin", { _user_id: userId });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden");
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
        starts_at: data.starts_at ?? null,
        ends_at: data.ends_at ?? null,
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
  role: z.string().max(50).optional(),
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
            name: orgName.get(r.organization_id as string) ?? "—",
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
