// Viewer-facing announcement server functions used by the in-app banner.
// Any authenticated user may list active announcements they haven't dismissed
// and mark them as read. Admin-only mutations live in platform-directory.functions.ts.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export type ActiveAnnouncement = {
  id: string;
  title: string;
  body: string;
  severity: string;
  audience: string;
  starts_at: string | null;
  ends_at: string | null;
  created_at: string;
};

export const listActiveAnnouncements = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    // Active window is enforced by RLS SELECT policy on the table.
    const { data: all, error } = await context.supabase
      .from("platform_announcements")
      .select("id, title, body, severity, audience, starts_at, ends_at, created_at")
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);

    const { data: reads } = await context.supabase
      .from("platform_announcement_reads")
      .select("announcement_id")
      .eq("user_id", context.userId);
    const dismissed = new Set((reads ?? []).map((r) => r.announcement_id));

    // Audience filter: 'all' or 'admins' handled here; plan-status filters
    // require org lookup, done server-side for accuracy.
    const rows = (all ?? []).filter((a) => !dismissed.has(a.id));

    // If any row targets a plan_status audience, resolve caller's orgs once.
    const needsOrgStatus = rows.some((r) =>
      ["active", "trialing", "past_due"].includes(r.audience),
    );
    const needsAdmin = rows.some((r) => r.audience === "admins");

    let orgStatuses: string[] = [];
    let isAdmin = false;
    if (needsOrgStatus) {
      const { data: roles } = await context.supabase
        .from("user_roles")
        .select("organization_id")
        .eq("user_id", context.userId);
      const orgIds = Array.from(new Set((roles ?? []).map((r) => r.organization_id).filter(Boolean))) as string[];
      if (orgIds.length) {
        const { data: orgs } = await context.supabase
          .from("organizations")
          .select("plan_status")
          .in("id", orgIds);
        orgStatuses = (orgs ?? []).map((o: { plan_status: string | null }) => o.plan_status ?? "").filter(Boolean);
      }
    }
    if (needsAdmin) {
      const { data } = await context.supabase.rpc("is_platform_admin", { _user_id: context.userId });
      isAdmin = !!data;
    }

    const filtered = rows.filter((r) => {
      switch (r.audience) {
        case "all":
          return true;
        case "admins":
          return isAdmin;
        case "active":
        case "trialing":
        case "past_due":
          return orgStatuses.includes(r.audience);
        default:
          // Legacy `plan:<slug>` audience — show to everyone until we wire plan
          // matching. Safer than hiding potentially important messages.
          return true;
      }
    });

    return { rows: filtered as ActiveAnnouncement[] };
  });

export const dismissAnnouncement = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("platform_announcement_reads")
      .upsert({ announcement_id: data.id, user_id: context.userId });
    if (error) throw new Error(error.message);
    return { ok: true };
  });
