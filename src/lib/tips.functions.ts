import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";

// Whether customers are offered a tip when they pay -- the tenant's switch.
//
// Gated on `manage_org_billing`, beside the processing-fee setting: turning it
// on changes what a homeowner is asked for on the pay screen, so it belongs
// with the other decisions about what customers are charged, not with general
// preferences. Off for businesses that existed when tipping shipped, on for
// every one created after (20260929030000).

export const getTipSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { orgId } = await requirePermission(
      context.supabase,
      context.userId,
      "manage_org_billing",
    );
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("organizations")
      .select("tips_enabled")
      .eq("id", orgId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return { tipsEnabled: !!data?.tips_enabled };
  });

export const setTipsEnabled = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ enabled: z.boolean() }).parse(d))
  .handler(async ({ context, data }) => {
    const { orgId } = await requirePermission(
      context.supabase,
      context.userId,
      "manage_org_billing",
    );
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("organizations")
      .update({ tips_enabled: data.enabled })
      .eq("id", orgId);
    if (error) throw new Error(error.message);
    return { tipsEnabled: data.enabled };
  });
