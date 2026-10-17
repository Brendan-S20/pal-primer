import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { pinWalkGroupVisits, type RouteDayInputs } from "@/lib/route-inputs";

type AssignmentRow = {
  id: string;
  walk_group_id: string | null;
  walk_groups: {
    id: string;
    assigned_staff_id: string | null;
    earliest_time: string | null;
    latest_time: string | null;
  } | null;
  subscriptions: {
    stay_id: string | null;
    stays: { assigned_staff_id: string | null } | null;
  } | null;
};

/** One read for the day's visit IDs, shared by manual and background planning:
 *  each member's group, the group's walker and the group's window. A stay
 *  visit (#411) is pinned to the stay's sitter the same way: the client was
 *  promised that person in their home, and the optimizer may not hand the
 *  night to whoever is closer. */
export async function readWalkGroupAssignments(
  supabase: SupabaseClient<Database>,
  orgId: string,
  inputs: RouteDayInputs,
): Promise<RouteDayInputs> {
  if (inputs.visits.length === 0) return inputs;
  // One read for both: a visit is in a group, part of a stay, or neither.
  // Only a visit with a group or a plan can be either, so the rest are left
  // out. A stay's visits have no group, so the filter keeps plan visits too.
  const { data, error } = await (supabase as any)
    .from("visits")
    .select(
      "id, walk_group_id, walk_groups(id, assigned_staff_id, earliest_time, latest_time), subscriptions(stay_id, stays(assigned_staff_id))",
    )
    .eq("organization_id", orgId)
    .in(
      "id",
      inputs.visits.map((visit) => visit.id),
    )
    .or("walk_group_id.not.is.null,subscription_id.not.is.null");
  if (error) throw new Error(error.message);
  return pinWalkGroupVisits(
    inputs,
    ((data ?? []) as AssignmentRow[]).map((visit) => {
      // A group member keeps its group walker and window. A stay visit gets
      // the stay's sitter.
      if (visit.walk_group_id) {
        return {
          id: visit.id,
          walkerId: visit.walk_groups?.assigned_staff_id ?? null,
          groupId: visit.walk_group_id,
          earliest: visit.walk_groups?.earliest_time ?? null,
          latest: visit.walk_groups?.latest_time ?? null,
        };
      }
      return {
        id: visit.id,
        walkerId: visit.subscriptions?.stay_id
          ? (visit.subscriptions.stays?.assigned_staff_id ?? null)
          : null,
        groupId: null,
        earliest: null,
        latest: null,
      };
    }),
  );
}
