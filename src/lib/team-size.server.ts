// Server half of the team-size caps (spec NP-10). Reads through the service
// role, so a caller's own RLS view of `staff` cannot undercount the team.
//
// The database trigger `staff_team_size_cap` (20261009160000) refuses the same
// thing in the same words for every path that never passes through here; this
// file exists so the server functions can say no BEFORE they write, and so the
// plan picker can grey out a plan before anybody clicks it.
import { addUserRefusal, capApplies, type TeamSizePlan } from "@/lib/team-size";

export type TeamSizeContext = {
  /** Enabled users (`staff.active`) — every one counts (owner, Oct 9). */
  enabled: number;
  /** The org's chosen plan, when it has one. */
  plan: (TeamSizePlan & { id: string }) | null;
  /** Active, self-serve plans, for "move to …" and range labels. */
  plans: Array<TeamSizePlan & { id: string }>;
  /** False during a trial, on a comped account, or with no plan chosen. */
  capped: boolean;
};

export async function teamSizeContext(orgId: string): Promise<TeamSizeContext> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const admin = supabaseAdmin as any;
  const [{ data: org }, { data: plans }, { count }] = await Promise.all([
    admin
      .from("organizations")
      .select("plan_id, billing_status, plan_status, is_comped")
      .eq("id", orgId)
      .maybeSingle(),
    admin
      .from("platform_plans")
      .select("id, name, slug, max_team_size, included_seats, is_enterprise")
      .eq("is_active", true)
      .eq("is_enterprise", false),
    admin
      .from("staff")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("active", true),
  ]);
  const all = ((plans ?? []) as Array<TeamSizePlan & { id: string }>).filter((p) => p.included_seats != null);
  let plan = all.find((p) => p.id === org?.plan_id) ?? null;
  if (!plan && org?.plan_id) {
    // A retired or Enterprise plan is still the org's plan; read it on its own.
    const { data } = await admin
      .from("platform_plans")
      .select("id, name, slug, max_team_size, included_seats, is_enterprise")
      .eq("id", org.plan_id)
      .maybeSingle();
    plan = data ?? null;
  }
  return {
    enabled: count ?? 0,
    plan,
    plans: all,
    capped: !!org && capApplies(org) && plan?.max_team_size != null,
  };
}

/** Throws the NP-10 sentence when one more enabled user would pass the cap. */
export async function assertRoomForAnotherUser(orgId: string): Promise<void> {
  const ctx = await teamSizeContext(orgId);
  if (!ctx.capped) return;
  const refusal = addUserRefusal(ctx.plan, ctx.enabled, ctx.plans);
  if (refusal) throw new Error(refusal);
}
