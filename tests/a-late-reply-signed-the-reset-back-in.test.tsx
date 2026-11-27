// @vitest-environment happy-dom
//
// #1058: "Cancel reset and sign out" during a slow password save landed on
// /auth signed out, and then the save's reply put the session back. The link
// check had no way out at all when GET /auth/v1/user was never answered.
//
// The real page and the real auth client; only the network is replaced. It
// ignores the abort and answers when the test says to, so a reply that comes
// back after the cancel is always tried.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ComponentType, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createClient } from "@supabase/supabase-js";
import { fetchWithLocalSignOutDeadline } from "@/lib/local-sign-out-deadline";
import { clearRecoveryPending, isRecoveryPending } from "@/lib/password-recovery";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ navigate: vi.fn(), client: null as unknown }));

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
  get supabase() {
    return h.client;
  },
}));

const KEY = "sb-1058-late";
const LABEL = "Cancel reset and sign out";
const PASSWORD = "Fake-QA-Passw0rd!x9";
const USER = { id: "11111111-1111-1111-1111-111111111111", email: "qa@example.test" };
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const token = () =>
  `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, exp: Math.floor(Date.now() / 1000) + 3600 })}.c2ln`;
const hash = () =>
  `#access_token=${token()}&refresh_token=r1&expires_in=3600&token_type=bearer&type=recovery`;

type Logout = "ok" | "500" | "hang";

describe("cancelling a reset while a request is still out", () => {
  let root: Root;
  let host: HTMLDivElement;
  let saved: Map<string, string>;
  let sent: string[];
  let held: Record<string, (() => void)[]>;
  let holding: Set<string>;
  let logout: Logout;

  const network = (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const what = `${init?.method ?? "GET"} ${url.pathname}`;
    sent.push(what);
    const reply = () => new Response(JSON.stringify(USER), { status: 200 });
    if (url.pathname === "/auth/v1/logout") {
      if (logout === "500") return Promise.resolve(new Response("{}", { status: 500 }));
      if (logout === "hang") {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (!holding.has(what)) return Promise.resolve(reply());
    return new Promise((resolve) => (held[what] ??= []).push(() => resolve(reply())));
  };

  const answerLate = async (what: string) => {
    const waiting = held[what] ?? [];
    expect(waiting.length).toBeGreaterThan(0);
    await act(async () => {
      waiting.forEach((answer) => answer());
      await vi.advanceTimersByTimeAsync(100);
    });
  };

  const open = async (url: string, { clientReadsLink = false, session = false } = {}) => {
    window.history.replaceState(null, "", url);
    if (session) {
      saved.set(
        KEY,
        JSON.stringify({
          access_token: token(),
          refresh_token: "r1",
          token_type: "bearer",
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          user: USER,
        }),
      );
    }
    h.client = createClient("http://fixture.invalid", "fixture-key", {
      auth: {
        storage: {
          getItem: (k: string) => saved.get(k) ?? null,
          setItem: (k: string, v: string) => void saved.set(k, v),
          removeItem: (k: string) => void saved.delete(k),
        },
        storageKey: KEY,
        autoRefreshToken: false,
        detectSessionInUrl: clientReadsLink,
      },
      global: { fetch: fetchWithLocalSignOutDeadline },
    });
    const { Route } = await import("@/routes/reset-password");
    const Page = (Route as unknown as { options: { component: ComponentType } }).options.component;
    await act(async () => root.render(createElement(Page)));
    await act(async () => vi.advanceTimersByTimeAsync(100));
  };

  const cancel = () => [...host.querySelectorAll("button")].find((b) => b.textContent === LABEL)!;
  const press = async (ms = 100) => {
    await act(async () => cancel().click());
    await act(async () => vi.advanceTimersByTimeAsync(ms));
  };
  const type = async (id: string, value: string) => {
    const field = host.querySelector<HTMLInputElement>(`#${id}`)!;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      set.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const submit = async () => {
    await act(async () => {
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await vi.advanceTimersByTimeAsync(100);
    });
  };

  const expectSignedOut = () => {
    expect(saved.has(KEY)).toBe(false);
    expect(isRecoveryPending()).toBe(false);
    expect(h.navigate.mock.calls).toEqual([[{ to: "/auth" }]]);
    expect(host.textContent).not.toContain("Password updated");
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    saved = new Map();
    sent = [];
    held = {};
    holding = new Set();
    logout = "ok";
    vi.stubGlobal("fetch", network);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    clearRecoveryPending();
    window.history.replaceState(null, "", "/");
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each<[Logout, number]>([
    ["ok", 100],
    ["500", 100],
    ["hang", 9_000],
  ])(
    "save pending, cancel, then the save answers (logout %s): stays signed out",
    async (mode, wait) => {
      await open("/reset-password", { session: true });
      await type("pw", PASSWORD);
      await type("pw2", PASSWORD);
      holding.add("PUT /auth/v1/user");
      logout = mode;
      await submit();
      expect(host.textContent).toContain("Updating…");
      expect(cancel().getAttribute("aria-disabled")).toBeNull();
      expect(isRecoveryPending()).toBe(true);

      await press(wait);
      expectSignedOut();
      await answerLate("PUT /auth/v1/user");
      await act(async () => vi.advanceTimersByTimeAsync(5_000));
      expectSignedOut();
    },
  );

  it("sends no new password while it is signing out", async () => {
    await open("/reset-password", { session: true });
    await type("pw", PASSWORD);
    await type("pw2", PASSWORD);
    logout = "hang";
    await press();
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    await submit();
    expect(sent).not.toContain("PUT /auth/v1/user");
    await act(async () => vi.advanceTimersByTimeAsync(9_000));
    expectSignedOut();
  });

  it("can save again after a cancel that could not sign out", async () => {
    await open("/reset-password", { session: true });
    await type("pw", PASSWORD);
    await type("pw2", PASSWORD);
    const client = h.client as { auth: { signOut: () => Promise<unknown> } };
    vi.spyOn(client.auth, "signOut").mockResolvedValueOnce({ error: new Error("x") });
    holding.add("PUT /auth/v1/user");
    await submit();
    await press();
    expect(host.textContent).toContain("We couldn't sign you out");
    expect(isRecoveryPending()).toBe(true);
    holding.clear();
    await submit();
    expect(host.textContent).toContain("Password updated");
  });

  it.each([
    ["the page", false],
    ["supabase-js, as it starts", true],
  ])(
    "link check never answered, read by %s: there is a way out and it holds",
    async (_who, clientReadsLink) => {
      holding.add("GET /auth/v1/user");
      await open(`/reset-password${hash()}`, { clientReadsLink });
      expect(host.textContent).toContain("Checking your reset link…");
      expect(cancel()).toBeDefined();

      await press(500);
      expectSignedOut();
      await answerLate("GET /auth/v1/user");
      await act(async () => vi.advanceTimersByTimeAsync(5_000));
      expectSignedOut();
    },
  );

  it("lets the same requests through again once the cancel is over", async () => {
    holding.add("GET /auth/v1/user");
    await open(`/reset-password${hash()}`);
    await press(500);
    holding.clear();
    const client = h.client as {
      auth: { getUser: (jwt: string) => Promise<{ error: unknown }> };
    };
    await expect(client.auth.getUser(token())).resolves.toMatchObject({ error: null });
  });
});
