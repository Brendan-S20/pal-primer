// @vitest-environment happy-dom
//
// #1062: a turned-off account sat on /access-off, where "Start my own
// business" was drawn as large as Sign out. Sign out is now the main button,
// the way out of the business sits below it as a link, and its confirm says
// what it does.
//
// "Actually leaves" is the other half. /auth lands a stored session on its
// role page and the shell sends a turned-off person from there back to
// /access-off, so the session has to be gone even when signing out hangs,
// throws, or leaves it saved.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import i18n from "@/lib/i18n";
import { AccessOffCard } from "@/components/AccessOffCard";
import { SESSION_STORAGE_KEY } from "@/integrations/supabase/session-key";
import { LEAVE_SIGN_OUT_DEADLINE_MS, signOutAndLeave } from "@/lib/sign-out-and-leave";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  signOut: vi.fn(async (): Promise<void> => {}),
  clear: vi.fn(),
  impersonating: false,
}));

vi.mock("@/integrations/supabase/client", () => ({
  isImpersonationTab: () => h.impersonating,
  supabase: { auth: { stopAutoRefresh: async () => {} } },
}));
vi.mock("@/lib/offline/read-cache", () => ({
  signOutAndClearDevice: h.signOut,
  clearPersistedReadCaches: h.clear,
}));

describe("what a turned-off person is offered", () => {
  let root: Root;
  let host: HTMLDivElement;
  const onSignOut = vi.fn();

  beforeEach(async () => {
    onSignOut.mockReset();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () =>
      root.render(
        createElement(
          I18nextProvider,
          { i18n: i18n.cloneInstance({ lng: "en" }) },
          createElement(AccessOffCard, {
            state: { kind: "off", business: "Acme Scoop", checkedAgain: false },
            onCheckAgain: () => {},
            onSignOut,
            onStartOwn: async () => {},
          }),
        ),
      ),
    );
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  const buttons = () => [...host.querySelectorAll("button")];
  const button = (name: string) => buttons().find((b) => b.textContent === name)!;

  it("says the owner turned access off, and to ask that business's owner", () => {
    expect(host.textContent).toContain(
      "The owner turned off your access. Ask the owner of Acme Scoop to turn it back on.",
    );
  });

  it("puts Sign out first and fills only it; leaving the business is a link below", () => {
    expect(buttons().map((b) => b.textContent)).toEqual([
      "Sign out",
      "Check again",
      "Start my own business",
    ]);
    expect(buttons().filter((b) => /(^| )bg-primary( |$)/.test(b.className))).toEqual([
      button("Sign out"),
    ]);
    expect(button("Start my own business").className).toContain("underline");
    expect(button("Start my own business").className).toContain("touch:min-h-11");
  });

  // Enter and Space press a native, enabled, tabbable button; happy-dom does
  // not turn the key into the click, so what is pinned is what makes it so.
  it("Sign out is a button the keyboard reaches first", () => {
    const b = button("Sign out");
    expect(b.tagName).toBe("BUTTON");
    expect(b.tabIndex).toBe(0);
    expect(b.disabled).toBe(false);
    expect(host.querySelector("button, a[href], input, [tabindex]")).toBe(b);
  });

  it("says it is signing out and takes no second press, nor a leave", async () => {
    let done!: () => void;
    onSignOut.mockReturnValue(new Promise<void>((r) => (done = r)));
    await act(async () => button("Sign out").click());
    expect(button("Signing out…").disabled).toBe(true);
    expect(button("Check again").disabled).toBe(true);
    expect(button("Start my own business").disabled).toBe(true);
    await act(async () => button("Signing out…").click());
    expect(onSignOut).toHaveBeenCalledTimes(1);
    await act(async () => done());
  });

  it("the confirm says it removes them from the business and they cannot undo it", async () => {
    await act(async () => button("Start my own business").click());
    const confirm = host.querySelector('[data-testid="start-own-confirm"]')!;
    expect(confirm.textContent).toContain("This removes you from Acme Scoop.");
    expect(confirm.textContent).toContain("You can't undo this yourself");
    // Sign out stays the only filled button.
    expect(buttons().filter((b) => /(^| )bg-primary( |$)/.test(b.className))).toEqual([
      button("Sign out"),
    ]);
  });
});

describe("Sign out leaves /access-off", () => {
  const replace = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    h.impersonating = false;
    h.signOut.mockImplementation(async () => {});
    vi.spyOn(window.location, "replace").mockImplementation(replace);
    window.localStorage.setItem(SESSION_STORAGE_KEY, "session");
    window.sessionStorage.setItem("sb-hs-impersonation-auth", "borrowed");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  const expectGone = () => {
    expect(window.localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
    expect(replace).toHaveBeenCalledWith("/auth");
  };

  it("signs the device out and loads /auth", async () => {
    await signOutAndLeave();
    expect(h.signOut).toHaveBeenCalledTimes(1);
    expectGone();
  });

  it("drops a session that signing out left saved", async () => {
    // supabase-js returns without removing it when it cannot refresh first.
    h.signOut.mockImplementation(async () => {});
    await signOutAndLeave();
    expectGone();
  });

  it("still leaves when signing out throws", async () => {
    h.signOut.mockRejectedValue(new Error("lock"));
    await signOutAndLeave();
    expect(h.clear).toHaveBeenCalled();
    expectGone();
  });

  it("still leaves when signing out never answers", async () => {
    vi.useFakeTimers();
    h.signOut.mockImplementation(() => new Promise<void>(() => {}));
    const left = signOutAndLeave();
    await vi.advanceTimersByTimeAsync(LEAVE_SIGN_OUT_DEADLINE_MS - 1);
    expect(replace).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await left;
    expectGone();
  });

  it("an impersonation tab drops only its own session, never the admin's", async () => {
    h.impersonating = true;
    await signOutAndLeave();
    expect(window.sessionStorage.getItem("sb-hs-impersonation-auth")).toBeNull();
    expect(window.localStorage.getItem(SESSION_STORAGE_KEY)).toBe("session");
  });

  it("names the key the client really saves an impersonation session under", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("src/integrations/supabase/client.ts", "utf8")).toContain(
      "impersonating ? 'sb-hs-impersonation-auth' : SESSION_STORAGE_KEY",
    );
  });

  it("is what the page's Sign out does", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/routes/access-off.tsx", "utf8");
    expect(src).toMatch(/const signOut = \(\) => signOutAndLeave\(\);/);
    expect(src).toMatch(/onSignOut=\{signOut\}/);
  });
});
