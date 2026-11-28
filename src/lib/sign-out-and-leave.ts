// Sign out from a page that sends a signed-in person straight back to itself
// (/access-off, #1062). Leaving it only works if the session is gone by the
// time /auth loads: /auth lands a stored session on its role page, and the
// shell sends a turned-off person from there back to /access-off.
//
// signOutAndClearDevice alone does not promise that. It has no deadline, and
// supabase-js keeps the stored session when it cannot first refresh an expired
// token (a dead connection). So: bound it, then remove the stored session
// whatever happened, then load /auth afresh.

import { isImpersonationTab, supabase } from "@/integrations/supabase/client";
import { SESSION_STORAGE_KEY } from "@/integrations/supabase/session-key";
import { clearPersistedReadCaches, signOutAndClearDevice } from "@/lib/offline/read-cache";
import { withDeadline } from "@/lib/offline/run-or-queue";

export const LEAVE_SIGN_OUT_DEADLINE_MS = 10_000;

/** The key client.ts saves an impersonation tab's session under. */
const IMPERSONATION_STORAGE_KEY = "sb-hs-impersonation-auth";

function dropStoredSession(): void {
  try {
    // An impersonation tab shares localStorage with the admin's own session,
    // which this must never touch.
    if (isImpersonationTab()) window.sessionStorage.removeItem(IMPERSONATION_STORAGE_KEY);
    else window.localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    /* storage blocked: there is no stored session to remove */
  }
}

export async function signOutAndLeave(to = "/auth"): Promise<void> {
  // Stop the refresh ticker, so it cannot save the session again behind us.
  void supabase.auth.stopAutoRefresh().catch(() => {});
  try {
    await withDeadline(signOutAndClearDevice(), LEAVE_SIGN_OUT_DEADLINE_MS, "sign-out");
  } catch {
    // Timed out or threw. The device copy still has to go.
    clearPersistedReadCaches();
  }
  dropStoredSession();
  window.location.replace(to);
}
