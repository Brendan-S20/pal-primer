// The signed-in shell's first load, in two requests sent together.
//
// The `_authenticated` layout asked getMyOrg, then getAccountLock, and then
// the header, sidebar, banners and tab bar asked a dozen more questions of
// their own, all at once and all queued behind each other on the backend.
// getShellContext answers the first two in one request; the layout waits for
// it. getShellParts answers the rest in one request; the layout does not wait
// for it. Each part is the very function its component calls (the `load*`
// beside each server function), run here in parallel, so the answer cannot
// drift from what the component would have fetched. src/lib/shell-context.ts
// puts each one under its component's key.
//
// A part that fails, or is not back within SHELL_PARTS_BUDGET_MS, is left out:
// its component then asks for it itself, exactly as before. A part is only
// asked for a role whose component would ask.
//
// getShellContext is allowed for a locked account (src/lib/account-lock.ts)
// because the shell needs the org and the lock to draw the plan picker.
// getShellParts is not, so a locked account is refused it.

import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { AuthedContext } from "@/lib/server-fn-context";
import type { loadMyOrg } from "@/lib/org.functions";
import type { loadAccountLock } from "@/lib/account-lock.functions";
import type { loadMyProfile } from "@/lib/profile.functions";
import type { loadMyOrgFeatures } from "@/lib/org-features.functions";
import type { loadTrialState } from "@/lib/trial.functions";
import type { loadBillingBannerStatus } from "@/lib/billing.functions";
import type { loadActiveAnnouncements } from "@/lib/announcements-viewer.functions";
import type { loadFranchiseContext } from "@/lib/franchise.functions";
import type { loadOnboardingStatus } from "@/lib/onboarding.functions";
import type { loadReviewQueueCount } from "@/lib/review-queue.functions";
import type { loadPlatformContext } from "@/lib/platform.functions";
import type { loadMyNotifications } from "@/lib/notifications-center.functions";
import type { loadMyRoutingRuns } from "@/lib/routing-runs.functions";
import type { loadMyClock } from "@/lib/time-clock.functions";

type Answer<F extends (...args: any[]) => any> = Awaited<ReturnType<F>>;

/** Every part is optional: absent means "not asked, or it failed". */
export type ShellParts = {
  profile?: Answer<typeof loadMyProfile>;
  features?: Answer<typeof loadMyOrgFeatures>;
  trial?: Answer<typeof loadTrialState>;
  billingBanner?: Answer<typeof loadBillingBannerStatus>;
  announcements?: Answer<typeof loadActiveAnnouncements>;
  franchise?: Answer<typeof loadFranchiseContext>;
  onboarding?: Answer<typeof loadOnboardingStatus>;
  reviewCount?: Answer<typeof loadReviewQueueCount>;
  platform?: Answer<typeof loadPlatformContext>;
  notifications?: Answer<typeof loadMyNotifications>;
  routingRuns?: Answer<typeof loadMyRoutingRuns>;
  clock?: Answer<typeof loadMyClock>;
};

export type ShellAnswer = {
  org: Answer<typeof loadMyOrg>;
  /** Null when the lock could not be read, which the layout treats as it
   *  always has: let the person through, and the server still refuses. */
  lock: Answer<typeof loadAccountLock> | null;
};

export const getShellContext = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => loadShellContext(context));

/** The rest of the shell, asked at the same moment as getShellContext and not
 *  awaited by the layout, so the page's own call does not wait for it. Not in
 *  the locked-account allow list, so a locked account is refused it. */
export const getShellParts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => loadShellPartsForCaller(context));

/** The roles RoutingRunIndicator polls for (the ones can_write_org lets route). */
const ROUTING_ROLES = ["owner", "office_manager", "dispatcher"];

/** How long the parts may take once the role is known. */
export const SHELL_PARTS_BUDGET_MS = 1200;

export const loadShellContext = createServerOnlyFn(
  async (context: AuthedContext & { claims?: unknown }): Promise<ShellAnswer> => {
    const [{ loadMyOrg }, { loadAccountLock }] = await Promise.all([
      import("@/lib/org.functions"),
      import("@/lib/account-lock.functions"),
    ]);
    // getMyOrg failing fails the whole answer, as it failed the layout; the
    // lock failing is a null, as it was.
    const [org, lock] = await Promise.all([
      loadMyOrg(context),
      loadAccountLock(context).catch(() => null),
    ]);
    return { org, lock };
  },
);

export const loadShellPartsForCaller = createServerOnlyFn(
  async (context: AuthedContext & { claims?: unknown }): Promise<ShellParts> => {
    const { loadMyOrg } = await import("@/lib/org.functions");
    const role = (await loadMyOrg(context)).organization?.role;
    if (!role) return {};
    return loadShellParts(context, role);
  },
);

const loadShellParts = createServerOnlyFn(
  async (context: AuthedContext & { claims?: unknown }, role: string): Promise<ShellParts> => {
    const [
      { canAccess },
      { hasPermission },
      { loadMyProfile },
      { loadMyOrgFeatures },
      { loadTrialState },
      { loadBillingBannerStatus },
      { loadActiveAnnouncements },
      { loadFranchiseContext },
      { loadOnboardingStatus },
      { loadReviewQueueCount },
      { loadPlatformContext },
      { loadMyNotifications },
      { loadMyRoutingRuns },
      { loadMyClock },
    ] = await Promise.all([
      import("@/hooks/useMyRole"),
      import("@/lib/permissions"),
      import("@/lib/profile.functions"),
      import("@/lib/org-features.functions"),
      import("@/lib/trial.functions"),
      import("@/lib/billing.functions"),
      import("@/lib/announcements-viewer.functions"),
      import("@/lib/franchise.functions"),
      import("@/lib/onboarding.functions"),
      import("@/lib/review-queue.functions"),
      import("@/lib/platform.functions"),
      import("@/lib/notifications-center.functions"),
      import("@/lib/routing-runs.functions"),
      import("@/lib/time-clock.functions"),
    ]);
    const appRole = role as Parameters<typeof canAccess>[0];
    // SetupGuideBanner only asks while the guide is open, which is decided on
    // the device. The token's copy of the same flag is a good enough guess:
    // a wrong guess either way gives the component the same data it would
    // have fetched, or leaves it to fetch.
    const meta = (context.claims as { user_metadata?: { tour_seen_at?: unknown } } | undefined)
      ?.user_metadata;

    // Each entry mirrors its component's `enabled`. Null: not asked.
    const asks: { [K in keyof ShellParts]-?: (() => Promise<ShellParts[K]>) | null } = {
      profile: () => loadMyProfile(context),
      features: () => loadMyOrgFeatures(context),
      // TrialBanner and SuspensionBanner skip a technician.
      trial: role !== "tech" ? () => loadTrialState(context) : null,
      billingBanner: role !== "tech" ? () => loadBillingBannerStatus(context) : null,
      announcements: () => loadActiveAnnouncements(context),
      // Refused for anyone without manage_franchise, so not asked for them.
      franchise: hasPermission(appRole, "manage_franchise")
        ? () => loadFranchiseContext(context)
        : null,
      onboarding:
        canAccess(appRole, "/setup") && !meta?.tour_seen_at
          ? () => loadOnboardingStatus(context)
          : null,
      reviewCount: canAccess(appRole, "/review") ? () => loadReviewQueueCount(context) : null,
      platform: () => loadPlatformContext(context),
      notifications: () => loadMyNotifications(context),
      // What the header indicator sends on any page: nothing attached yet,
      // and not watching. /routes asks again with its own answer to that.
      routingRuns: ROUTING_ROLES.includes(role)
        ? () => loadMyRoutingRuns(context, { watching: false, also: [] })
        : null,
      clock: () => loadMyClock(context.supabase, context.userId),
    };

    // Parts that are not back within the budget are left out, like a failed
    // part, so one slow read cannot hold up the whole page.
    const done: Partial<Record<keyof ShellParts, unknown>> = {};
    const all = Promise.all(
      Object.entries(asks).map(async ([name, ask]) => {
        if (!ask) return;
        try {
          done[name as keyof ShellParts] = await ask();
        } catch {
          // Left out. The component asks for it, and sees the error itself.
        }
      }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      all,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SHELL_PARTS_BUDGET_MS);
      }),
    ]);
    clearTimeout(timer);
    return { ...done } as ShellParts;
  },
);
