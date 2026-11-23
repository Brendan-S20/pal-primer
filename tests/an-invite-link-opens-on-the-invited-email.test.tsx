// @vitest-environment happy-dom
//
// #1013. The owner invites a technician, signs out, and opens the invite link
// in the same browser. /auth?invite=… showed "Welcome back" with the OWNER's
// remembered address (the sign-in step kept in this tab). It must open on the
// invited address, and say so if a different one is typed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ options }),
  useNavigate: () => vi.fn(),
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
  lookupInviteByToken: async () => ({ ok: true, kind: "staff", email: "tech@invited.test" }),
}));
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
const { rememberSignInStep } = await import("@/lib/sign-in-handoff");
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
const emailBox = () => container.querySelector<HTMLInputElement>("#si-email");

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  rememberSignInStep("owner@example.com");
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("an invitation link on a browser the owner used", () => {
  it("opens on the invited email, not the owner's remembered one", async () => {
    await mount("/auth?invite=tok-1");
    expect(container.textContent).not.toContain("Welcome back");
    expect(container.textContent).not.toContain("owner@example.com");
    expect(emailBox()!.value).toBe("tech@invited.test");
  });

  it("warns when a different address is typed", async () => {
    await mount("/auth?invite=tok-1");
    expect(container.textContent).not.toContain("This invitation was sent to");
    await act(async () => type(emailBox()!, "owner@example.com"));
    expect(container.textContent).toContain("This invitation was sent to tech@invited.test");
  });

  it("without an invitation still returns to the remembered password step", async () => {
    await mount("/auth");
    expect(container.textContent).toContain("Welcome back");
    expect(container.textContent).toContain("owner@example.com");
  });
});
