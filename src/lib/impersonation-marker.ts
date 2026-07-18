// Impersonation marker for tenant activity entries (H2 deferred item).
//
// Actions a platform admin takes while impersonating a user are written to the
// tenant activity_log as that user. The marker keys PRECISELY off the minted
// auth session: consumeImpersonation stores the session's JWT `session_id` on
// the grant, and logActivity looks the current request's session id up against
// unended grants. An exact session-id match cannot false-positive against the
// user's own sessions in other tabs (they have different session ids), which
// was the risk that deferred this originally.
//
// Pure helpers live here so they can be unit-tested without server-only deps.

export interface ImpersonationGrantRef {
  id: string;
  actor_user_id: string;
  target_user_id: string;
}

/** Extract the `session_id` claim from a Bearer JWT Authorization header.
 * No signature check: the auth middleware already verified the token before
 * any server fn (and therefore logActivity) runs. */
export function sessionIdFromAuthHeader(header: string | null | undefined): string | null {
  if (!header || !header.startsWith("Bearer ")) return null;
  const parts = header.slice("Bearer ".length).split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof payload.session_id === "string" && payload.session_id ? payload.session_id : null;
  } catch {
    return null;
  }
}

/** The meta fragment recorded on an activity entry written under an
 * impersonated session, or null when the grant doesn't apply to this actor.
 * The admin's identity is kept to their user id — the authoritative record
 * (who, target, duration) lives in the platform audit log. */
export function impersonationMetaFor(
  actorUserId: string | null | undefined,
  grant: ImpersonationGrantRef | null,
): { grant_id: string; admin_user_id: string } | null {
  if (!grant || !actorUserId) return null;
  // The activity actor must be the impersonated user the grant was minted for.
  if (grant.target_user_id !== actorUserId) return null;
  return { grant_id: grant.id, admin_user_id: grant.actor_user_id };
}
