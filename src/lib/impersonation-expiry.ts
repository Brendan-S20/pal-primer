// BUG-2 (client half): a single place for "this impersonation session is over".
//
// Two things can discover it — a local countdown to the stored
// session_expires_at, and a server function rejecting with
// IMPERSONATION_EXPIRED (authoritative; it also covers a grant ended early
// from the admin console, and a clock the tab can't be trusted on). Both funnel
// through here so the tab shows exactly one explicit ended state.

import { IMPERSONATION_EXPIRED } from "@/lib/impersonation-session.shared";

export const IMPERSONATION_EXPIRED_EVENT = "hs:impersonation-expired";

/** Announce that the impersonated session is over. Idempotent for listeners —
 *  the banner ignores repeats once it is already showing the ended state. */
export function notifyImpersonationExpired() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(IMPERSONATION_EXPIRED_EVENT));
}

/** True when an error crossing the server-fn boundary is the expiry rejection.
 *  Server fns reduce errors to their message, so match on the code string. */
export function isImpersonationExpiredError(e: unknown): boolean {
  if (typeof e === "string") return e.includes(IMPERSONATION_EXPIRED);
  // Not just `instanceof Error`: a rejection deserialized across the server-fn
  // boundary is often a plain object that merely carries a message.
  const message = (e as { message?: unknown } | null | undefined)?.message;
  return typeof message === "string" && message.includes(IMPERSONATION_EXPIRED);
}
