import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Platform admin console → Add-ons page: manage the platform_addons catalog
// (the upsell shelf tenants see on Settings → Billing). Lifecycle status:
//   active      → tenants can subscribe
//   coming_soon → visible to tenants with a "Coming soon" badge, not buyable
//   disabled    → hidden from the tenant catalog
// The tenant-facing list/subscribe fns live in platform-addons.functions.ts.

async function assertPlatformAdmin(supabase: any, userId: string) {
  const { data, error } = await supabase.rpc("is_platform_admin", { _user_id: userId });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden");
}

export type AddonStatus = "active" | "disabled" | "coming_soon";

export type PlatformAddonAdminRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  price_cents: number;
  billing_interval: string;
  status: AddonStatus;
  is_active: boolean;
  sort_order: number;
  active_subscriptions: number;
  created_at: string;
};

export const listPlatformAddonsAdmin = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ rows: PlatformAddonAdminRow[] }> => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const [catalogRes, subsRes] = await Promise.all([
      (supabaseAdmin as any)
        .from("platform_addons")
        .select("id, slug, name, description, price_cents, billing_interval, status, is_active, sort_order, created_at")
        .order("sort_order", { ascending: true }),
      (supabaseAdmin as any)
        .from("org_platform_addons")
        .select("addon_id")
        .eq("status", "active"),
    ]);
    if (catalogRes.error) throw new Error(catalogRes.error.message);
    if (subsRes.error) throw new Error(subsRes.error.message);

    const counts = new Map<string, number>();
    for (const s of subsRes.data ?? []) {
      counts.set(s.addon_id, (counts.get(s.addon_id) ?? 0) + 1);
    }

    return {
      rows: (catalogRes.data ?? []).map((a: any): PlatformAddonAdminRow => ({
        id: a.id,
        slug: a.slug,
        name: a.name,
        description: a.description,
        price_cents: a.price_cents,
        billing_interval: a.billing_interval,
        status: (a.status ?? (a.is_active ? "active" : "disabled")) as AddonStatus,
        is_active: a.is_active,
        sort_order: a.sort_order,
        active_subscriptions: counts.get(a.id) ?? 0,
        created_at: a.created_at,
      })),
    };
  });

const setStatusSchema = z.object({
  addonId: z.string().uuid(),
  status: z.enum(["active", "disabled", "coming_soon"]),
});

export const setPlatformAddonStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => setStatusSchema.parse(d))
  .handler(async ({ data, context }) => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: before, error: beforeErr } = await (supabaseAdmin as any)
      .from("platform_addons")
      .select("id, slug, name, status, is_active")
      .eq("id", data.addonId)
      .maybeSingle();
    if (beforeErr) throw new Error(beforeErr.message);
    if (!before) throw new Error("Add-on not found");

    // is_active is kept in sync here (chosen over a DB trigger): existing
    // reads still filter on the boolean.
    const patch = {
      status: data.status,
      is_active: data.status === "active",
      updated_at: new Date().toISOString(),
    };
    const { error } = await (supabaseAdmin as any)
      .from("platform_addons")
      .update(patch)
      .eq("id", data.addonId);
    if (error) throw new Error(error.message);

    try {
      await supabaseAdmin.from("platform_admin_audit").insert({
        actor_user_id: context.userId,
        organization_id: null,
        action: "update_addon_status",
        before_json: { id: before.id, slug: before.slug, status: before.status, is_active: before.is_active },
        after_json: { id: before.id, slug: before.slug, status: patch.status, is_active: patch.is_active },
      });
    } catch { /* audit best-effort */ }

    return { ok: true };
  });
