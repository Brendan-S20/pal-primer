// The stored side of Roles & permissions (#863): public.role_permission_overrides,
// read for one business and one role, as the map hasPermission takes.
//
// Here rather than in authz.server.ts because loadMyOrg reads it too, for the
// browser's own copy of the answer, and authz.server already carries one
// reader of its own for the request path (readPermissionOverrides, which
// tolerates a test double). This one is for callers that hold a real client.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppRole } from "@/hooks/useMyRole";
import type { Database } from "@/integrations/supabase/types";
import { overridesFromRows, type PermissionOverrides } from "@/lib/permissions";

export async function readRoleOverrides(
  supabase: unknown,
  orgId: string,
  role: AppRole,
): Promise<PermissionOverrides> {
  if (role === "owner") return {};
  const { data, error } = await (supabase as SupabaseClient<Database>)
    .from("role_permission_overrides")
    .select("permission, allowed")
    .eq("organization_id", orgId)
    .eq("role", role);
  if (error) throw new Error(error.message);
  return overridesFromRows(data);
}
