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

describe("the probe asks the network, not supabase-js's memory of the outage", () => {
  beforeEach(() => {
    forgetVerifiedIdentity();
    auth.getUser.mockReset();
    auth.getSession.mockReset();
    auth.getSession.mockResolvedValue({ data: { session: { user: USER } } });
  });

  it("touches no session while the health check gets no answer", async () => {
    auth.getUser.mockResolvedValue({ data: { user: USER }, error: null });
    expect(await probeIdentity(async () => false)).toBe("unreachable");
    expect(auth.getUser).not.toHaveBeenCalled();
  });

  it("asks who is signed in once the health check answers", async () => {
    auth.getUser.mockResolvedValue({ data: { user: USER }, error: null });
    expect(await probeIdentity(async () => true)).toBe("verified");
    expect(auth.getUser).toHaveBeenCalledTimes(1);
  });

  it("reads a gateway 5xx or a failed fetch as no answer, and any other status as an answer", async () => {
    const { authServerAnswers } = await import("@/lib/offline/identity");
    const { supabase } = await import("@/integrations/supabase/client");
    const authClient = supabase.auth as unknown as { url?: string };
    authClient.url = "https://api.example.test/auth/v1";
    try {
      const at = (status: number) => vi.fn(async () => new Response(null, { status }));
      for (const s of [502, 503, 504]) expect(await authServerAnswers(at(s) as never)).toBe(false);
      for (const s of [200, 401, 404]) expect(await authServerAnswers(at(s) as never)).toBe(true);
      const fails = vi.fn(async () => {
        throw new TypeError("Load failed");
      });
      expect(await authServerAnswers(fails as never)).toBe(false);
      const ok = at(200);
      await authServerAnswers(ok as never);
      expect(ok).toHaveBeenCalledWith("https://api.example.test/auth/v1/health", expect.anything());
    } finally {
      delete authClient.url;
    }
  });

  it("drops the refresh failure supabase-js cached during the outage", async () => {
    const { forgetCachedRefreshFailure } = await import("@/lib/offline/identity");
    const { supabase } = await import("@/integrations/supabase/client");
    const authClient = supabase.auth as unknown as { lastRefreshFailure?: unknown };
    authClient.lastRefreshFailure = { refreshToken: "r", expiresAt: Date.now() + 60_000 };
    try {
      forgetCachedRefreshFailure();
      expect(authClient.lastRefreshFailure).toBeNull();
    } finally {
      delete authClient.lastRefreshFailure;
    }
  });

  it("the installed supabase-js still caches refresh failures under the name this clears", () => {
    // If an upgrade renames the field, forgetCachedRefreshFailure becomes a
    // silent no-op and recovery waits out the cooldown again. Fail here instead.
    const src = readFileSync(
      join(process.cwd(), "node_modules/@supabase/auth-js/dist/module/GoTrueClient.js"),
      "utf8",
    );
    expect(src).toMatch(/this\.lastRefreshFailure\s*=\s*\{/);
    expect(src).toMatch(/this\.lastRefreshFailure\.refreshToken === refreshToken/);
  });
});

describe("a probe that never answers does not stop the loop", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("counts a hung probe as unreachable and asks again", async () => {
    const { PROBE_DEADLINE_MS } = await import("@/lib/offline/api-recovery");
    const target = fakeTarget();
    const onAnswer = vi.fn();
    let calls = 0;
    const probe = vi.fn((): Promise<ApiProbeResult> => {
      calls += 1;
      return calls === 1 ? new Promise(() => {}) : Promise.resolve("verified");
    });
    startApiRecovery({ probe, onAnswer, isOffline: () => false, target });
    await vi.advanceTimersByTimeAsync(RECOVERY_DELAYS_MS[0]);
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PROBE_DEADLINE_MS + RECOVERY_DELAYS_MS[1]);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(onAnswer).toHaveBeenCalledWith("verified");
  });
});
