import { afterEach, describe, expect, it, vi } from "vitest";

// Finding #5: an impersonation tab (window.name stamped with the prefix) must
// build its Supabase client on sessionStorage under a DISTINCT storage key, so
// it can never read or overwrite the admin's shared-localStorage session. A
// normal tab must keep using localStorage under the default key.
function loadClientWith(windowName: string) {
  vi.resetModules();
  const created: any[] = [];
  vi.doMock("@supabase/supabase-js", () => ({
    createClient: (_url: string, _key: string, opts: any) => {
      created.push(opts);
      return { auth: {} };
    },
  }));
  const sessionStorage = { kind: "session" };
  const localStorage = { kind: "local" };
  vi.stubGlobal("window", { name: windowName, sessionStorage, localStorage } as any);
  return { created };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("@supabase/supabase-js");
  vi.resetModules();
});

describe("supabase client storage isolation (finding #5)", () => {
  it("an impersonation tab uses sessionStorage + a distinct storage key", async () => {
    const { created } = loadClientWith("hs-impersonation:abc123");
    const mod = await import("@/integrations/supabase/client");
    expect(mod.isImpersonationTab()).toBe(true);
    expect(created[0].auth.storage).toEqual({ kind: "session" });
    expect(created[0].auth.storageKey).toBe("sb-hs-impersonation-auth");
  });

  it("a normal tab uses localStorage and the named storage key", async () => {
    const { created } = loadClientWith("");
    const mod = await import("@/integrations/supabase/client");
    expect(mod.isImpersonationTab()).toBe(false);
    expect(created[0].auth.storage).toEqual({ kind: "local" });
    // Named, never `undefined` (native-r2-09: that saved every session as
    // localStorage["undefined"]).
    expect(created[0].auth.storageKey).toBe("sb-houndstack-auth-token");
  });
});
