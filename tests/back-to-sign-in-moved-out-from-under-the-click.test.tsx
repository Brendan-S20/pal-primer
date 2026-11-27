// @vitest-environment happy-dom
//
// #1058: "Back to sign in" on /reset-password did nothing but draw "Password
// must be at least 8 characters." The new-password field has the focus on
// arrival; pressing the mouse on the link left the field, which added that
// line, and from `sm` up PublicShell centres the page, so the link moved 12px
// up before mouse-up. A press on its lower part was never a click: no
// sign-out, and the recovery lock (#995) kept every other page closed.
//
// happy-dom has no layout, so this pins the cause: the press must not take the
// focus off the field.

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
  updateUser: vi.fn(async () => ({ error: null })),
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
      getSession: async () => ({ data: { session: {} } }),
      signOut: h.signOut,
      updateUser: h.updateUser,
    },
  },
}));

describe("pressing 'Back to sign in' on the reset form", () => {
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
  });

  const link = () =>
    [...host.querySelectorAll("a")].find((a) => a.textContent === "Back to sign in")!;

  /** What a browser does: an uncancelled mousedown takes the focus. */
  const press = async () => {
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    await act(async () => {
      if (link().dispatchEvent(down)) (document.activeElement as HTMLElement | null)?.blur();
    });
  };

  it("leaves the focus where it was, so no rule line appears and nothing moves", async () => {
    const field = host.querySelector<HTMLInputElement>("#pw")!;
    await act(async () => field.focus());
    await press();
    expect(document.activeElement).toBe(field);
    expect(host.querySelector("[data-password-problem]")).toBeNull();
  });

  it("then signs out this device only, goes to /auth and never submits the form", async () => {
    await act(async () => host.querySelector<HTMLInputElement>("#pw")!.focus());
    await press();
    await act(async () => {
      link().click();
    });
    expect(h.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(h.navigate).toHaveBeenCalledWith({ to: "/auth" });
    expect(h.updateUser).not.toHaveBeenCalled();
    expect(isRecoveryPending()).toBe(false);
  });
});

// The real client, with only the network replaced: whatever the sign-out does,
// the app is never left with a session AND the lock lowered.
describe("a reset abandoned when the auth server cannot say yes", () => {
  const KEY = "sb-1058-fixture";

  function setup(logout: () => Promise<Response>, expiresIn = 3600) {
    const saved = new Map<string, string>();
    const storage = {
      getItem: (k: string) => saved.get(k) ?? null,
      setItem: (k: string, v: string) => void saved.set(k, v),
      removeItem: (k: string) => void saved.delete(k),
    };
    const exp = Math.floor(Date.now() / 1000) + expiresIn;
    saved.set(
      KEY,
      JSON.stringify({
        access_token: "a.b.c",
        refresh_token: "r",
        token_type: "bearer",
        expires_in: expiresIn,
        expires_at: exp,
        user: { id: "u" },
      }),
    );
    const urls: string[] = [];
    const client = createClient("http://fixture.invalid", "fixture-key", {
      auth: { storage, storageKey: KEY, autoRefreshToken: false, detectSessionInUrl: false },
      global: {
        fetch: (async (input: unknown) => {
          urls.push(String(input));
          return logout();
        }) as typeof fetch,
      },
    });
    markRecoveryPending(storage);
    return { client, storage, saved, urls };
  }

  const offline = () => Promise.reject(new TypeError("Failed to fetch"));

  it("revoked already (403): signed out, lock lowered", async () => {
    const f = setup(async () => new Response(JSON.stringify({ msg: "gone" }), { status: 403 }));
    await abandonRecovery(f.client, f.storage);
    expect(f.saved.has(KEY)).toBe(false);
    expect(isRecoveryPending(f.storage)).toBe(false);
    expect(f.urls).toEqual(["http://fixture.invalid/auth/v1/logout?scope=local"]);
  });

  it.each([
    ["offline", offline],
    ["a 500", async () => new Response("{}", { status: 500 })],
  ])("%s: the session leaves this device and the lock stays up", async (_n, logout) => {
    const f = setup(logout);
    await abandonRecovery(f.client, f.storage);
    expect(f.saved.has(KEY)).toBe(false);
    expect(isRecoveryPending(f.storage)).toBe(true);
    // A second press finds no session and lets the person go.
    await abandonRecovery(f.client, f.storage);
    expect(isRecoveryPending(f.storage)).toBe(false);
  });

  it("offline with an expired token: the session may stay, so the lock stays up", async () => {
    const f = setup(offline, -60);
    await abandonRecovery(f.client, f.storage);
    expect(isRecoveryPending(f.storage)).toBe(true);
  }, 60_000);
});
