import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";

async function resolveOrgId(supabase: any, userId: string): Promise<string> {
  const { data, error } = await supabase
    .from("user_roles")
    .select("organization_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("No organization for user");
  return data.organization_id as string;
}

// Blackout dates are scheduling configuration (owner/office_manager), not a
// dispatcher-reachable write (I7).
async function resolveManagerOrgId(supabase: any, userId: string): Promise<string> {
  return (await requirePermission(supabase, userId, "manage_settings")).orgId;
}

export const listBlackouts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);
    const { data, error } = await supabase
      .from("blackout_dates")
      .select("id, blackout_on, reason")
      .eq("organization_id", orgId)
      .order("blackout_on");
    if (error) throw new Error(error.message);
    return { blackouts: data ?? [] };
  });

export const addBlackout = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ blackoutOn: z.string(), reason: z.string().max(200).optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveManagerOrgId(supabase, userId);
    const { error } = await supabase.from("blackout_dates").insert({
      organization_id: orgId,
      blackout_on: data.blackoutOn,
      reason: data.reason || null,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteBlackout = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveManagerOrgId(supabase, userId);
    const { error } = await supabase
      .from("blackout_dates")
      .delete()
      .eq("id", data.id)
      .eq("organization_id", orgId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
