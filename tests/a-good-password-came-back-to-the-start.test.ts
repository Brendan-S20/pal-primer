/**
 * #785 (b) and the #764 label note, pinned at the unit level.
 *
 * The browser half is tests/viewports/a-good-password-that-came-back-to-the-
 * start.spec.ts, which drives the real /auth page on the stub backend and
 * fails on the build QA reproduced it on. This half pins the two pieces it
 * rests on, in seconds and without a server:
 *
 *   1. trustFreshSignIn: the guard's first navigation after a good password
 *      does not ask the auth server again, and the trust ends exactly as a
 *      reused answer does (a sign-out, another user).
 *   2. lib/sign-in-handoff.ts: a hand-off that resolves back on /auth is
 *      reported and gives the form back, including after a page drew first
 *      (the 2026-11-11 reproduction); a stale one is never reported; a
 *      sign-out on purpose ends it; the password never reaches storage.
 *   3. The pieces that keep the form on its step: the remembered step, the
 *      words for a failure, and a held return path that is never /auth.
 *
 * And a source check on /auth for the wiring the browser spec cannot name a
 * line for: the label on each button, and the order of the hand-off.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { User } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  getUser: vi.fn(),
  getSession: vi.fn(),
  listener: null as null | ((event: string, session: unknown) => void),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getUser: auth.getUser,
      getSession: auth.getSession,
      onAuthStateChange: (cb: (event: string, session: unknown) => void) => {
        auth.listener = cb;
        return { data: { subscription: { unsubscribe() {} } } };
      },
    },
  },
}));

import { forgetVerifiedIdentity, resolveIdentity, trustFreshSignIn } from "@/lib/offline/identity";
import {
  forgetSignInStep,
  handOffSignIn,
  readSignInStep,
  rememberSignInStep,
  SIGN_IN_BOUNCED,
  SIGN_IN_HANDOFF_KEY,
  SIGN_IN_HANDOFF_TTL_MS,
  SIGN_IN_STEP_KEY,
  SIGN_IN_STEP_TTL_MS,
  signInFailureMessage,
  signInLanded,
  takeBouncedSignIn,
  watchSignInLanding,
  type ResolvedSubscribe,
} from "@/lib/sign-in-handoff";

const USER = {
  id: "22222222-2222-4222-8222-222222222222",
  email: "owner@example.test",
} as unknown as User;

/** A sessionStorage for node, so the module's storage half is exercised. */
function installSessionStorage() {
  const data = new Map<string, string>();
  const storage = {
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
  };
  vi.stubGlobal("window", { sessionStorage: storage, dispatchEvent: () => true });
  return data;
}

describe("a good password is not asked about again on the way in", () => {
  beforeEach(() => {
    forgetVerifiedIdentity();
    auth.getUser.mockReset();
    // The refusal QA's first attempt met: the server said yes to the
    // password and no to the very next getUser.
    auth.getUser.mockResolvedValue({
      data: { user: null },
      error: Object.assign(new Error("Session from session_id claim in JWT does not exist"), {
        status: 403,
      }),
    });
  });

  it("without the hand-over, the guard re-asks and a refusal reads as signed out", async () => {
    expect(await resolveIdentity()).toEqual({ ok: false, rejected: true });
    expect(auth.getUser).toHaveBeenCalledTimes(1);
  });

  it("with it, the guard takes the answer the sign-in just got", async () => {
    trustFreshSignIn(USER);
    expect(await resolveIdentity()).toMatchObject({ ok: true, userId: USER.id, verified: true });
    expect(auth.getUser).not.toHaveBeenCalled();
  });

  it("and the trust ends at once on a sign-out, as a reused answer does", async () => {
    trustFreshSignIn(USER);
    auth.listener?.("SIGNED_OUT", null);
    expect(await resolveIdentity()).toEqual({ ok: false, rejected: true });
    expect(auth.getUser).toHaveBeenCalledTimes(1);
  });

  it("or when the session belongs to someone else", async () => {
    trustFreshSignIn(USER);
    auth.listener?.("SIGNED_IN", { user: { id: "someone-else" } });
    await resolveIdentity();
    expect(auth.getUser).toHaveBeenCalledTimes(1);
  });
});

describe("a sign-in that came back to /auth says so (lib/sign-in-handoff.ts)", () => {
  let stored: Map<string, string>;
  beforeEach(() => {
    stored = installSessionStorage();
    signInLanded();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("gives back the email and the password, once", () => {
    handOffSignIn("owner@example.test", "hunter2-but-longer");
    expect(takeBouncedSignIn()).toEqual({
      email: "owner@example.test",
      password: "hunter2-but-longer",
    });
    expect(takeBouncedSignIn()).toBeNull();
  });

  it("never writes the password to storage", () => {
    handOffSignIn("owner@example.test", "hunter2-but-longer");
    const raw = stored.get(SIGN_IN_HANDOFF_KEY) ?? "";
    expect(raw).toContain("owner@example.test");
    expect(raw).not.toContain("hunter2");
  });

  it("survives a reload for the email (the password is typed once more)", () => {
    handOffSignIn("owner@example.test", "pw", 1_000);
    // A reload is a fresh module: simulate by dropping what memory held.
    const raw = stored.get(SIGN_IN_HANDOFF_KEY)!;
    signInLanded();
    stored.set(SIGN_IN_HANDOFF_KEY, raw);
    expect(takeBouncedSignIn(2_000)).toEqual({ email: "owner@example.test", password: "" });
  });

  it("is never reported once it is stale, so a later sign-out is not called a failure", () => {
    handOffSignIn("owner@example.test", "pw", 0);
    expect(takeBouncedSignIn(SIGN_IN_HANDOFF_TTL_MS + 1)).toBeNull();
  });

  it("a navigation that resolves on /auth is a bounce, and the page is told", () => {
    const fired: string[] = [];
    const target = { dispatchEvent: (e: Event) => (fired.push(e.type), true) };
    let resolved: ((e: { toLocation: { pathname: string } }) => void) | null = null;
    let unsubscribed = 0;
    const subscribe: ResolvedSubscribe = (_event, fn) => {
      resolved = fn;
      return () => void (unsubscribed += 1);
    };
    handOffSignIn("owner@example.test", "pw");
    watchSignInLanding(subscribe, target);
    resolved!({ toLocation: { pathname: "/auth" } });
    expect(fired).toEqual([SIGN_IN_BOUNCED]);
    expect(unsubscribed).toBe(1);
    expect(takeBouncedSignIn()).toMatchObject({ email: "owner@example.test" });
  });

  it("a page that drew first does not end the watch: a bounce after it is still reported", () => {
    // #799 dropped the hand-off on the first navigation that resolved
    // anywhere but /auth, so a session lost one page later came back to a
    // blank form (QA, live 2183efd2 and 3a028504).
    const fired: string[] = [];
    const target = { dispatchEvent: (e: Event) => (fired.push(e.type), true) };
    let resolved: ((e: { toLocation: { pathname: string } }) => void) | null = null;
    handOffSignIn("owner@example.test", "pw");
    rememberSignInStep("owner@example.test");
    const stop = watchSignInLanding((_e, fn) => ((resolved = fn), () => {}), target);
    resolved!({ toLocation: { pathname: "/dashboard" } });
    expect(fired).toEqual([]);
    // Left the form: the remembered STEP goes, the hand-off does not.
    expect(readSignInStep()).toBeNull();
    resolved!({ toLocation: { pathname: "/clients" } });
    resolved!({ toLocation: { pathname: "/auth" } });
    expect(fired).toEqual([SIGN_IN_BOUNCED]);
    expect(takeBouncedSignIn()).toMatchObject({ email: "owner@example.test", password: "pw" });
    stop();
  });

  it("the watch ends on its own once a bounce could no longer be one", () => {
    vi.useFakeTimers();
    try {
      const fired: string[] = [];
      const target = { dispatchEvent: (e: Event) => (fired.push(e.type), true) };
      let resolved: ((e: { toLocation: { pathname: string } }) => void) | null = null;
      let unsubscribed = 0;
      watchSignInLanding((_e, fn) => ((resolved = fn), () => void (unsubscribed += 1)), target);
      vi.advanceTimersByTime(SIGN_IN_HANDOFF_TTL_MS + 1);
      expect(unsubscribed).toBe(1);
      resolved!({ toLocation: { pathname: "/auth" } });
      expect(fired).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a second Sign in replaces the first one's watch rather than adding to it", () => {
    let unsubscribed = 0;
    const subscribe: ResolvedSubscribe = () => () => void (unsubscribed += 1);
    watchSignInLanding(subscribe, null);
    watchSignInLanding(subscribe, null)();
    expect(unsubscribed).toBe(2);
  });

  it("a sign-out on purpose ends it: signInLanded clears the hand-off and the step", () => {
    handOffSignIn("owner@example.test", "pw");
    rememberSignInStep("owner@example.test");
    signInLanded();
    expect(takeBouncedSignIn()).toBeNull();
    expect(readSignInStep()).toBeNull();
  });
});

describe("the step the form was on survives a redraw (lib/sign-in-handoff.ts)", () => {
  let stored: Map<string, string>;
  beforeEach(() => {
    stored = installSessionStorage();
    forgetSignInStep();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads back the email, and leaves it in place", () => {
    rememberSignInStep("owner@example.test", 1_000);
    expect(readSignInStep(2_000)).toBe("owner@example.test");
    expect(readSignInStep(3_000)).toBe("owner@example.test");
  });

  it("never holds a password, and forgets a stale step", () => {
    rememberSignInStep("owner@example.test", 0);
    expect(stored.get(SIGN_IN_STEP_KEY)).not.toMatch(/password/i);
    expect(readSignInStep(SIGN_IN_STEP_TTL_MS + 1)).toBeNull();
    expect(stored.has(SIGN_IN_STEP_KEY)).toBe(false);
  });
});

describe("a failure is said in words (signInFailureMessage)", () => {
  it("keeps a real sentence from the auth server", () => {
    expect(
      signInFailureMessage(Object.assign(new Error("Invalid login credentials"), { status: 400 })),
    ).toBe("Invalid login credentials");
  });

  it.each([
    ["an empty JSON body", Object.assign(new Error("{}"), { status: 500 })],
    ["no message at all", { status: 502, name: "AuthRetryableFetchError" }],
    ["a gateway error with a body", Object.assign(new Error("Bad gateway"), { status: 503 })],
    ["nothing", undefined],
  ])("replaces %s with what to do", (_label, error) => {
    const text = signInFailureMessage(error);
    expect(text).toMatch(/couldn't sign you in/i);
    expect(text).toMatch(/press sign in to try again/i);
  });

  it("names a connection that did not answer", () => {
    expect(signInFailureMessage(new TypeError("Failed to fetch"))).toMatch(/connection/i);
    expect(signInFailureMessage(new TypeError("Load failed"), "email-check")).toMatch(
      /check that email.*connection.*continue/i,
    );
  });
});

describe("a held return path is a path, and never /auth", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { location: { origin: "https://app.houndstack.com" } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["/settings/users?tab=a#b", "/settings/users?tab=a#b"],
    ["https://app.houndstack.com/clients/1?x=1", "/clients/1?x=1"],
    ["https://elsewhere.example/clients/1", null],
    ["//elsewhere.example/clients", null],
    ["/auth", null],
    ["/auth?invite=t", null],
    ["https://app.houndstack.com/auth", null],
    ["/", null],
    ["", null],
    ["clients", null],
  ])("%s -> %s", async (link, expected) => {
    const { inAppPath, holdDeepLink, takeDeepLink } = await import("@/lib/pending-deep-link");
    expect(inAppPath(link)).toBe(expected);
    holdDeepLink(link);
    expect(takeDeepLink()).toBe(expected);
  });
});

describe("/auth wiring", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "src/routes/auth.tsx"), "utf8");
  const at = src.indexOf("const handleSignIn");
  const handleSignIn = src.slice(at, src.indexOf("\n  };\n", at));

  it("trusts the fresh sign-in before anything navigates", () => {
    const trust = handleSignIn.indexOf("trustFreshSignIn(data.user);");
    expect(trust).toBeGreaterThan(handleSignIn.indexOf("signInWithPassword"));
    expect(trust).toBeLessThan(handleSignIn.indexOf("ensureBootstrapped"));
  });

  it("hands off and watches the landing before it navigates", () => {
    const handOff = handleSignIn.indexOf("handOffSignIn(email, password)");
    const watch = handleSignIn.indexOf("watchSignInLanding(");
    expect(handOff).toBeGreaterThan(handleSignIn.indexOf("ensureBootstrapped"));
    expect(watch).toBeGreaterThan(handOff);
    for (const leave of [
      'return navigate({ to: "/no-workspace" })',
      'return navigate({ to: "/onboarding" })',
      "land(data.user ?",
    ]) {
      expect(handleSignIn.indexOf(leave), leave).toBeGreaterThan(watch);
    }
  });

  it("adopts what was typed before React attached (a stale fill), and the ref is on the box", () => {
    expect(src).toMatch(/ref=\{emailInput\}\s+id="si-email"/);
    expect(src).toMatch(/const early = emailInput\.current\?\.value/);
    expect(src).toMatch(/if \(early\.trim\(\)\) \{\s+setEmail\(early\)/);
  });

  it("remembers the password step on Continue, and forgets it on Use a different email", () => {
    expect(src).toMatch(
      /if \(r\.exists\) \{\s+rememberSignInStep\(email\);\s+setStage\("password"\)/,
    );
    expect(src).toMatch(/onClick=\{\(\) => \{\s+forgetSignInStep\(\);\s+setStage\("email"\)/);
  });

  it("never shows a raw failure: every message on the sign-in path goes through the words", () => {
    expect(handleSignIn).toMatch(/setError\(signInFailureMessage\(error\)\)/);
    expect(handleSignIn).toMatch(
      /catch \(err\) \{\s+setLoading\(false\);\s+setStage\("password"\);\s+setError\(signInFailureMessage\(err\)\)/,
    );
    expect(handleSignIn).not.toMatch(/setError\(error\.message\)/);
  });

  it("every sign-out on purpose ends the hand-off before it signs out", () => {
    const cache = readFileSync(
      join(import.meta.dirname, "..", "src/lib/offline/read-cache.ts"),
      "utf8",
    );
    const fn = cache.slice(cache.indexOf("export async function signOutAndClearDevice"));
    expect(fn.indexOf("signInLanded();")).toBeGreaterThan(0);
    expect(fn.indexOf("forgetDeepLink();")).toBeGreaterThan(0);
    expect(fn.indexOf("signInLanded();")).toBeLessThan(fn.indexOf("await supabase.auth.signOut()"));
    const twoStep = readFileSync(
      join(import.meta.dirname, "..", "src/routes/two-step.tsx"),
      "utf8",
    );
    const out = twoStep.slice(twoStep.indexOf("const signOut = async"));
    expect(out.indexOf("signInLanded();")).toBeGreaterThan(0);
    expect(out.indexOf("signInLanded();")).toBeLessThan(out.indexOf("supabase.auth.signOut()"));
  });

  it("Forgot password? has its own words, and Sign in does not borrow them", () => {
    expect(src).toMatch(/\{resetting \? "Sending reset link…" : "Forgot password\?"\}/);
    expect(src).toMatch(/\{loading && !resetting \? "Signing in…" : "Sign in"\}/);
    expect(src).not.toMatch(/\{loading \? "Signing in…" : "Sign in"\}/);
  });
});

describe("a sign-up drawn again partway through keeps what was typed (#785 (a))", () => {
  let stored: Map<string, string>;
  beforeEach(() => {
    stored = installSessionStorage();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const typed = {
    step: 2,
    email: "new.owner@example.test",
    orgName: "Great Lakes Yard Patrol",
    displayName: "Robin",
    phone: "",
    smsConsent: false,
    promoCode: "LAUNCH20",
    creating: true,
  };

  it("reads back what it wrote, including a create that was still working", async () => {
    const { readSignupDraft, saveSignupDraft } = await import("@/lib/signup-draft");
    saveSignupDraft(typed, 1_000);
    expect(readSignupDraft(2_000)).toEqual({ ...typed, at: 1_000 });
  });

  it("has no field for the password, and writes none", async () => {
    const { saveSignupDraft, SIGNUP_DRAFT_KEY } = await import("@/lib/signup-draft");
    saveSignupDraft({ ...typed, password: "never-kept-password" } as typeof typed);
    expect(stored.get(SIGNUP_DRAFT_KEY)).not.toContain("never-kept-password");
  });

  it("writes nothing for an untouched form, and forgets a stale draft", async () => {
    const { readSignupDraft, saveSignupDraft, SIGNUP_DRAFT_KEY, SIGNUP_DRAFT_TTL_MS } =
      await import("@/lib/signup-draft");
    saveSignupDraft({ ...typed, email: "", orgName: "", displayName: "" });
    expect(stored.has(SIGNUP_DRAFT_KEY)).toBe(false);
    saveSignupDraft(typed, 0);
    expect(readSignupDraft(SIGNUP_DRAFT_TTL_MS + 1)).toBeNull();
    expect(stored.has(SIGNUP_DRAFT_KEY)).toBe(false);
  });

  it("/get-started clears it once the workspace exists, before it navigates", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "src/routes/get-started.tsx"), "utf8");
    const finish = src.slice(
      src.indexOf("const finish = async"),
      src.indexOf("return (", src.indexOf("const finish = async")),
    );
    expect(finish.indexOf("clearSignupDraft()")).toBeGreaterThan(0);
    expect(finish.lastIndexOf('navigate({ to: "/onboarding" })')).toBeGreaterThan(
      finish.lastIndexOf("clearSignupDraft()"),
    );
  });
});
