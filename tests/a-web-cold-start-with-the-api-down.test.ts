/**
 * A web cold start with the API down sent a signed-in user to /auth (#661).
 *
 * The browser had a stored session and a saved day. `/` redirects to /auth,
 * and the web branch of the landing effect there asked a bare
 * `supabase.auth.getUser()`, stopped when it failed, and never asked again.
 * Only a reload got the person out. The native branch (#622) had already
 * learned to answer from the device and to keep asking.
 *
 * Locked acceptance: a browser cold start with the API blocked shows the saved
 * data, not /auth; unblock the API and the app recovers on its own.
 *
 * These run the real chain on the web build, against a mocked Supabase:
 * resolveIdentity, the shell's beforeLoad and the recovery loop. The /auth
 * effect itself is read, because rendering it needs a DOM this suite does not
 * have.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  getUser: vi.fn(),
  getSession: vi.fn(),
}));
const api = vi.hoisted(() => ({
  getMyOrg: vi.fn(),
  getAccountLock: vi.fn(),
  shellContext: vi.fn(),
}));

vi.mock("@/lib/native-build", () => ({
  IS_NATIVE_BUNDLE: false,
  nativeTopBarStyle: () => undefined,
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
vi.mock("@/lib/org.functions", () => ({ getMyOrg: () => api.getMyOrg() }));
vi.mock("@/lib/account-lock.functions", () => ({ getAccountLock: () => api.getAccountLock() }));
vi.mock("@/lib/platform.functions", () => ({ getPlatformContext: async () => ({}) }));
vi.mock("@/lib/shell-context", () => ({
  startShellContext: () => api.shellContext(),
  seedShellContext: () => {},
}));
vi.mock("@/lib/mfa", () => ({ needsSecondStep: async () => false }));
vi.mock("@/lib/offline/read-cache", () => ({
  ensureReadCachePersistence: () => {},
  clearPersistedReadCaches: () => {},
  signOutAndClearDevice: async () => {},
  readLastUser: () => null,
}));
vi.mock("@/lib/monitoring/client", () => ({
  setMonitoringIdentity: () => {},
  reportClientError: () => {},
}));

import { isRedirect } from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import { forgetVerifiedIdentity, probeIdentity, resolveIdentity } from "@/lib/offline/identity";
import { startApiRecovery, RECOVERY_DELAYS_MS } from "@/lib/offline/api-recovery";
import { Route } from "@/routes/_authenticated/route";

const USER = { id: "22222222-2222-4222-8222-222222222222" };
const ORG = { organization: { id: "org-1", name: "Two Trucks Scooping" }, role: "tech" };
const blocked = () => Promise.reject(new TypeError("Failed to fetch"));
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

beforeEach(() => {
  forgetVerifiedIdentity();
  for (const f of [auth.getUser, auth.getSession, api.getMyOrg, api.getAccountLock]) f.mockReset();
  api.shellContext.mockReset();
  api.shellContext.mockImplementation(blocked);
  api.getMyOrg.mockImplementation(blocked);
  api.getAccountLock.mockImplementation(blocked);
  auth.getSession.mockResolvedValue({ data: { session: { user: USER } } });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("who is signed in, in a browser that cannot reach the API", () => {
  it("answers from the stored session when the request fails", async () => {
    auth.getUser.mockImplementation(blocked);
    expect(await resolveIdentity()).toEqual({
      ok: true,
      userId: USER.id,
      user: USER,
      verified: false,
    });
  });

  it("still sends a refused session to the form", async () => {
    auth.getUser.mockResolvedValue({
      data: { user: null },
      error: { name: "AuthApiError", status: 401, message: "invalid JWT" },
    });
    expect(await resolveIdentity()).toEqual({ ok: false, rejected: true });
  });
});

async function coldStart(queryClient: QueryClient): Promise<unknown> {
  const beforeLoad = Route.options.beforeLoad as (ctx: unknown) => Promise<unknown>;
  try {
    return await beforeLoad({ context: { queryClient }, location: { href: "/my-day" } });
  } catch (e) {
    if (isRedirect(e)) return { redirectedTo: String(e.options.to) };
    throw e;
  }
}

describe("the signed-in shell on that cold start", () => {
  it("draws the saved workspace, not /auth, and asks the API for nothing", async () => {
    auth.getUser.mockImplementation(blocked);
    const queryClient = new QueryClient();
    queryClient.setQueryData(["my-org"], ORG);

    const ctx = await coldStart(queryClient);
    expect(ctx).toMatchObject({
      userId: USER.id,
      organization: ORG.organization,
      identityVerified: false,
    });
    expect(api.getMyOrg).not.toHaveBeenCalled();
  });
});

describe("unblocking the API", () => {
  it("is noticed on the backoff, with no reload and no online event", async () => {
    vi.useFakeTimers();
    let up = false;
    auth.getUser.mockImplementation(() =>
      up ? Promise.resolve({ data: { user: USER }, error: null }) : blocked(),
    );
    const onAnswer = vi.fn();
    const target = new EventTarget() as EventTarget & {
      setTimeout: typeof setTimeout;
      clearTimeout: typeof clearTimeout;
    };
    target.setTimeout = ((fn: () => void, ms: number) => setTimeout(fn, ms)) as typeof setTimeout;
    target.clearTimeout = ((id: unknown) =>
      clearTimeout(id as ReturnType<typeof setTimeout>)) as typeof clearTimeout;

    const stop = startApiRecovery({
      probe: () => probeIdentity(async () => up),
      onAnswer,
      isOffline: () => false,
      target: target as never,
    });

    await vi.advanceTimersByTimeAsync(RECOVERY_DELAYS_MS[0] + RECOVERY_DELAYS_MS[1]);
    expect(onAnswer).not.toHaveBeenCalled();

    up = true;
    await vi.advanceTimersByTimeAsync(RECOVERY_DELAYS_MS[2]);
    expect(onAnswer).toHaveBeenCalledWith("verified");
    stop();

    // And the shell's re-run, which the answer triggers, now draws live.
    const queryClient = new QueryClient();
    api.shellContext.mockResolvedValue(null);
    api.getMyOrg.mockResolvedValue(ORG);
    api.getAccountLock.mockResolvedValue({ locked: false });
    expect(await coldStart(queryClient)).toMatchObject({ identityVerified: true });
  });
});

describe("the screen a web cold start lands on", () => {
  const src = codeOnly(readFileSync(join(process.cwd(), "src/routes/auth.tsx"), "utf8"));

  it("no longer gives the web its own bare getUser() landing", () => {
    expect(src).not.toMatch(/supabase\.auth\.getUser\(\)\s*\.then/);
    expect(src, "the landing effect is gated on the build again").not.toMatch(
      /if \(!IS_NATIVE_BUNDLE\) \{\s*supabase\.auth/,
    );
    expect(src).toMatch(/const identity = await resolveIdentity\(\)/);
  });

  it("does not bootstrap from an identity the server did not confirm", () => {
    expect(src).toMatch(/identity\.user && identity\.verified && !isDefinitelyOffline\(\)/);
  });

  it("lands on the remembered page when it cannot ask", () => {
    expect(src).toMatch(/landingPathForUser\(identity\.userId, identity\.verified\)/);
    expect(src).toMatch(/!reachable\) return remembered/);
  });

  it("keeps asking when it could not ask and the device names nobody", () => {
    expect(src).toMatch(/!identity\.rejected && !stopRecovery/);
    expect(src).toMatch(/startApiRecovery\(/);
  });
});
