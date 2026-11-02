// native-r2-09: the Supabase session was saved as localStorage["undefined"],
// because client.ts passed an explicit `storageKey: undefined` and that
// overrode supabase-js's default. The key is now a name. The part that matters
// is the upgrade: every phone and browser that is signed in today holds its
// session under "undefined", and the new build must find it there and keep it,
// not greet every user with the sign-in page.
/* eslint-disable @typescript-eslint/no-explicit-any -- a fake createClient */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LEGACY_SESSION_KEY,
  SESSION_STORAGE_KEY,
  derivedSessionKey,
  moveSessionToNamedKey,
} from "@/integrations/supabase/session-key";

const URL_ = "https://api.houndstack.com";
const SESSION = JSON.stringify({
  access_token: "a.b.c",
  refresh_token: "r-123",
  expires_at: 1,
  user: { id: "u-1" },
});

function memoryStorage(seed: Record<string, string> = {}) {
  const m = new Map(Object.entries(seed));
  return {
    map: m,
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

describe("moving a session to the named key", () => {
  it("the key is a name, in the sb-*-auth-token shape", () => {
    expect(SESSION_STORAGE_KEY).toBe("sb-houndstack-auth-token");
    expect(SESSION_STORAGE_KEY).toMatch(/^sb-.*-auth-token$/);
    expect(derivedSessionKey(URL_)).toBe("sb-api-auth-token");
  });

  it('moves a session saved under "undefined", and removes the old copy', () => {
    const s = memoryStorage({ [LEGACY_SESSION_KEY]: SESSION });
    expect(moveSessionToNamedKey(s, URL_)).toBe("undefined");
    expect(s.getItem(SESSION_STORAGE_KEY)).toBe(SESSION);
    expect(s.getItem("undefined")).toBeNull();
  });

  it("moves supabase-js's derived default when that is all there is", () => {
    const s = memoryStorage({ "sb-api-auth-token": SESSION });
    expect(moveSessionToNamedKey(s, URL_)).toBe("sb-api-auth-token");
    expect(s.getItem(SESSION_STORAGE_KEY)).toBe(SESSION);
  });

  it('prefers "undefined" (what the app read until now) over a stale derived key', () => {
    const stale = JSON.stringify({ access_token: "old", refresh_token: "old" });
    const s = memoryStorage({ undefined: SESSION, "sb-api-auth-token": stale });
    moveSessionToNamedKey(s, URL_);
    expect(s.getItem(SESSION_STORAGE_KEY)).toBe(SESSION);
  });

  it("never overwrites a session already under the new name", () => {
    const newer = JSON.stringify({ access_token: "new", refresh_token: "new" });
    const s = memoryStorage({ [SESSION_STORAGE_KEY]: newer, undefined: SESSION });
    expect(moveSessionToNamedKey(s, URL_)).toBeNull();
    expect(s.getItem(SESSION_STORAGE_KEY)).toBe(newer);
  });

  it('leaves something that is not a session alone, even under "undefined"', () => {
    const s = memoryStorage({ undefined: "true" });
    expect(moveSessionToNamedKey(s, URL_)).toBeNull();
    expect(s.getItem("undefined")).toBe("true");
    expect(s.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });

  it("carries a half-finished OAuth sign-in's PKCE verifier across", () => {
    const s = memoryStorage({ "undefined-code-verifier": "verifier-xyz" });
    moveSessionToNamedKey(s, URL_);
    expect(s.getItem(`${SESSION_STORAGE_KEY}-code-verifier`)).toBe("verifier-xyz");
    expect(s.getItem("undefined-code-verifier")).toBeNull();
  });

  it("keeps the old copy when the new one did not save (storage full)", () => {
    const s = memoryStorage({ undefined: SESSION });
    s.setItem = () => {};
    expect(moveSessionToNamedKey(s, URL_)).toBeNull();
    expect(s.getItem("undefined")).toBe(SESSION);
  });

  it("does not throw when storage does", () => {
    const boom = () => {
      throw new Error("SecurityError");
    };
    expect(moveSessionToNamedKey({ getItem: boom, setItem: boom, removeItem: boom }, URL_)).toBe(
      null,
    );
    expect(moveSessionToNamedKey(undefined, URL_)).toBeNull();
  });
});

// The upgrade itself, through client.ts: the move happens before createClient
// runs, so GoTrue's first read already finds the session.
describe("the browser client on the first launch after the update", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock("@supabase/supabase-js");
    vi.resetModules();
  });

  async function boot(windowName: string, seed: Record<string, string>) {
    vi.resetModules();
    const local = memoryStorage(seed);
    const session = memoryStorage();
    const seenAtCreate: Array<{ opts: any; stored: string | null }> = [];
    vi.doMock("@supabase/supabase-js", () => ({
      createClient: (_u: string, _k: string, opts: any) => {
        seenAtCreate.push({ opts, stored: opts.auth.storage?.getItem(opts.auth.storageKey) });
        return { auth: {} };
      },
    }));
    vi.stubGlobal("window", { name: windowName, localStorage: local, sessionStorage: session });
    await import("@/integrations/supabase/client");
    return { local, session, seenAtCreate };
  }

  it('a person signed in under "undefined" is still signed in', async () => {
    const { local, seenAtCreate } = await boot("", { undefined: SESSION });
    expect(seenAtCreate[0].opts.auth.storageKey).toBe(SESSION_STORAGE_KEY);
    expect(seenAtCreate[0].stored).toBe(SESSION);
    expect(local.getItem("undefined")).toBeNull();
  });

  it("an impersonation tab moves nothing in the admin's localStorage", async () => {
    const { local, seenAtCreate } = await boot("hs-impersonation:abc", { undefined: SESSION });
    expect(seenAtCreate[0].opts.auth.storageKey).toBe("sb-hs-impersonation-auth");
    expect(local.getItem("undefined")).toBe(SESSION);
    expect(local.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });
});

describe("nothing else still writes the old key", () => {
  it("the signed-in viewport fixture writes the named key", () => {
    const src = readFileSync(join(import.meta.dirname, "viewports/fixtures/session.ts"), "utf8");
    expect(src).toContain(`localStorage.setItem("${SESSION_STORAGE_KEY}"`);
    expect(src).not.toMatch(/setItem\("undefined"/);
  });
});
