// The account lock (owner, 2026-10-09; spec NP-12).
//
//   Day 14 with no plan   the account is LOCKED until a plan is chosen, and its
//                         data is kept for 30 days. A locked account reaches
//                         the plan picker and checkout, and nothing else: not
//                         the dashboard, clients, the field app, the client
//                         portal, data export or settings.
//   A cancelled plan,     once it has ended, is locked the same way, except that
//   ended                 the account can export its data for 30 days.
//   Choosing a plan       unlocks it at once.
//
// This replaces the 2026-08-20 decision that "the account pauses" meant only
// that GROWTH paused (src/lib/trial.ts keeps the history). `restricted`, which
// trialStateFor has computed since BUILD-7 and nothing read, is what this file
// reads: it already carries the two rules that must survive, the
// TRIAL_ENFORCEMENT switch and the TRIAL_ENFORCEMENT_FROM grandfather date.
//
// Enforced in three places, all reading this file:
//   * the `_authenticated` layout's beforeLoad, which sends a locked account to
//     Plan & billing (src/routes/_authenticated/route.tsx);
//   * a global server-function middleware, which refuses every server function
//     not on the list below (src/start.ts → src/lib/account-lock.server.ts);
//   * the customer portal, which answers as if the business had no portal.
import { trialStateFor, type TrialState } from "@/lib/trial";

/** Days a locked account's data is kept, and a cancelled one may export. */
export const LOCKED_DATA_DAYS = 30;

export const ACCOUNT_LOCKED_MESSAGE = "Your account is locked. Choose a plan to unlock it.";

export type AccountLockReason = "trial_ended" | "plan_ended";

export type AccountLock =
  | { locked: false }
  | {
      locked: true;
      reason: AccountLockReason;
      /** ISO timestamp the lock began, when known. */
      since: string | null;
      /** Last moment data export is allowed (plan_ended only), else null. */
      exportUntil: string | null;
    };

export type LockInput = {
  plan_status: string | null;
  billing_status: string | null;
  trial_ends_at: string | null;
  stripe_subscription_id: string | null;
  created_at: string | null;
  is_comped?: boolean | null;
  current_period_end?: string | null;
  suspended_at?: string | null;
};

const DAY_MS = 86_400_000;

export function accountLockFor(org: LockInput | null | undefined, now: Date = new Date()): AccountLock {
  if (!org || org.is_comped) return { locked: false };
  const state: TrialState = trialStateFor(
    {
      planStatus: org.plan_status,
      billingStatus: org.billing_status,
      trialEndsAt: org.trial_ends_at,
      hasSubscription: !!org.stripe_subscription_id,
      createdAt: org.created_at,
    },
    now,
  );
  if (!state.restricted) return { locked: false };
  if (state.phase === "expired") {
    return { locked: true, reason: "trial_ended", since: org.trial_ends_at, exportUntil: null };
  }
  if (state.phase === "lapsed") {
    const suspended =
      !!org.suspended_at ||
      (org.plan_status ?? "").toLowerCase() === "suspended" ||
      (org.billing_status ?? "").toLowerCase() === "suspended";
    // A suspension is the platform's decision, with its own banner and its own
    // way back; it is not a plan to choose, so it is not this lock.
    if (suspended) return { locked: false };
    const since = org.current_period_end ?? null;
    const exportUntil = since
      ? new Date(Date.parse(since) + LOCKED_DATA_DAYS * DAY_MS).toISOString()
      : null;
    return { locked: true, reason: "plan_ended", since, exportUntil };
  }
  return { locked: false };
}

/** May a locked account export its data right now? Only a cancelled plan,
 *  only for 30 days after it ended (or, with no end date on file, at all). */
export function exportAllowed(lock: AccountLock, now: Date = new Date()): boolean {
  if (!lock.locked) return true;
  if (lock.reason !== "plan_ended") return false;
  return !lock.exportUntil || now.getTime() <= Date.parse(lock.exportUntil);
}

/** The one page a locked account may open: Plan & billing, which holds the plan
 *  picker, checkout and (for a cancelled plan) the data export. */
export const PATHS_OPEN_WHEN_LOCKED = ["/settings/billing"] as const;

export function pathOpenWhenLocked(pathname: string): boolean {
  return PATHS_OPEN_WHEN_LOCKED.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * The server functions a locked account may still call, by the file that
 * defines them and, where a file also holds functions it may not call, by name.
 * Everything here is either the plan picker and checkout, the shell needed to
 * draw them, or leaving (deleting your own account).
 */
export const SERVER_FNS_OPEN_WHEN_LOCKED: Record<string, "*" | readonly string[]> = {
  // Plan picker, checkout, invoices, payment methods, cancel and resume.
  "src/lib/billing.functions.ts": "*",
  // Add-on cards on the same page; buying one still needs an active plan.
  "src/lib/platform-addons.functions.ts": ["listPlatformAddons", "cancelPlatformAddon"],
  "src/lib/founding-offer.functions.ts": "*",
  // The shell: who am I, which org, what is the trial state, is it locked.
  "src/lib/org.functions.ts": ["getMyOrg"],
  // The same org and lock in one request. Locked, it returns nothing else.
  "src/lib/shell-context.functions.ts": ["getShellContext"],
  // The account menu's own name and email, beside Sign out.
  "src/lib/profile.functions.ts": ["getMyProfile"],
  "src/lib/platform.functions.ts": ["getPlatformContext"],
  "src/lib/trial.functions.ts": "*",
  "src/lib/account-lock.functions.ts": "*",
  // Export decides for itself (cancelled plans only, for 30 days).
  "src/lib/account-export.functions.ts": "*",
  // A locked person can still leave.
  "src/lib/delete-account.functions.ts": "*",
};

export function serverFnOpenWhenLocked(meta: { name?: string; filename?: string } | null | undefined): boolean {
  if (!meta?.filename) return false;
  const file = meta.filename.replace(/\\/g, "/").replace(/^\.?\//, "");
  const key = Object.keys(SERVER_FNS_OPEN_WHEN_LOCKED).find((k) => file === k || file.endsWith(`/${k}`));
  if (!key) return false;
  const allowed = SERVER_FNS_OPEN_WHEN_LOCKED[key];
  return allowed === "*" || (!!meta.name && allowed.includes(meta.name));
}
