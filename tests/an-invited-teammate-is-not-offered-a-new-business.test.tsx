// @vitest-environment happy-dom
//
// The Create an account button on /auth (#791), after the page has mounted.
//
// The static render in a-new-owner-can-find-sign-up-on-the-sign-in-screen
// proves the button is there for a new owner, but it cannot see the invite
// case: the token is read in a useEffect, which a server render never runs.
// Here the page mounts in a DOM, effects and all, and:
//
//   - on /auth?invite=… the button is gone. An invited teammate joins the
//     business that invited them; offering them a new one is how #568 started.
//   - without an invite, pressing it goes to /get-started and hands on an
//     address already typed, the same way Continue does (#651), and never puts
//     it in the URL.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ options }),
  useNavigate: () => h.navigate,
  useRouter: () => ({ history: { replace: () => {} } }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ removeQueries: () => {} }),
}));
vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useServerFn: (fn: unknown) => fn,
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { auth: {} } }));
vi.mock("@/lib/auth-entry.functions", () => ({ checkEmailAccount: async () => ({}) }));
vi.mock("@/lib/platform-onboarding.functions", () => ({
  lookupInviteByToken: async () => ({ ok: false }),
}));
// Nobody is signed in, and the page is left waiting to find out: none of the
// landing path runs.
vi.mock("@/lib/offline/identity", () => ({
  resolveIdentity: () => new Promise(() => {}),
  probeIdentity: async () => "unknown",
  trustFreshSignIn: () => {},
}));
vi.mock("@/components/PublicShell", () => ({
  PublicShell: ({ children }: { children?: ReactNode }) => createElement("main", null, children),
}));
vi.mock("@/hooks/useOfflineSignOut", () => ({
  useOfflineSignOut: () => ({ signOut: async () => true, dialog: null }),
}));

const { Route } = await import("@/routes/auth");
const { takeSignupEmail } = await import("@/lib/signup-email");
const AuthPage = (Route as unknown as { options: { component: () => ReactNode } }).options
  .component;

let container: HTMLDivElement;
let root: Root;

async function mount(path: string) {
  window.history.replaceState(null, "", path);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(AuthPage));
  });
}

const createButton = () =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === "Create an account");

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  h.navigate.mockReset();
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("/auth's Create an account button (#791)", () => {
  it("is not offered on an invitation link", async () => {
    await mount("/auth?invite=tok-123");
    expect(container.textContent).toContain("Enter the email address your invitation was sent to.");
    expect(createButton()).toBeUndefined();
  });

  it("is offered without one, and goes to Get started with the typed address handed on", async () => {
    await mount("/auth");
    const button = createButton();
    expect(button).toBeDefined();

    const email = container.querySelector<HTMLInputElement>("#si-email")!;
    await act(async () => type(email, "new.owner@example.com"));
    await act(async () => button!.click());

    expect(h.navigate).toHaveBeenCalledTimes(1);
    const arg = h.navigate.mock.calls[0][0] as { to: string; search?: unknown };
    expect(arg.to).toBe("/get-started");
    expect(JSON.stringify(arg.search ?? {})).not.toContain("example.com");
    expect(takeSignupEmail()).toBe("new.owner@example.com");
  });

  it("does not need an address first", async () => {
    await mount("/auth");
    await act(async () => createButton()!.click());
    expect(h.navigate.mock.calls[0][0]).toMatchObject({ to: "/get-started" });
    expect(takeSignupEmail()).toBeNull();
  });
});
