// BUG-2: the parts of the impersonation session window that BOTH sides need.
//
// Kept free of server-only imports so the impersonation tab's UI can count
// down to the same boundary the server enforces, without pulling the
// service-role client into the browser bundle. Pure, so the boundary
// conditions are unit-testable without a database.

/** How long a redeemed impersonation session stays valid. Support work is
 *  short; anything longer is an unattended tab holding a customer's identity.
 *  Applied at consume time and STORED on the grant, so changing it here only
 *  affects sessions started afterwards (guardrail 10.6). */
export const IMPERSONATION_SESSION_TTL_MS = 60 * 60_000;

/** Marker carried in the rejection message so it survives the server-fn error
 *  boundary, which reduces errors to their message string. */
export const IMPERSONATION_EXPIRED = "IMPERSONATION_EXPIRED";

export type GrantWindow = {
  session_expires_at: string | null;
  consumed_at: string | null;
};

/** Whether a grant's session window is still open at `now`.
 *  Grants consumed before the session-window migration carry a NULL
 *  session_expires_at; those fall back to consumed_at + the default TTL, so
 *  pre-existing sessions are bounded rather than immortal. */
export function isSessionWindowOpen(grant: GrantWindow, now: number): boolean {
  const explicit = grant.session_expires_at ? Date.parse(grant.session_expires_at) : NaN;
  if (Number.isFinite(explicit)) return explicit > now;
  const consumed = grant.consumed_at ? Date.parse(grant.consumed_at) : NaN;
  if (Number.isFinite(consumed)) return consumed + IMPERSONATION_SESSION_TTL_MS > now;
  // Neither timestamp is readable: the grant was never properly consumed, so
  // there is no window to be inside. Fail closed.
  return false;
}
