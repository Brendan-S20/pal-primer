// @vitest-environment happy-dom
//
// #807, on the real forms. Brendan, 2026-11-09: "when you enter a password for
// an account when creating one; it doesn't tell you that the password is weak
// til you're all the way through, it should tell you as you try to move from
// then."
//
// Every form that sets a password is driven here the way a person drives it:
// keystrokes into the field, a blur, a press on Continue. For each one:
//
//   - the rules are on screen before anything is typed;
//   - a password that breaks a rule leaves Continue disabled and names the
//     rule beside the field;
//   - a password that meets every rule in lib/password-policy.ts lets it go;
//   - an auth-server refusal of a password the list passed (the leaked-
//     password check) puts the person back on a password field with the
//     server's reason beside it, and nothing else they typed is lost (#785's
//     "never silently wipe the form", for this cause).
//
// Before the fix, Get started's last step showed the refusal with no password
// field on the step at all; the only way to change it was Back, Back. And
// "        " (eight spaces) passed Get started's first step, because the only
// check there was `password.length >= 8`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  search: {} as Record<string, unknown>,
  navigate: vi.fn(),
  checkEmailAccount: vi.fn(),
  registerAccount: vi.fn(),
  sendEmailVerification: vi.fn(),
  bootstrapOrganization: vi.fn(),
  recordSmsConsent: vi.fn(),
  validateSignupCode: vi.fn(),
  lookupInviteByToken: vi.fn(),
  acceptPendingInvite: vi.fn(),
  signInWithPassword: vi.fn(),
  updateUser: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({
    options: opts,
    useSearch: () => h.search,
  }),
  Link: ({ children, to, ...rest }: { children?: ReactNode; to?: string }) => {
    const { search: _s, ...attrs } = rest as Record<string, unknown>;
    return createElement("a", { href: to, ...attrs }, children);
  },
  useNavigate: () => h.navigate,
}));
vi.mock("@/lib/auth-entry.functions", () => ({
  checkEmailAccount: h.checkEmailAccount,
  registerAccount: h.registerAccount,
  sendEmailVerification: h.sendEmailVerification,
}));
vi.mock("@/lib/org.functions", () => ({
  bootstrapOrganization: h.bootstrapOrganization,
  recordSmsConsent: h.recordSmsConsent,
  validateSignupCode: h.validateSignupCode,
}));
vi.mock("@/lib/platform-onboarding.functions", () => ({
  lookupInviteByToken: h.lookupInviteByToken,
}));
vi.mock("@/lib/ensure-workspace", () => ({
  acceptPendingInvite: h.acceptPendingInvite,
  rememberInviteToken: () => {},
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      signInWithPassword: h.signInWithPassword,
      updateUser: h.updateUser,
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      getSession: async () => ({ data: { session: { access_token: "t" } } }),
    },
  },
}));
vi.mock("@/lib/password-recovery", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/password-recovery")>();
  return {
    ...real,
    establishRecoverySession: async () => ({ ok: true }),
    passwordResetRedirectHere: async () => "https://app.example/reset-password",
  };
});
vi.mock("sonner", () => ({
  toast: Object.assign(() => {}, { warning: () => {}, error: () => {}, success: () => {} }),
}));

import { Route as GetStarted } from "@/routes/get-started";
import { Route as ResetPassword } from "@/routes/reset-password";

// What Supabase Auth says when its leaked-password check refuses one.
const LEAKED = "Password is known to be weak and easy to guess, please choose a different one.";

let root: Root;
let host: HTMLElement;

function mount(Component: () => ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(createElement(QueryClientProvider, { client: qc }, createElement(Component)));
  });
}

async function settle() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const $ = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T>(sel);
const input = (id: string) => {
  const el = $<HTMLInputElement>(`#${id}`);
  if (!el) throw new Error(`no #${id} on screen:\n${host.textContent}`);
  return el;
};

function type(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function blur(el: HTMLElement) {
  act(() => {
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}
function button(label: RegExp): HTMLButtonElement {
  const b = [...host.querySelectorAll("button")].find((x) => label.test(x.textContent ?? ""));
  if (!b) throw new Error(`no button ${label} on screen:\n${host.textContent}`);
  return b;
}
async function press(label: RegExp) {
  const b = button(label);
  await act(async () => {
    if (b.type === "submit" && b.form) b.form.requestSubmit(b);
    else b.click();
  });
  await settle();
}
const problemText = () => $("[data-password-problem]")?.textContent ?? "";
const serverText = () => $("[data-password-server-error]")?.textContent ?? "";

beforeEach(() => {
  for (const f of Object.values(h)) if (typeof f === "function" && "mockReset" in f) f.mockReset();
  h.search = {};
  sessionStorage.clear();
  h.checkEmailAccount.mockResolvedValue({ exists: false, pendingInvite: false });
  h.signInWithPassword.mockResolvedValue({ error: null });
  h.acceptPendingInvite.mockResolvedValue(false);
  h.bootstrapOrganization.mockResolvedValue({ promoStored: null });
  h.sendEmailVerification.mockResolvedValue({ ok: true });
  h.validateSignupCode.mockResolvedValue({ valid: true, message: "ok" });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const GetStartedPage = (GetStarted as unknown as { options: { component: () => ReactNode } })
  .options.component;
const ResetPasswordPage = (ResetPassword as unknown as { options: { component: () => ReactNode } })
  .options.component;

describe("Get started, new business: the account step", () => {
  it("lists the rules under the password field before anything is typed", async () => {
    mount(GetStartedPage);
    await settle();
    const rules = $("[data-password-rules]");
    expect(rules?.textContent).toContain("At least 8 characters");
    expect(rules?.textContent).toContain("Not only spaces");
    // Nothing is called a problem before the person has done anything.
    expect(problemText()).toBe("");
  });

  it("a weak password blocks Continue and names the rule beside the field, live and on blur", async () => {
    mount(GetStartedPage);
    await settle();
    type(input("gs-email"), "owner@acme.test");
    type(input("gs-pass"), "short");
    expect(button(/^Continue$/).disabled).toBe(true);
    expect(problemText()).toMatch(/at least 8 characters/i);
    expect(input("gs-pass").getAttribute("aria-invalid")).toBe("true");

    // Eight spaces is eight characters, and was enough for this step before.
    type(input("gs-pass"), "        ");
    blur(input("gs-pass"));
    expect(button(/^Continue$/).disabled).toBe(true);
    expect(problemText()).toMatch(/only spaces/i);

    await press(/^Continue$/);
    expect(h.checkEmailAccount).not.toHaveBeenCalled();
  });

  it("names the rule on blur even when the field was left empty", async () => {
    mount(GetStartedPage);
    await settle();
    blur(input("gs-pass"));
    expect(problemText()).toMatch(/at least 8 characters/i);
  });

  it("a password that meets every rule lets Continue go", async () => {
    mount(GetStartedPage);
    await settle();
    type(input("gs-email"), "owner@acme.test");
    type(input("gs-pass"), "correct horse");
    expect(problemText()).toBe("");
    expect(button(/^Continue$/).disabled).toBe(false);
    await press(/^Continue$/);
    expect(h.checkEmailAccount).toHaveBeenCalledTimes(1);
    expect($("#gs-org")).not.toBeNull();
  });
});

describe("Get started: the auth server still refuses the password at the end", () => {
  async function throughToFinish() {
    mount(GetStartedPage);
    await settle();
    type(input("gs-email"), "owner@acme.test");
    type(input("gs-pass"), "password1");
    await press(/^Continue$/);
    type(input("gs-org"), "Acme Pet Waste Removal");
    type(input("gs-name"), "Jane Doe");
    await press(/^Continue$/);
  }

  for (const [label, refusal] of [
    ["the raw auth-server message", new Error(LEAKED)],
    ["registerAccount's prefixed message", new Error(`That password can't be used: ${LEAKED}`)],
  ] as const) {
    it(`puts a password field on the step with the reason beside it (${label})`, async () => {
      await throughToFinish();
      h.registerAccount.mockRejectedValueOnce(refusal);
      await press(/Create my workspace/);

      // Still on Finish: not bounced to "Create your account", nothing wiped.
      expect(host.textContent).not.toContain("Create your account");
      const field = input("gs-pass-again");
      expect(serverText()).toContain("known to be weak");
      expect(field.getAttribute("aria-invalid")).toBe("true");
      // The password they typed is still there to edit, not cleared.
      expect(field.value).toBe("password1");

      // A new password clears the old refusal and finishes.
      type(field, "a much better passphrase");
      expect(serverText()).toBe("");
      h.registerAccount.mockResolvedValueOnce({ ok: true });
      await press(/Create my workspace/);
      expect(h.registerAccount).toHaveBeenLastCalledWith({
        data: expect.objectContaining({
          email: "owner@acme.test",
          password: "a much better passphrase",
          orgName: "Acme Pet Waste Removal",
          displayName: "Jane Doe",
        }),
      });
      expect(h.navigate).toHaveBeenCalledWith({ to: "/onboarding" });
    });
  }

  it("keeps everything else that was typed: Back still shows the business step filled in", async () => {
    await throughToFinish();
    h.registerAccount.mockRejectedValueOnce(new Error(LEAKED));
    await press(/Create my workspace/);
    await press(/^Back$/);
    expect(input("gs-org").value).toBe("Acme Pet Waste Removal");
    expect(input("gs-name").value).toBe("Jane Doe");
  });

  it("a weak replacement keeps Create my workspace disabled", async () => {
    await throughToFinish();
    h.registerAccount.mockRejectedValueOnce(new Error(LEAKED));
    await press(/Create my workspace/);
    type(input("gs-pass-again"), "short");
    expect(button(/Create my workspace/).disabled).toBe(true);
    expect(problemText()).toMatch(/at least 8 characters/i);
  });

  it("a refusal that is not about the password stays a form error, with no password field added", async () => {
    await throughToFinish();
    // (A taken address is not this case: since #782 it goes to sign-in.)
    h.registerAccount.mockRejectedValueOnce(new Error("Could not create the account right now."));
    await press(/Create my workspace/);
    expect($("#gs-pass-again")).toBeNull();
    expect(host.textContent).toContain("Could not create the account right now.");
  });
});

describe("Get started, an address with a pending invitation (#651)", () => {
  it("a refused password shows a password field on the join form; name and email are kept", async () => {
    h.checkEmailAccount.mockResolvedValue({ exists: false, pendingInvite: true });
    mount(GetStartedPage);
    await settle();
    type(input("gs-email"), "tech@acme.test");
    type(input("gs-pass"), "password1");
    await press(/^Continue$/);
    type(input("gs-name"), "Sam Tech");
    h.registerAccount.mockRejectedValueOnce(new Error(LEAKED));
    await press(/Create account and join/);

    expect(host.textContent).toContain("You have been invited");
    expect(input("gs-name").value).toBe("Sam Tech");
    expect(host.textContent).toContain("tech@acme.test");
    expect(serverText()).toContain("known to be weak");
    type(input("gs-pass-join"), "short");
    expect(button(/Create account and join/).disabled).toBe(true);
    type(input("gs-pass-join"), "a much better passphrase");
    expect(button(/Create account and join/).disabled).toBe(false);
  });
});

describe("Get started, joining from an invitation link (staff invite accept)", () => {
  beforeEach(() => {
    h.search = { invite: "tok-1" };
    h.lookupInviteByToken.mockResolvedValue({
      ok: true,
      kind: "staff",
      email: "dispatch@acme.test",
      organization_name: "Acme",
      role: "dispatcher",
      role_label: "Dispatcher",
    });
  });

  it("lists the rules, blocks a weak password with the rule named, and lets a strong one go", async () => {
    mount(GetStartedPage);
    await settle();
    expect($("[data-password-rules]")?.textContent).toContain("At least 8 characters");
    type(input("gs-name"), "Dee Spatcher");
    type(input("gs-pass"), "short");
    expect(button(/Create account and join/).disabled).toBe(true);
    expect(problemText()).toMatch(/at least 8 characters/i);
    type(input("gs-pass"), "correct horse");
    expect(button(/Create account and join/).disabled).toBe(false);
  });

  it("a server refusal stays on the form, beside the password, with email and name intact", async () => {
    mount(GetStartedPage);
    await settle();
    type(input("gs-name"), "Dee Spatcher");
    type(input("gs-pass"), "password1");
    h.registerAccount.mockRejectedValueOnce(new Error(LEAKED));
    await press(/Create account and join/);
    expect(serverText()).toContain("known to be weak");
    expect(input("gs-email").value).toBe("dispatch@acme.test");
    expect(input("gs-name").value).toBe("Dee Spatcher");
    expect(input("gs-pass").value).toBe("password1");
    expect(h.navigate).not.toHaveBeenCalled();
  });
});

describe("Reset password", () => {
  it("lists the rules, blocks a weak password with the rule named, and lets a strong one go", async () => {
    mount(ResetPasswordPage);
    await settle();
    expect($("[data-password-rules]")?.textContent).toContain("At least 8 characters");
    type(input("pw"), "short");
    type(input("pw2"), "short");
    expect(button(/Update password/).disabled).toBe(true);
    expect(problemText()).toMatch(/at least 8 characters/i);
    type(input("pw"), "correct horse");
    type(input("pw2"), "correct horse");
    expect(button(/Update password/).disabled).toBe(false);
  });

  it("an auth-server refusal stays on the form, beside the password, with both fields intact", async () => {
    h.updateUser.mockResolvedValueOnce({ error: { code: "weak_password", message: LEAKED } });
    mount(ResetPasswordPage);
    await settle();
    type(input("pw"), "password1");
    type(input("pw2"), "password1");
    await press(/Update password/);
    expect(h.updateUser).toHaveBeenCalledWith({ password: "password1" });
    expect(serverText()).toContain("known to be weak");
    expect(input("pw").value).toBe("password1");
    expect(input("pw2").value).toBe("password1");
    expect(host.textContent).not.toContain("This link can't be used");
  });
});
