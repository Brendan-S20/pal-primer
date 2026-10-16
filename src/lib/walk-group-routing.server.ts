import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { pinWalkGroupVisits, type RouteDayInputs } from "@/lib/route-inputs";

/** One read for the day's visit IDs, shared by manual and background planning:
 *  each member's group, the group's walker and the group's window. */
export async function readWalkGroupAssignments(
  supabase: SupabaseClient<Database>,
  orgId: string,
  inputs: RouteDayInputs,
): Promise<RouteDayInputs> {
  if (inputs.visits.length === 0) return inputs;
  const { data, error } = await supabase
    .from("visits")
    .select("id, walk_group_id, walk_groups(id, assigned_staff_id, earliest_time, latest_time)")
    .eq("organization_id", orgId)
    .in(
      "id",
      inputs.visits.map((visit) => visit.id),
    )
    .not("walk_group_id", "is", null);
  if (error) throw new Error(error.message);
  return pinWalkGroupVisits(
    inputs,
    (data ?? []).map((visit) => ({
      id: visit.id,
      walkerId: visit.walk_groups?.assigned_staff_id ?? null,
      groupId: visit.walk_group_id ?? null,
      earliest: visit.walk_groups?.earliest_time ?? null,
      latest: visit.walk_groups?.latest_time ?? null,
    })),
  );
}
