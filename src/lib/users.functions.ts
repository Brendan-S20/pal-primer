import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

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

export const listOrgUsers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { data, error } = await context.supabase.rpc("list_org_users", { _org_id: orgId });
    if (error) throw new Error(error.message);
    return { users: data ?? [] };
  });

const roleEnum = z.enum(["owner", "office_manager", "dispatcher", "tech"]);

export const changeUserRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ userId: z.string().uuid(), role: roleEnum }).parse(d))
  .handler(async ({ data, context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { error } = await context.supabase.rpc("change_user_role", {
      _org_id: orgId,
      _user_id: data.userId,
      _new_role: data.role,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const setStaffActive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ staffId: z.string().uuid(), active: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.rpc("set_staff_active", {
      _staff_id: data.staffId,
      _active: data.active,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// Finding #26: routing eligibility flags. is_field_tech = "does fieldwork and
// can be routed"; routing_available = "available for routing right now"
// (temporary, e.g. on leave) without deleting the account.
export const setStaffRouting = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        staffId: z.string().uuid(),
        isFieldTech: z.boolean().optional(),
        routingAvailable: z.boolean().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { requirePermission } = await import("@/lib/authz.server");
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_users");
    const patch: Record<string, boolean> = {};
    if (data.isFieldTech !== undefined) patch.is_field_tech = data.isFieldTech;
    if (data.routingAvailable !== undefined) patch.routing_available = data.routingAvailable;
    if (Object.keys(patch).length === 0) return { ok: true };
    const { error } = await (context.supabase.from("staff") as any)
      .update(patch)
      .eq("id", data.staffId)
      .eq("organization_id", orgId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const listStaffAddresses = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { data, error } = await (context.supabase.from("staff") as any)
      .select("id, display_name, role, active, is_field_tech, routing_available, start_address, start_latitude, start_longitude, end_address, end_latitude, end_longitude")
      .eq("organization_id", orgId)
      .order("display_name");
    if (error) throw new Error(error.message);
    return { staff: data ?? [] };
  });

export const setStaffAddresses = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({
      staffId: z.string().uuid(),
      startAddress: z.string().max(300).nullable().optional(),
      startLatitude: z.number().min(-90).max(90).nullable().optional(),
      startLongitude: z.number().min(-180).max(180).nullable().optional(),
      endAddress: z.string().max(300).nullable().optional(),
      endLatitude: z.number().min(-90).max(90).nullable().optional(),
      endLongitude: z.number().min(-180).max(180).nullable().optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const patch: Record<string, any> = {};
    if (data.startAddress !== undefined) patch.start_address = data.startAddress || null;
    if (data.startLatitude !== undefined) patch.start_latitude = data.startLatitude;
    if (data.startLongitude !== undefined) patch.start_longitude = data.startLongitude;
    if (data.endAddress !== undefined) patch.end_address = data.endAddress || null;
    if (data.endLatitude !== undefined) patch.end_latitude = data.endLatitude;
    if (data.endLongitude !== undefined) patch.end_longitude = data.endLongitude;
    const { error } = await context.supabase
      .from("staff")
      .update(patch as any)
      .eq("id", data.staffId)
      .eq("organization_id", orgId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
