// Writing to your own organization, loudly.
//
// ── WHAT WAS ACTUALLY WRONG ────────────────────────────────────────────────
//
// `supabase.from("organizations").update(patch).eq("id", orgId)` returns NO
// ERROR when the update matches zero rows, because an UPDATE that affects
// nothing is a successful UPDATE. So an RLS policy that disagreed with the
// permission matrix — "Owners update own org" versus a `manage_settings` that
// office_manager holds — turned every office-manager settings change into a
// success toast over a value that never moved. Reload and it is back.
//
// 20260731180000 fixed that specific disagreement. This exists because the
// SHAPE of the failure will recur: any future policy change, any column
// constraint, any row that has been soft-deleted underneath the caller
// produces the same silent success, and the only signal is a user saying "it
// keeps forgetting my setting".
//
// So: ask for the row back, and refuse to claim success without it. The cost
// is one returned column; the alternative is a class of bug that cannot be
// observed from the server side at all.

/**
 * Update the caller's own organization and confirm a row was actually written.
 *
 * Throws when the update matched nothing, which under RLS means "you were not
 * allowed to write this row" rather than "the row is gone" — the caller has
 * already resolved orgId from their own membership.
 */
export async function updateOwnOrg(
  supabase: any,
  orgId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { data, error } = await supabase
    .from("organizations")
    .update(patch)
    .eq("id", orgId)
    .select("id");
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) {
    // Deliberately not "permission denied": the caller passed a permission
    // check to get here, so if this fires, the two layers disagree and the
    // person reading it needs to know it is our problem, not theirs.
    throw new Error(
      "That change wasn't saved — your account doesn't have write access to these settings. This is a bug on our side; please tell support what you were changing.",
    );
  }
}
