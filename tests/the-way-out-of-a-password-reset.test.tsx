// @vitest-environment happy-dom
//
// #1058: the way out of /reset-password was one small link; tabbing to it drew
// "Password must be at least 8 characters", and a sign-out the auth server
// never answered left the person locked on the page with no end.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ComponentType, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createClient } from "@supabase/supabase-js";
import {
  abandonRecovery,
  clearRecoveryPending,
  isRecoveryPending,
  markRecoveryPending,
} from "@/lib/password-recovery";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  signOut: vi.fn(async (_o?: unknown) => ({ error: null as unknown })),
  getSession: vi.fn(async () => ({ data: { session: {} as unknown }, error: null as unknown })),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
  useNavigate: () => h.navigate,
  Link: ({ to, children, ...rest }: { to: string; children?: ReactNode }) =>
    createElement("a", { href: to, ...rest }, children),
}));
vi.mock("@/components/PublicShell", () => ({
  PublicShell: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
      getSession: h.getSession,
      signOut: h.signOut,
    },
  },
}));

const LABEL = "Cancel reset and sign out";

describe("the way out on the reset form", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { Route } = await import("@/routes/reset-password");
    const Page = (Route as unknown as { options: { component: ComponentType } }).options.component;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(createElement(Page)));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    clearRecoveryPending();
    vi.useRealTimers();
  });

  const button = () => [...host.querySelectorAll("button")].find((b) => b.textContent === LABEL)!;
  const field = () => host.querySelector<HTMLInputElement>("#pw")!;
  const ruleLine = () => host.querySelector("[data-password-problem]");

  it("is a button that says it signs out", () => {
    expect(button()).toBeDefined();
    expect(button().type).toBe("button");
  });

  it("does not name a broken rule when the keyboard moves to it", async () => {
    await act(async () => field().focus());
    await act(async () => {
      field().dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: button() }));
    });
    expect(ruleLine()).toBeNull();
    // Leaving the field for anything else still names it.
    await act(async () => {
      field().dispatchEvent(
        new FocusEvent("focusout", {
          bubbles: true,
          relatedTarget: host.querySelector("#pw2"),
        }),
      );
    });
    expect(ruleLine()).not.toBeNull();
  });

  it("stays and says so when the session could not be removed, then works again", async () => {
    h.signOut.mockResolvedValueOnce({ error: new Error("x") });
    markRecoveryPending();
    await act(async () => button().click());
    expect(host.textContent).toContain("We couldn't sign you out");
    expect(h.navigate).not.toHaveBeenCalled();
    expect(isRecoveryPending()).toBe(true);
    await act(async () => button().click());
    expect(h.navigate).toHaveBeenCalledWith({ to: "/auth" });
    expect(isRecoveryPending()).toBe(false);
  });

  it("gives the button back when the sign-out never answers", async () => {
    vi.useFakeTimers();
    h.signOut.mockImplementationOnce(() => new Promise<never>(() => undefined));
    markRecoveryPending();
    const pressed = button();
    await act(async () => pressed.click());
    expect(pressed.textContent).toBe("Signing out…");
    await act(async () => pressed.click());
    expect(h.signOut).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(pressed.textContent).toBe(LABEL);
    expect(pressed.getAttribute("aria-disabled")).toBeNull();
    expect(host.textContent).toContain("We couldn't sign you out");
    expect(isRecoveryPending()).toBe(true);
    expect(h.navigate).not.toHaveBeenCalled();
  });
});

// The real auth client and the app's own fetch; only the network is replaced.
describe("a logout request that is never answered", () => {
  const KEY = "sb-1058-hang";
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("is aborted: the session leaves this device and the reset is released", async () => {
    const { fetchWithLocalSignOutDeadline } = await import("@/lib/local-sign-out-deadline");
    vi.useFakeTimers();
    const urls: string[] = [];
    vi.stubGlobal("fetch", (input: unknown, init?: RequestInit) => {
      urls.push(String(input));
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    });
    const saved = new Map<string, string>();
    const storage = {
      getItem: (k: string) => saved.get(k) ?? null,
      setItem: (k: string, v: string) => void saved.set(k, v),
      removeItem: (k: string) => void saved.delete(k),
    };
    saved.set(
      KEY,
      JSON.stringify({
        access_token: "a.b.c",
        refresh_token: "r",
        token_type: "bearer",
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user: { id: "u" },
      }),
    );
    const client = createClient("http://fixture.invalid", "fixture-key", {
      auth: { storage, storageKey: KEY, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: fetchWithLocalSignOutDeadline },
    });
    markRecoveryPending(storage);
    let released: boolean | undefined;
    void abandonRecovery(client, storage).then((r) => (released = r));
    await vi.advanceTimersByTimeAsync(7_000);
    expect(released).toBeUndefined();
    expect(saved.has(KEY)).toBe(true);
    expect(isRecoveryPending(storage)).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(released).toBe(true);
    expect(saved.has(KEY)).toBe(false);
    expect(isRecoveryPending(storage)).toBe(false);
    expect(urls).toEqual(["http://fixture.invalid/auth/v1/logout?scope=local"]);
  });

  it("no other request is given a limit", async () => {
    const { fetchWithLocalSignOutDeadline } = await import("@/lib/local-sign-out-deadline");
    const seen: (RequestInit | undefined)[] = [];
    vi.stubGlobal("fetch", async (_i: unknown, init?: RequestInit) => {
      seen.push(init);
      return new Response("{}");
    });
    const init = { method: "POST" };
    for (const path of [
      "logout?scope=global",
      "logout?scope=others",
      "token?grant_type=password",
    ]) {
      await fetchWithLocalSignOutDeadline(`http://fixture.invalid/auth/v1/${path}`, init);
    }
    expect(seen).toEqual([init, init, init]);
  });

  it("the app's client sends its requests through it", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("src/integrations/supabase/client.ts", "utf8")).toMatch(
      /global: \{ fetch: fetchWithLocalSignOutDeadline \}/,
    );
  });
});
