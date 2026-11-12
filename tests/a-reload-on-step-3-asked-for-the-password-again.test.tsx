// @vitest-environment happy-dom
//
// #882: during sign-up, after the password had been entered, a reload put
// "Your password … it is asked for again after the page reloads" on step 3.
//
// The cause: #785's restore asked for the password on ANY step past the
// first, because the password is never kept. But "Create my workspace"
// registers the account and signs in BEFORE it builds the business, and the
// Supabase client stores that session on the device. A reload in that window
// (the slow first submit #785 was about) came back asking for the password of
// an account that already existed, on a device already signed in to it. How
// far the create had got lived only in a React ref; nothing read the session.
//
// lib/signup-resume.ts decides from the session: signed in as the draft's
// address means carry on with no password. Anything else asks, and says the
// account is not created yet. The password is never written anywhere.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  readSessionEmail,
  resumeSignup,
  SIGNUP_RESUMED_SIGNED_IN_MESSAGE,
} from "@/lib/signup-resume";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("resumeSignup: what a restored draft needs", () => {
  it("signed in as the draft's address: no password", () => {
    expect(resumeSignup({ email: "Owner@Acme.test ", step: 2 }, "owner@acme.test")).toEqual({
      signedIn: true,
      askPassword: false,
    });
  });
  it("no session: the account is not created yet, so the password is asked for", () => {
    expect(resumeSignup({ email: "owner@acme.test", step: 2 }, null)).toEqual({
      signedIn: false,
      askPassword: true,
    });
  });
  it("signed in as somebody else: never carries on as them", () => {
    expect(resumeSignup({ email: "owner@acme.test", step: 2 }, "other@acme.test")).toEqual({
      signedIn: false,
      askPassword: true,
    });
  });
  it("the first step has its own password field and asks nothing extra", () => {
    expect(resumeSignup({ email: "owner@acme.test", step: 0 }, "owner@acme.test")).toEqual({
      signedIn: false,
      askPassword: false,
    });
  });
});

describe("readSessionEmail", () => {
  it("reads the stored session's address", async () => {
    const get = async () => ({ data: { session: { user: { email: "a@b.test" } } } });
    expect(await readSessionEmail(get)).toBe("a@b.test");
  });
  it("no session, a failure, or no answer in time is null, never a throw", async () => {
    expect(await readSessionEmail(async () => ({ data: { session: null } }))).toBeNull();
    expect(
      await readSessionEmail(async () => {
        throw new Error("offline");
      }),
    ).toBeNull();
    expect(await readSessionEmail(() => new Promise(() => {}), 5)).toBeNull();
  });
});

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  checkEmailAccount: vi.fn(),
  registerAccount: vi.fn(),
  sendEmailVerification: vi.fn(),
  bootstrapOrganization: vi.fn(),
  recordSmsConsent: vi.fn(),
  validateSignupCode: vi.fn(),
  acceptPendingInvite: vi.fn(),
  signInWithPassword: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({
    options: opts,
    useSearch: () => ({}),
  }),
  Link: ({ children, to }: { children?: ReactNode; to?: string }) =>
    createElement("a", { href: to }, children),
  useNavigate: () => h.navigate,
}));
vi.mock("@/lib/auth-entry.functions", () => ({
  checkEmailAccount: h.checkEmailAccount,
  checkNewPassword: async () => ({ ok: true, problem: null }),
  registerAccount: h.registerAccount,
  sendEmailVerification: h.sendEmailVerification,
}));
vi.mock("@/lib/org.functions", () => ({
  bootstrapOrganization: h.bootstrapOrganization,
  recordSmsConsent: h.recordSmsConsent,
  validateSignupCode: h.validateSignupCode,
}));
vi.mock("@/lib/platform-onboarding.functions", () => ({ lookupInviteByToken: vi.fn() }));
vi.mock("@/lib/ensure-workspace", () => ({
  acceptPendingInvite: h.acceptPendingInvite,
  rememberInviteToken: () => {},
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      signInWithPassword: h.signInWithPassword,
      getSession: h.getSession,
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  },
}));
vi.mock("sonner", () => ({
  toast: Object.assign(() => {}, { warning: () => {}, error: () => {}, success: () => {} }),
}));

import { Route as GetStarted } from "@/routes/get-started";
import { SIGNUP_DRAFT_KEY, SIGNUP_INTERRUPTED_MESSAGE } from "@/lib/signup-draft";

const GetStartedPage = (GetStarted as unknown as { options: { component: () => ReactNode } })
  .options.component;

const EMAIL = "new.owner@acme.test";
let root: Root | null = null;
let host: HTMLElement | null = null;

function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  const r = createRoot(host);
  root = r;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    r.render(createElement(QueryClientProvider, { client: qc }, createElement(GetStartedPage)));
  });
}
async function settle() {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}
function button(label: RegExp): HTMLButtonElement {
  const b = [...host!.querySelectorAll("button")].find((x) => label.test(x.textContent ?? ""));
  if (!b) throw new Error(`no button ${label} on screen:\n${host!.textContent}`);
  return b;
}

/** The page as a reload on step 3 finds it: the draft #785 keeps. */
function draftOnStep3(creating: boolean) {
  sessionStorage.setItem(
    SIGNUP_DRAFT_KEY,
    JSON.stringify({
      step: 2,
      email: EMAIL,
      orgName: "Great Lakes Yard Patrol",
      displayName: "Robin",
      phone: "",
      smsConsent: false,
      promoCode: "",
      creating,
      at: Date.now(),
    }),
  );
}

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
  sessionStorage.clear();
  h.signInWithPassword.mockResolvedValue({ error: null });
  h.acceptPendingInvite.mockResolvedValue(false);
  h.bootstrapOrganization.mockResolvedValue({ promoStored: null });
  h.sendEmailVerification.mockResolvedValue({ ok: true });
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("Get started, reloaded on step 3 (#882)", () => {
  it("after the account was made: no password field, and it finishes signed in", async () => {
    draftOnStep3(true);
    h.getSession.mockResolvedValue({ data: { session: { user: { email: EMAIL } } } });
    mount();
    await settle();
    expect(host!.querySelector("#gs-pass-again")).toBeNull();
    expect(host!.textContent).not.toMatch(/password/i);
    expect(host!.textContent).toContain(SIGNUP_RESUMED_SIGNED_IN_MESSAGE);
    const go = button(/^Try again$/);
    expect(go.disabled).toBe(false);
    await act(async () => go.form!.requestSubmit(go));
    await settle();
    // Not a second account, and not a sign-in that would need the password.
    expect(h.registerAccount).not.toHaveBeenCalled();
    expect(h.signInWithPassword).not.toHaveBeenCalled();
    expect(h.bootstrapOrganization).toHaveBeenCalledTimes(1);
    expect(h.navigate).toHaveBeenCalledWith({ to: "/onboarding" });
  });

  it("signed in but nothing was still working: says so, offers Finish setting up", async () => {
    draftOnStep3(false);
    h.getSession.mockResolvedValue({ data: { session: { user: { email: EMAIL } } } });
    mount();
    await settle();
    expect(host!.querySelector("#gs-pass-again")).toBeNull();
    expect(host!.querySelector("[data-signup-resumed]")?.textContent).toContain(EMAIL);
    expect(button(/^Finish setting up$/).disabled).toBe(false);
  });

  it("before any account exists: asks once, and says the account is not created yet", async () => {
    draftOnStep3(true);
    h.getSession.mockResolvedValue({ data: { session: null } });
    mount();
    await settle();
    expect(host!.querySelector("#gs-pass-again")).not.toBeNull();
    expect(host!.textContent).toContain(`Your account for ${EMAIL} is not created yet.`);
    expect(host!.textContent).toContain(SIGNUP_INTERRUPTED_MESSAGE);
    expect(button(/^Create my workspace$/).disabled).toBe(true);
  });

  it("signed in as a different address: asks, and never finishes as them", async () => {
    draftOnStep3(false);
    h.getSession.mockResolvedValue({ data: { session: { user: { email: "x@other.test" } } } });
    mount();
    await settle();
    expect(host!.querySelector("#gs-pass-again")).not.toBeNull();
    expect(button(/^Create my workspace$/).disabled).toBe(true);
  });

  it("keeps nothing that looks like a password", async () => {
    draftOnStep3(false);
    h.getSession.mockResolvedValue({ data: { session: { user: { email: EMAIL } } } });
    mount();
    await settle();
    expect(sessionStorage.getItem(SIGNUP_DRAFT_KEY) ?? "").not.toMatch(/password/i);
    expect(JSON.stringify({ ...localStorage })).not.toMatch(/password/i);
  });
});
