/**
 * A recovery session must not be routed by membership.
 *
 * ── WHY (Detroit Doo Disposal, #765) ─────────────────────────────────────
 *
 * A password-reset link hands the browser a signed-in session. Wherever it
 * lands (the root sends everything to /auth), /auth's mount effect saw a
 * signed-in person and ran the membership sequence on them: an account with
 * no business went on to /no-workspace, and one with a business to its
 * dashboard. Neither is the page that sets the password, so the reset
 * "worked" and changed nothing.
 *
 * The membership path now asks this first, and hands a recovery to
 * /reset-password before it looks at user_roles at all: a password is an
 * account's, not a workspace's. Delivery of the reset email and the
 * /reset-password page itself are #764's, not this file's.
 */

const KEY = "hs.password-recovery";
/** A recovery session is good for an hour; a note older than that is stale. */
const TTL_MS = 60 * 60 * 1000;

/** Whether this address is a Supabase recovery hand-back (implicit flow puts
 *  `type=recovery` in the hash; a verify link can put it in the query). */
export function urlIsRecovery(url: { hash?: string; search?: string }): boolean {
  const parts = [url.hash ?? "", url.search ?? ""].map((s) => s.replace(/^[#?]/, ""));
  return parts.some((p) => new URLSearchParams(p).get("type") === "recovery");
}

/** Note a recovery in the current URL. Called at module load in __root.tsx:
 *  supabase-js clears the hash during its (async) initialisation, so by the
 *  time /auth's effect runs the URL may no longer say so. */
export function noteRecoveryFromUrl(): void {
  if (typeof window === "undefined") return;
  if (urlIsRecovery(window.location)) noteRecovery();
}

/** Note that the session arriving is a password recovery. */
export function noteRecovery(): void {
  try {
    window.sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    // Storage off: the URL check in recoveryPending still answers on this page.
  }
}

/** True while a recovery session has arrived and has not yet been handed to
 *  /reset-password. The caller that hands it over calls clearRecovery. */
export function recoveryPending(): boolean {
  if (typeof window === "undefined") return false;
  if (urlIsRecovery(window.location)) {
    noteRecovery();
    return true;
  }
  try {
    const at = Number(window.sessionStorage.getItem(KEY));
    if (!at) return false;
    if (Date.now() - at > TTL_MS) {
      window.sessionStorage.removeItem(KEY);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function clearRecovery(): void {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // nothing to clear
  }
}
