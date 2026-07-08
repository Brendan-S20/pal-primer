import type { AppRole } from "@/hooks/useMyRole";
import { hasPermission, type Permission } from "@/lib/permissions";

export type CallerContext = {
  orgId: string;
  role: AppRole;
};

/**
 * Resolve the caller's org membership from user_roles.
 * Throws if the user belongs to no organization.
 */
export async function resolveCaller(supabase: any, userId: string): Promise<CallerContext> {
  const { data, error } = await supabase
    .from("user_roles")
    .select("organization_id, role")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("No organization for user");
  return { orgId: data.organization_id as string, role: data.role as AppRole };
}

/**
 * The single server-side permission gate. Resolves the caller's role once and
 * throws a uniform error if the role lacks the capability. Use this in every
 * server function that performs a sensitive read or write — route-level
 * gating is cosmetic and must never be the only check.
 */
export async function requirePermission(
  supabase: any,
  userId: string,
  permission: Permission,
): Promise<CallerContext> {
  const caller = await resolveCaller(supabase, userId);
  if (!hasPermission(caller.role, permission)) {
    throw new Error("Not authorized");
  }
  return caller;
}
