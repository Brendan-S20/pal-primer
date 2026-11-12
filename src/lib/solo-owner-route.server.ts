// A one-person business's first plan has somebody to run it (D13, onboarding
// audit 2026-11-09).
//
// ── WHAT THE PILOT SAW ──────────────────────────────────────────────────
//
// The guide asks for the first client (step 3) before "Who runs the route"
// (step 4), and on purpose: a client is the step that makes every other
// screen do something (see the order note in onboarding.functions.ts). But
// visits are only handed to ACTIVE FIELD TECHNICIANS, and an owner is not one
// until they press "That's me" on step 4. So the owner of a one-person
// business saved their first weekly plan and got eight visits reading
// "Unassigned", a schedule reading "0 Unassigned / No visits today", and
// nothing on My Day, with nobody else in the business they could ever belong
// to.
//
// ── WHAT THIS DOES ──────────────────────────────────────────────────────
//
// When a plan is saved in a business whose ONLY active person is the owner
// saving it, and no invitation is waiting on a tech, the owner is the one who
// runs the route: there is nobody else it can be. They are put on routes (the
// same write as "That's me", marked as a human decision so the role-based
// reconciliation leaves it alone) and the plan's unassigned visits are theirs.
// The new-client form says so in its toast, with where to change it.
//
// It does nothing when there is anybody else: a second active person, a
// pending invite, or a caller who is not the owner. Those businesses have a
// choice to make and the dispatch board is where they make it.
//
// The database half (20261109200000) gives the nightly generator the same
// answer for every visit it makes after this one.

type Db = any;

export type SoloStaffRow = {
  id: string;
  user_id: string | null;
  role: string | null;
  active: boolean | null;
  is_field_tech: boolean | null;
};

/** The owner who must run the route, or null when somebody else could. */
export function soloOwnerRunsTheRoute(
  staff: readonly SoloStaffRow[],
  pendingInvites: number,
  userId: string,
): { staffId: string; alreadyRunsRoutes: boolean } | null {
  const active = staff.filter((s) => s.active !== false);
  if (active.length !== 1 || pendingInvites > 0) return null;
  const only = active[0];
  if (only.user_id !== userId || only.role !== "owner") return null;
  return { staffId: only.id, alreadyRunsRoutes: !!only.is_field_tech };
}

/** Put the sole owner on routes if needed, and give them this plan's
 *  unassigned visits. Never throws: the client and plan already exist, and a
 *  failure here leaves the visits as they would have been. */
export async function giveSoloOwnerThePlan(
  supabase: Db,
  args: { orgId: string; userId: string; subscriptionId: string },
): Promise<{ assigned: number; putOnRoutes: boolean } | null> {
  try {
    const [{ data: staff, error: sErr }, { count: invites }] = await Promise.all([
      supabase
        .from("staff")
        .select("id, user_id, role, active, is_field_tech")
        .eq("organization_id", args.orgId)
        .eq("active", true),
      supabase
        .from("org_invites")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", args.orgId)
        .eq("status", "pending"),
    ]);
    if (sErr) return null;
    const owner = soloOwnerRunsTheRoute(staff ?? [], invites ?? 0, args.userId);
    if (!owner) return null;

    if (!owner.alreadyRunsRoutes) {
      const { error } = await supabase
        .from("staff")
        .update({ is_field_tech: true, is_field_tech_overridden: true })
        .eq("id", owner.staffId)
        .eq("organization_id", args.orgId);
      if (error) return null;
    }

    const { data: moved, error: vErr } = await supabase
      .from("visits")
      .update({ assigned_staff_id: owner.staffId })
      .eq("organization_id", args.orgId)
      .eq("subscription_id", args.subscriptionId)
      .is("assigned_staff_id", null)
      .select("id");
    if (vErr) console.warn("solo owner assignment failed:", vErr.message);
    return { assigned: moved?.length ?? 0, putOnRoutes: !owner.alreadyRunsRoutes };
  } catch (e) {
    console.warn("solo owner assignment failed:", (e as Error).message);
    return null;
  }
}
