/**
 * Whether an account with no business is a signup that has not finished, or a
 * person who used to belong to one.
 *
 * ── WHY (Detroit Doo Disposal, 2026-11-09) ────────────────────────────────
 *
 * ensureBootstrapped used to read "no user_roles and an `org_name` in user
 * metadata" as "a signup whose business was never created", and created it.
 * But `org_name` is written once, at signup, and never cleared. A person who
 * was attached to a business and later taken off it still carries it, so on
 * their next sign-in the app silently built a SECOND business named after the
 * one they had just been removed from, and made them its owner.
 *
 * The two cases look identical from the client, so the difference is now
 * recorded where only the server can write it: `registerAccount` sets
 * `app_metadata.signup_org_pending` when it creates an account that named a
 * business, and every path that gives the account a membership clears it
 * (bootstrapOrganization, acceptPlatformInvite, and
 * accept_org_invite_for_current_user in 20261109180000). app_metadata, not
 * user_metadata, because a person can rewrite their own user_metadata.
 *
 * An account WITHOUT the marker and without a membership is sent to
 * /no-workspace, which asks: create a business, or wait for a re-invite.
 * That includes accounts created before the marker existed; for them the
 * page is one extra form, and the alternative is guessing.
 */
export const SIGNUP_ORG_PENDING = "signup_org_pending" as const;

export function isUnfinishedSignup(user: {
  app_metadata?: Record<string, unknown> | null;
}): boolean {
  return user.app_metadata?.[SIGNUP_ORG_PENDING] === true;
}

/** Clear the marker. Server only (service role); best effort, because the
 *  membership it records is already written and the marker only matters to
 *  an account that has none. */
export async function clearSignupMarker(admin: any, userId: string): Promise<void> {
  try {
    const { error } = await admin.auth.admin.updateUserById(userId, {
      app_metadata: { [SIGNUP_ORG_PENDING]: false },
    });
    if (error) console.error("clearing the signup marker failed", error.message);
  } catch (e) {
    console.error("clearing the signup marker failed", (e as Error).message);
  }
}
