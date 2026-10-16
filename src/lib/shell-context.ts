// The signed-in shell's first load (getShellContext for the org and lock,
// getShellParts for the rest, sent together) and the query cache entries they
// fill.
//
// The `_authenticated` beforeLoad starts both beside resolveIdentity(), waits
// only for getShellContext, and uses the answers only once identity says yes.
// Each part is primed under the key its own component already reads, in the
// shape that component's queryFn stores, so the component waits for it or
// finds it fresh, and does not ask again. A part the server could not answer
// is absent, and its component fetches it the way it always has.
//
// Once per page load. After that the beforeLoad takes its usual path (the
// cached my-org, the account lock on its own), because every part already has
// an owner that keeps it fresh.

import type { QueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getShellContext, getShellParts } from "@/lib/shell-context.functions";
import { ROUTING_RUNS_KEY } from "@/hooks/useRoutingRuns";
import { MY_CLOCK_QUERY_KEY } from "@/components/TimeClock";

export type ShellAnswer = Awaited<ReturnType<typeof getShellContext>>;
type ShellParts = Awaited<ReturnType<typeof getShellParts>>;
/** The org and lock, plus the parts still on their way. */
export type ShellContext = ShellAnswer & { parts?: ShellParts | Promise<ShellParts> };

/** Where each part lives in the cache: the key its component reads. */
export const SHELL_PART_KEYS: { [K in keyof Required<ShellParts>]: readonly unknown[] } = {
  profile: ["my-profile"],
  features: ["my-org-features"],
  trial: ["trial", "state"],
  billingBanner: ["billing-banner-status"],
  announcements: ["announcements", "active"],
  franchise: ["franchise", "ctx"],
  onboarding: ["onboarding-status"],
  reviewCount: ["review-queue", "count"],
  platform: ["platform", "ctx"],
  notifications: ["notifications"],
  routingRuns: ROUTING_RUNS_KEY,
  clock: MY_CLOCK_QUERY_KEY,
};

let seededFor: string | null = null;
let inflight: Promise<{ userId: string; answer: ShellContext } | null> | null = null;

/**
 * Ask for the shell, when it has not been loaded yet on this page and there
 * is a session on the device to ask with. Null when there is nothing to ask;
 * the promise never rejects, and resolves null for "take the usual path".
 */
export function startShellContext(): Promise<{ userId: string; answer: ShellContext } | null> | null {
  if (seededFor !== null) return null;
  inflight ??= (async () => {
    try {
      const { data } = await supabase.auth.getSession();
      const userId = data.session?.user.id;
      if (!userId) return null;
      // Not awaited here: the layout only waits for the org and lock. A
      // refusal (a locked account) or a failure is no parts.
      const parts = getShellParts().catch(() => ({}) as ShellParts);
      const answer = await getShellContext();
      if (!answer || typeof answer !== "object" || !("org" in answer)) return null;
      return { userId, answer: { ...answer, parts } as ShellContext };
    } catch {
      return null;
    }
  })();
  const mine = inflight;
  // The next navigation decides afresh; a second beforeLoad already running
  // holds this same promise.
  void mine.finally(() => {
    if (inflight === mine) inflight = null;
  });
  return mine;
}

/** Write the answer into the cache. `my-org` always (the beforeLoad's
 *  ensureQueryData stored it whatever it said); the lock only once there is
 *  an organization, as before; each part that came back. A workspace marks
 *  the page as loaded; no workspace leaves the next navigation free to ask
 *  again (after /no-workspace creates one, say). */
export function seedShellContext(queryClient: QueryClient, userId: string, shell: ShellContext) {
  queryClient.setQueryData(["my-org"], shell.org);
  if (!shell.org?.organization) return;
  if (shell.lock) queryClient.setQueryData(["account-lock"], shell.lock);
  if (shell.lock && !shell.lock.locked && shell.parts) primeShellParts(queryClient, shell.parts);
  seededFor = userId;
}

/** Thrown for a part the server did not send (not asked for this role,
 *  failed, or late), so the entry can be reset rather than left in error. */
class ShellPartMissing extends Error {}

/** Put each part under its key. A part already cached is left alone. While
 *  the parts are on their way, a component that mounts joins this fetch
 *  rather than sending its own. A part that did not come back is reset, so a
 *  component that wants it fetches it itself, exactly as before. */
function primeShellParts(queryClient: QueryClient, parts: ShellParts | Promise<ShellParts>) {
  const answer = Promise.resolve(parts) as Promise<Record<string, unknown>>;
  for (const [name, key] of Object.entries(SHELL_PART_KEYS)) {
    if (queryClient.getQueryData(key) !== undefined) continue;
    let first = true;
    void queryClient
      .prefetchQuery({
        queryKey: key,
        retry: false,
        queryFn: async (ctx) => {
          if (first) {
            first = false;
            const got = await answer;
            if (Object.prototype.hasOwnProperty.call(got, name)) return got[name];
            throw new ShellPartMissing(name);
          }
          // A later refetch that still carries this queryFn uses the one a
          // mounted component gave.
          const query = queryClient.getQueryCache().find({ queryKey: key, exact: true });
          const own = query?.observers.find((o) => typeof o.options.queryFn === "function")
            ?.options.queryFn;
          if (typeof own !== "function") throw new ShellPartMissing(name);
          return own(ctx as never);
        },
      })
      .then(() => {
        const query = queryClient.getQueryCache().find({ queryKey: key, exact: true });
        if (query?.state.error instanceof ShellPartMissing) {
          void queryClient.resetQueries({ queryKey: key, exact: true });
        }
      });
  }
}

/** Test seam. */
export function resetShellContextForTests(): void {
  seededFor = null;
  inflight = null;
}
