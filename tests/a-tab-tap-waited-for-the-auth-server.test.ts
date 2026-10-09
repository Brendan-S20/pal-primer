/**
 * A tab tap waited for the auth server.
 *
 * The _authenticated route's beforeLoad asks resolveIdentity() who is signed
 * in, and the router runs every matched route's beforeLoad on every
 * navigation and every intent preload. resolveIdentity() asked
 * supabase.auth.getUser(), a round trip, every time: each tab tap, each tap
 * into a client, each touchstart on a link in a list being scrolled, waited a
 * cell connection's round trip (up to four seconds on one bar) before the
 * screen could change. Found 2026-10-08 looking for why the app did not feel
 * smooth on the owner's iPhone.
 *
 * A "yes" is now reused for IDENTITY_REUSE_MS, and forgotten at once when the
 * session changes hands or ends. These pin both halves.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  getUser: vi.fn(),
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(),
  listener: null as null | ((event: string, session: unknown) => void),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getUser: auth.getUser,
      getSession: auth.getSession,
      onAuthStateChange: (cb: (event: string, session: unknown) => void) => {
        auth.listener = cb;
        auth.onAuthStateChange(cb);
        return { data: { subscription: { unsubscribe() {} } } };
      },
    },
  },
}));

import { forgetVerifiedIdentity, IDENTITY_REUSE_MS, resolveIdentity } from "@/lib/offline/identity";

const USER = { id: "11111111-1111-4111-8111-111111111111" };

describe("who is signed in, asked once and not on every tap", () => {
  beforeEach(() => {
    forgetVerifiedIdentity();
    auth.getUser.mockReset();
    auth.getUser.mockResolvedValue({ data: { user: USER }, error: null });
    vi.useRealTimers();
  });

  it("asks the auth server once for a run of navigations", async () => {
    for (let i = 0; i < 5; i++) {
      expect(await resolveIdentity()).toMatchObject({ ok: true, userId: USER.id });
    }
    expect(auth.getUser).toHaveBeenCalledTimes(1);
  });

  it("asks again once the reuse window is over", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T12:00:00Z"));
    await resolveIdentity();
    vi.setSystemTime(Date.now() + IDENTITY_REUSE_MS - 1);
    await resolveIdentity();
    expect(auth.getUser).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 2);
    await resolveIdentity();
    expect(auth.getUser).toHaveBeenCalledTimes(2);
  });

  it("forgets the answer the moment the session ends or changes hands", async () => {
    await resolveIdentity();
    expect(auth.listener, "nothing is watching the session").not.toBeNull();

    auth.listener!("SIGNED_OUT", null);
    auth.getUser.mockResolvedValue({ data: { user: null }, error: { status: 401 } });
    expect(await resolveIdentity()).toMatchObject({ ok: false, rejected: true });

    // Someone else signs in on the same device.
    auth.getUser.mockResolvedValue({ data: { user: USER }, error: null });
    await resolveIdentity();
    auth.listener!("SIGNED_IN", { user: { id: "22222222-2222-4222-8222-222222222222" } });
    const calls = auth.getUser.mock.calls.length;
    await resolveIdentity();
    expect(auth.getUser.mock.calls.length).toBe(calls + 1);
  });

  it("keeps the answer across a token refresh for the same person", async () => {
    await resolveIdentity();
    auth.listener!("TOKEN_REFRESHED", { user: USER });
    await resolveIdentity();
    expect(auth.getUser).toHaveBeenCalledTimes(1);
  });

  it("is not a long time", () => {
    expect(IDENTITY_REUSE_MS).toBeLessThanOrEqual(5 * 60_000);
  });
});
