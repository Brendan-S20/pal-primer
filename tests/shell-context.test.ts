import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { AuthedContext } from "@/lib/server-fn-context";
import type { ShellAnswer } from "@/lib/shell-context.functions";

const loaders = vi.hoisted(() => ({
  org: vi.fn(),
  lock: vi.fn(),
  profile: vi.fn(),
  features: vi.fn(),
  trial: vi.fn(),
  billingBanner: vi.fn(),
  announcements: vi.fn(),
  franchise: vi.fn(),
  onboarding: vi.fn(),
  reviewCount: vi.fn(),
  platform: vi.fn(),
  notifications: vi.fn(),
  routingRuns: vi.fn(),
  clock: vi.fn(),
}));

vi.mock("@tanstack/react-start", () => ({
  createServerOnlyFn: (fn: unknown) => fn,
  createServerFn: () => {
    const builder = {
      middleware: () => builder,
      handler: (fn: unknown) => fn,
    };
    return builder;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/lib/org.functions", () => ({ loadMyOrg: loaders.org, getMyOrg: vi.fn() }));
vi.mock("@/lib/account-lock.functions", () => ({ loadAccountLock: loaders.lock }));
vi.mock("@/lib/profile.functions", () => ({ loadMyProfile: loaders.profile }));
vi.mock("@/lib/org-features.functions", () => ({ loadMyOrgFeatures: loaders.features }));
vi.mock("@/lib/trial.functions", () => ({ loadTrialState: loaders.trial }));
vi.mock("@/lib/billing.functions", () => ({ loadBillingBannerStatus: loaders.billingBanner }));
vi.mock("@/lib/announcements-viewer.functions", () => ({ loadActiveAnnouncements: loaders.announcements }));
vi.mock("@/lib/franchise.functions", () => ({ loadFranchiseContext: loaders.franchise }));
vi.mock("@/lib/onboarding.functions", () => ({ loadOnboardingStatus: loaders.onboarding }));
vi.mock("@/lib/review-queue.functions", () => ({ loadReviewQueueCount: loaders.reviewCount }));
vi.mock("@/lib/platform.functions", () => ({ loadPlatformContext: loaders.platform }));
vi.mock("@/lib/notifications-center.functions", () => ({ loadMyNotifications: loaders.notifications }));
vi.mock("@/lib/routing-runs.functions", () => ({ loadMyRoutingRuns: loaders.routingRuns }));
vi.mock("@/lib/time-clock.functions", () => ({ loadMyClock: loaders.clock }));
vi.mock("@/components/TimeClock", () => ({ MY_CLOCK_QUERY_KEY: ["my-day", "clock"] }));
vi.mock("@/hooks/useRoutingRuns", () => ({ ROUTING_RUNS_KEY: ["routing-runs", "mine"] }));

import { loadShellContext, loadShellPartsForCaller, SHELL_PARTS_BUDGET_MS } from "@/lib/shell-context.functions";
import { resetShellContextForTests, seedShellContext, SHELL_PART_KEYS } from "@/lib/shell-context";

const org = { organization: { id: "org-1", role: "owner" } } as ShellAnswer["org"];
const lock: ShellAnswer["lock"] = { locked: false, canChoosePlan: true };
const notifications = { notifications: [], unread: 0 };
const context = { supabase: {}, userId: "user-1" } as AuthedContext;
const partNames = Object.keys(SHELL_PART_KEYS) as (keyof typeof SHELL_PART_KEYS)[];

beforeEach(() => {
  resetShellContextForTests();
  vi.resetAllMocks();
  loaders.org.mockResolvedValue(org);
  loaders.lock.mockResolvedValue(lock);
  for (const name of partNames) loaders[name].mockResolvedValue({ part: name });
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("seedShellContext", () => {
  it("always writes my-org and skips lock and parts without an organization", async () => {
    const qc = new QueryClient();
    const noOrg = { organization: null, accessTurnedOff: null };
    seedShellContext(qc, "user-1", { org: noOrg, lock, parts: { notifications } });
    await settle();
    expect(qc.getQueryData(["my-org"])).toEqual(noOrg);
    expect(qc.getQueryState(["account-lock"])).toBeUndefined();
    for (const key of Object.values(SHELL_PART_KEYS)) expect(qc.getQueryState(key)).toBeUndefined();
    qc.clear();
  });

  it("writes the lock and the parts that came back under their existing keys", async () => {
    const qc = new QueryClient();
    seedShellContext(qc, "user-1", { org, lock, parts: Promise.resolve({ notifications }) });
    expect(qc.getQueryData(["my-org"])).toEqual(org);
    expect(qc.getQueryData(["account-lock"])).toEqual(lock);
    // On its way: the entry is fetching, so a component that mounts waits for it.
    expect(qc.getQueryState(SHELL_PART_KEYS.notifications)?.fetchStatus).toBe("fetching");
    await settle();
    await settle();
    expect(qc.getQueryData(SHELL_PART_KEYS.notifications)).toEqual(notifications);
    // Absent parts are reset: no data, no error, nothing fetching.
    for (const name of partNames.filter((name) => name !== "notifications")) {
      const state = qc.getQueryState(SHELL_PART_KEYS[name]);
      expect(state?.data).toBeUndefined();
      expect(state?.error ?? null).toBeNull();
      expect(state?.fetchStatus ?? "idle").toBe("idle");
    }
    qc.clear();
  });

  it("an absent part is fetched with the mounted component's own queryFn", async () => {
    const qc = new QueryClient();
    const own = vi.fn().mockResolvedValue({ part: "own profile" });
    const { QueryObserver } = await import("@tanstack/react-query");
    const observer = new QueryObserver(qc, { queryKey: SHELL_PART_KEYS.profile, queryFn: own, staleTime: 60_000 });
    seedShellContext(qc, "user-1", { org, lock, parts: Promise.resolve({ notifications }) });
    const unsubscribe = observer.subscribe(() => {});
    for (let i = 0; i < 5; i++) await settle();
    expect(own).toHaveBeenCalledTimes(1);
    expect(qc.getQueryData(SHELL_PART_KEYS.profile)).toEqual({ part: "own profile" });
    unsubscribe();
    qc.clear();
  });

  it("primes no parts for a locked account", async () => {
    const qc = new QueryClient();
    const locked = { locked: true, reason: "trial_ended", since: null, exportUntil: null, canChoosePlan: true } as ShellAnswer["lock"];
    seedShellContext(qc, "user-1", { org, lock: locked, parts: { notifications } });
    await settle();
    for (const key of Object.values(SHELL_PART_KEYS)) expect(qc.getQueryState(key)).toBeUndefined();
    qc.clear();
  });

  it("keeps existing parts", async () => {
    const qc = new QueryClient();
    qc.setQueryData(SHELL_PART_KEYS.notifications, notifications);
    seedShellContext(qc, "user-1", { org, lock, parts: { notifications: { notifications: [], unread: 9 } } });
    await settle();
    expect(qc.getQueryData(SHELL_PART_KEYS.notifications)).toEqual(notifications);
    qc.clear();
  });
});

describe("loadShellContext", () => {
  it("answers the org and lock only", async () => {
    expect(await loadShellContext(context)).toEqual({ org, lock });
    for (const name of partNames) expect(loaders[name]).not.toHaveBeenCalled();
  });

  it("answers a null lock when the lock cannot be read", async () => {
    loaders.lock.mockRejectedValue(new Error("down"));
    expect(await loadShellContext(context)).toEqual({ org, lock: null });
  });
});

describe("loadShellPartsForCaller", () => {
  it("leaves out a part that is not back within the budget", async () => {
    loaders.franchise.mockReturnValue(new Promise(() => {}));
    const started = Date.now();
    const parts = await loadShellPartsForCaller(context);
    expect(Date.now() - started).toBeGreaterThanOrEqual(SHELL_PARTS_BUDGET_MS - 50);
    expect(parts).not.toHaveProperty("franchise");
    expect(parts.notifications).toEqual({ part: "notifications" });
  });

  it("answers nothing without an organization", async () => {
    loaders.org.mockResolvedValue({ organization: null, accessTurnedOff: null });
    expect(await loadShellPartsForCaller(context)).toEqual({});
    for (const name of partNames) expect(loaders[name]).not.toHaveBeenCalled();
  });

  it("leaves a failed part out and keeps the successful parts", async () => {
    loaders.notifications.mockRejectedValue(new Error("unavailable"));
    const parts = await loadShellPartsForCaller(context);
    expect(loaders.notifications).toHaveBeenCalledWith(context);
    expect(parts).not.toHaveProperty("notifications");
    expect(parts.profile).toEqual({ part: "profile" });
    expect(parts.routingRuns).toEqual({ part: "routingRuns" });
  });

  it("does not ask for trial, billingBanner or routingRuns for a tech", async () => {
    loaders.org.mockResolvedValue({ organization: { id: "org-1", role: "tech" } });
    const parts = await loadShellPartsForCaller(context);
    for (const name of ["trial", "billingBanner", "routingRuns"] as const) {
      expect(loaders[name]).not.toHaveBeenCalled();
      expect(parts).not.toHaveProperty(name);
    }
    expect(parts.notifications).toEqual({ part: "notifications" });
    expect(parts.clock).toEqual({ part: "clock" });
  });
});

it("getShellParts stays out of the locked-account allow list", async () => {
  const { serverFnOpenWhenLocked } = await import("@/lib/account-lock");
  const filename = "src/lib/shell-context.functions.ts";
  expect(serverFnOpenWhenLocked({ filename, name: "getShellContext" })).toBe(true);
  expect(serverFnOpenWhenLocked({ filename, name: "getShellParts" })).toBe(false);
});
