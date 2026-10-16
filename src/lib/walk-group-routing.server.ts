import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { pinWalkGroupVisits, type RouteDayInputs } from "@/lib/route-inputs";

/** One read for the day's visit IDs, shared by manual and background planning.
 *  A stay visit (#411) is pinned to the stay's sitter the same way: the
 *  client was promised that person in their home, and the optimizer may not
 *  hand the night to whoever is closer. */
export async function readWalkGroupAssignments(
  supabase: SupabaseClient<Database>,
  orgId: string,
  inputs: RouteDayInputs,
): Promise<RouteDayInputs> {
  if (inputs.visits.length === 0) return inputs;
  const ids = inputs.visits.map((visit) => visit.id);
  const [groups, stays] = await Promise.all([
    supabase
      .from("visits")
      .select("id, walk_group_id, walk_groups(assigned_staff_id)")
      .eq("organization_id", orgId)
      .in("id", ids)
      .not("walk_group_id", "is", null),
    (supabase as any)
      .from("visits")
      .select("id, subscriptions!inner(stay_id, stays!inner(assigned_staff_id))")
      .eq("organization_id", orgId)
      .in("id", ids)
      .not("subscriptions.stay_id", "is", null),
  ]);
  if (groups.error) throw new Error(groups.error.message);
  if (stays.error) throw new Error(stays.error.message);
  return pinWalkGroupVisits(inputs, [
    ...(groups.data ?? []).map((visit) => ({
      id: visit.id,
      walkerId: visit.walk_groups?.assigned_staff_id ?? null,
    })),
    ...((stays.data ?? []) as any[]).map((visit) => ({
      id: visit.id as string,
      walkerId: (visit.subscriptions?.stays?.assigned_staff_id as string | null) ?? null,
    })),
  ]);
}
