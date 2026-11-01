/**
 * The API was down and the tech was asked to sign in (#622).
 *
 * Android and iOS, network up, API down: the native app landed on /auth, and
 * iOS showed a raw "TypeError: Load failed". The session and the saved day
 * were both still on the device. A gateway 502/503 counted as the auth
 * server saying no, which also wiped the saved day; and nothing noticed the
 * API coming back, because the device never went offline.
 *
 * Locked acceptance: a cold start with the API down shows the cached My Day
 * and recovers without a reload when the API returns. The device half needs
 * a phone; these pin the decisions it rests on.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  getUser: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getUser: auth.getUser,
      getSession: auth.getSession,
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
  },
}));

import { isOfflineAuthFailure } from "@/lib/offline/read-cache-policy";
import { forgetVerifiedIdentity, probeIdentity, resolveIdentity } from "@/lib/offline/identity";
import {
  API_RETURNED,
  RECOVERY_DELAYS_MS,
  startApiRecovery,
  type ApiProbeResult,
} from "@/lib/offline/api-recovery";
import { startAutoSync } from "@/lib/offline/auto-sync";

const USER = { id: "11111111-1111-4111-8111-111111111111" };
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const read = (p: string) => codeOnly(readFileSync(join(process.cwd(), p), "utf8"));

describe("a down API is not a verdict on the session", () => {
  it("reads a gateway 502/503/504 as could-not-ask", () => {
    for (const status of [502, 503, 504]) {
      expect(
        isOfflineAuthFailure({ name: "AuthRetryableFetchError", status }, { online: true }),
      ).toBe(true);
    }
    expect(isOfflineAuthFailure({ status: 500, message: "internal" }, { online: true })).toBe(true);
  });

  it("still reads a 4xx as the server saying no", () => {
    expect(isOfflineAuthFailure({ status: 401, message: "bad jwt" }, { online: true })).toBe(false);
    expect(isOfflineAuthFailure({ status: 403, message: "forbidden" }, { online: false })).toBe(
      false,
    );
  });

  it("reads iOS's Load failed as could-not-ask with the network up", () => {
    expect(isOfflineAuthFailure(new TypeError("Load failed"), { online: true })).toBe(true);
  });
});

describe("the identity says where it came from", () => {
  beforeEach(() => {
    forgetVerifiedIdentity();
    auth.getUser.mockReset();
    auth.getSession.mockReset();
    auth.getSession.mockResolvedValue({ data: { session: { user: USER } } });
  });

  it("is unverified, not rejected, when the API returns a 503", async () => {
    auth.getUser.mockResolvedValue({
      data: { user: null },
      error: { name: "AuthRetryableFetchError", status: 503, message: "" },
    });
    expect(await resolveIdentity()).toMatchObject({ ok: true, userId: USER.id, verified: false });
    expect(await probeIdentity()).toBe("unreachable");
  });

  it("is unverified when the fetch itself fails", async () => {
    auth.getUser.mockRejectedValue(new TypeError("Load failed"));
    expect(await resolveIdentity()).toMatchObject({ ok: true, verified: false });
  });

  it("is verified once the auth server answers, and a refusal is a refusal", async () => {
    auth.getUser.mockResolvedValue({ data: { user: USER }, error: null });
    expect(await probeIdentity()).toBe("verified");
    forgetVerifiedIdentity();
    auth.getUser.mockResolvedValue({ data: { user: null }, error: { status: 401, message: "x" } });
    expect(await probeIdentity()).toBe("rejected");
  });
});

function fakeTarget() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    addEventListener: (t: string, fn: () => void) => {
      if (!listeners.has(t)) listeners.set(t, new Set());
      listeners.get(t)!.add(fn);
    },
    removeEventListener: (t: string, fn: () => void) => listeners.get(t)?.delete(fn),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
    fire: (t: string) => listeners.get(t)?.forEach((fn) => fn()),
    count: (t: string) => listeners.get(t)?.size ?? 0,
  };
}

describe("coming back when the API does", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps asking on a backoff and stops at the first answer", async () => {
    const target = fakeTarget();
    const answers: ApiProbeResult[] = ["unreachable", "unreachable", "verified"];
    const probe = vi.fn(async () => answers.shift() ?? "verified");
    const onAnswer = vi.fn();
    startApiRecovery({ probe, onAnswer, isOffline: () => false, target });

    await vi.advanceTimersByTimeAsync(RECOVERY_DELAYS_MS[0]);
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RECOVERY_DELAYS_MS[1]);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(onAnswer).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(RECOVERY_DELAYS_MS[2]);
    expect(onAnswer).toHaveBeenCalledWith("verified");

    await vi.advanceTimersByTimeAsync(120_000);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(target.count("online")).toBe(0);
  });

  it("asks at once on a reconnect or a return to the foreground", async () => {
    const target = fakeTarget();
    const doc = { visibilityState: "visible", ...fakeTarget() };
    const probe = vi.fn(async (): Promise<ApiProbeResult> => "unreachable");
    startApiRecovery({ probe, onAnswer: () => {}, isOffline: () => false, target, doc });
    target.fire("online");
    await vi.advanceTimersByTimeAsync(0);
    doc.fire("visibilitychange");
    await vi.advanceTimersByTimeAsync(0);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("makes no request while the device is definitely offline", async () => {
    const target = fakeTarget();
    const probe = vi.fn(async (): Promise<ApiProbeResult> => "verified");
    startApiRecovery({ probe, onAnswer: () => {}, isOffline: () => true, target });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(probe).not.toHaveBeenCalled();
  });

  it("passes a refusal on, so the shell can go to /auth for a real reason", async () => {
    const target = fakeTarget();
    const onAnswer = vi.fn();
    startApiRecovery({ probe: async () => "rejected", onAnswer, isOffline: () => false, target });
    await vi.advanceTimersByTimeAsync(RECOVERY_DELAYS_MS[0]);
    expect(onAnswer).toHaveBeenCalledWith("rejected");
  });

  it("replays the offline queue when the API returns", () => {
    const target = fakeTarget();
    const run = vi.fn();
    const stop = startAutoSync(run, target as never, () => false);
    vi.runAllTimers();
    run.mockClear();
    target.fire(API_RETURNED);
    expect(run).toHaveBeenCalledWith("auto");
    stop();
    expect(target.count(API_RETURNED)).toBe(0);
  });
});

describe("the wiring", () => {
  it("the shell waits on no request when the identity came from the device", () => {
    const src = read("src/routes/_authenticated/route.tsx");
    expect(src).toMatch(/const reachable = online && identity\.verified/);
    expect(src).toMatch(/shellRequest && reachable \? await shellRequest/);
    expect(src).toMatch(/identityVerified: identity\.verified/);
  });

  it("the shell keeps asking and recovers without a reload", () => {
    const src = read("src/routes/_authenticated/route.tsx");
    expect(src).toMatch(/function AppShell\(\) \{\s*useApiRecovery\(\);/);
    expect(src).toMatch(/startApiRecovery\(/);
    expect(src).toMatch(/router\.invalidate\(\)/);
    expect(src).not.toMatch(/location\.reload\(/);
  });

  it("/auth does not run the workspace bootstrap against an API that did not answer", () => {
    const src = read("src/routes/auth.tsx");
    expect(src).toMatch(/identity\.user && identity\.verified && !isDefinitelyOffline\(\)/);
    expect(src).toMatch(/landingPathForUser\(identity\.userId, identity\.verified\)/);
  });
});
