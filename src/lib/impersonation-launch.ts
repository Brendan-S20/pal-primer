// One implementation of "open an impersonation tab" (guardrail 10.2).
//
// Two callers need it: the Impersonate button on a tenant page, and the
// re-impersonate request an expired impersonation tab sends back to the console
// that opened it (BUG-2). The tab-opening rules are subtle enough — open
// synchronously so the browser doesn't count it as a popup, stamp window.name
// before the app loads so it scopes its session to sessionStorage — that a
// second copy would be a bug waiting to happen.

import { IMPERSONATION_WINDOW_PREFIX } from "@/integrations/supabase/client";

export type StartImpersonationResult = { token: string; targetEmail: string };

/**
 * Opens the tab, then mints the grant and points the tab at /impersonate.
 *
 * `open` MUST be called from inside the user-gesture turn (before any await),
 * which is why the window is opened first and the grant fetched second.
 */
export async function launchImpersonationTab(
  startImpersonation: (args: {
    data: { organization_id: string; target_user_id: string };
  }) => Promise<StartImpersonationResult>,
  params: { organizationId: string; targetUserId: string },
): Promise<StartImpersonationResult> {
  const winName = `${IMPERSONATION_WINDOW_PREFIX}${crypto.randomUUID()}`;
  const win = window.open("about:blank", winName);
  try {
    const res = await startImpersonation({
      data: { organization_id: params.organizationId, target_user_id: params.targetUserId },
    });
    if (!win) throw new Error("Pop-up blocked. Allow pop-ups for this site and try again.");
    win.location.href = `/impersonate#t=${encodeURIComponent(res.token)}`;
    return res;
  } catch (e) {
    try {
      win?.close();
    } catch {
      /* noop */
    }
    throw e;
  }
}
