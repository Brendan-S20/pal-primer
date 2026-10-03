// Server-only add-on bookkeeping shared by the Stripe webhook and the
// billing-status refresh. When an org's plan subscription dies, every add-on
// riding on it dies too (Stripe already dropped the items with the
// subscription); mirror that locally and switch the feature flags off, so a
// canceled org doesn't keep consuming paid features and a later
// re-subscribe starts from a clean, re-billable state (QA finding 3).

export async function deactivateOrgPlatformAddons(orgId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const admin = supabaseAdmin as any;

  const { data: rows } = await admin
    .from("org_platform_addons")
    .select("addon_id, platform_addons(feature_flag, billing_interval)")
    .eq("organization_id", orgId)
    .eq("status", "active");
  if (!rows?.length) return;

  // One-time purchases (e.g. done-for-you setup) were already paid in full;
  // only recurring add-ons are tied to the subscription's life.
  const recurring = rows.filter((r: any) => {
    const a = Array.isArray(r.platform_addons) ? r.platform_addons[0] : r.platform_addons;
    return a?.billing_interval !== "one_time";
  });
  if (!recurring.length) return;

  await admin
    .from("org_platform_addons")
    .update({ status: "canceled", canceled_at: new Date().toISOString() })
    .eq("organization_id", orgId)
    .eq("status", "active")
    .in("addon_id", recurring.map((r: any) => r.addon_id));

  // Voice rides on the receptionist add-on, so it goes off with it. Leaving
  // it on kept a cancelled business's phone line answered by the model.
  const FLAG_COLUMNS: Record<string, string[]> = {
    ai_receptionist: ["ai_receptionist_enabled", "ai_voice_enabled"],
  };
  const patch: Record<string, boolean> = {};
  for (const r of recurring) {
    const a = Array.isArray(r.platform_addons) ? r.platform_addons[0] : r.platform_addons;
    for (const col of a?.feature_flag ? (FLAG_COLUMNS[a.feature_flag] ?? []) : []) {
      patch[col] = false;
    }
  }
  if (Object.keys(patch).length) {
    await admin.from("organizations").update(patch).eq("id", orgId);
  }
}
