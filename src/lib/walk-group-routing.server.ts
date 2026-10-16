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
  // One read for both: a visit is in a group, part of a stay, or neither.
  const { data, error } = await (supabase as any)
    .from("visits")
    .select(
      "id, walk_group_id, walk_groups(assigned_staff_id), subscriptions(stay_id, stays(assigned_staff_id))",
    )
    .eq("organization_id", orgId)
    .in(
      "id",
      inputs.visits.map((visit) => visit.id),
    );
  if (error) throw new Error(error.message);
  return pinWalkGroupVisits(
    inputs,
    ((data ?? []) as any[]).map((visit) => ({
      id: visit.id as string,
      walkerId:
        ((visit.walk_group_id ? visit.walk_groups?.assigned_staff_id : null) as string | null) ??
        ((visit.subscriptions?.stay_id
          ? visit.subscriptions?.stays?.assigned_staff_id
          : null) as string | null) ??
        null,
    })),
  );
}
