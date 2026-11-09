// A pilot owner could not reset a password (2026-11-09). Every piece of the
// flow was wrong in its own way, and each is pinned here:
//
//   1. The REQUEST. Two call sites built two different redirects (/auth's
//      `${window.location.origin}/reset-password`, the profile page's
//      `${appOrigin()}/auth`) and showed Supabase's raw error. A failed send
//      (the send-email hook unreachable, a rate limit) must say what to do,
//      and must never read as "check your email".
//   2. The LINK COMING BACK. Supabase sends a recovery whose redirect is not
//      allow-listed to the site root. The root redirected to /auth, which
//      landed the recovery session like a sign-in: ensureBootstrapped ran
//      (minting a new organization for a removed member) and nobody was
//      asked for a new password. A `?code=` / `?token_hash=` was dropped.
//   3. /reset-password understood one shape (a hash supabase-js had already
//      read) and had no expired-link state.
//   4. The send-email hook built every link through Supabase's verify
//      endpoint, so a recovery depended on the allow-list it was failing.
//   5. Native: a recovery that came back through the iOS scheme was handled as
//      an OAuth sign-in, and on Android a recovery at the claimed root `/`
//      came through as "/#access_token=…", which nothing read.
//
// lib/password-recovery.ts, lib/auth-email-links.ts, lib/app-url-open.ts.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RESET_BAD_EMAIL,
  RESET_LINK_INVALID,
  RESET_RATE_LIMITED,
  RESET_SEND_FAILED,
  RECOVERY_FLAG_TTL_MS,
  __resetPasswordRecoveryForTests,
  captureRecoveryFromUrl,
  clearRecoveryPending,
  describeResetError,
  describeUpdatePasswordError,
  establishRecoverySession,
  isRecoveryPending,
  markRecoveryPending,
  passwordResetRedirect,
  readRecoveryLink,
  recoveryForwardPath,
  recoveryRedirectTarget,
  requestPasswordReset,
  safeResetRedirect,
  validateNewPassword,
} from "@/lib/password-recovery";
import { authEmailLink } from "@/lib/auth-email-links";
import { NATIVE_OAUTH_REDIRECT } from "@/lib/native-oauth-redirect";
import { needsSession } from "@/lib/pending-deep-link";
import { repoRelative } from "./support/repo-paths";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true, getPlatform: () => "ios" },
}));

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** A sessionStorage stand-in. */
function memoryStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

beforeEach(() => __resetPasswordRecoveryForTests());

// ── 1. THE REQUEST ─────────────────────────────────────────────────────────

describe("the reset request", () => {
  it("web and Android come back to /reset-password on the app's origin; iOS to its own scheme", () => {
    const origin = "https://app.houndstack.com/";
    expect(passwordResetRedirect({ platform: "web", origin })).toBe(
      "https://app.houndstack.com/reset-password",
    );
    // Android registers no custom scheme (only https App Links), so a scheme
    // link would open nothing there.
    expect(passwordResetRedirect({ platform: "android", origin })).toBe(
      "https://app.houndstack.com/reset-password",
    );
    expect(passwordResetRedirect({ platform: "ios", origin })).toBe(
      "consulting.thenorth.houndstack://auth-callback",
    );
  });

  it("the scheme is the one iOS registers", () => {
    const plist = read("ios/App/App/Info.plist");
    expect(plist).toContain(`<string>${NATIVE_OAUTH_REDIRECT.split("://")[0]}</string>`);
  });

  it("a send that failed is never reported as sent", async () => {
    const calls: Array<{ email: string; redirectTo?: string }> = [];
    const client = {
      auth: {
        resetPasswordForEmail: async (email: string, o?: { redirectTo?: string }) => {
          calls.push({ email, redirectTo: o?.redirectTo });
          // What Supabase answers when the send-email hook cannot be reached.
          return {
            error: {
              message: "Error sending recovery email",
              status: 500,
              code: "unexpected_failure",
            },
          };
        },
      },
    };
    const r = await requestPasswordReset(
      client,
      "  owner@example.com ",
      "https://app.houndstack.com/reset-password",
    );
    expect(r).toEqual({ ok: false, message: RESET_SEND_FAILED });
    expect(RESET_SEND_FAILED).toContain("support@houndstack.com");
    expect(calls).toEqual([
      { email: "owner@example.com", redirectTo: "https://app.houndstack.com/reset-password" },
    ]);
  });

  it("a network failure that rejects is a failure too", async () => {
    const client = {
      auth: {
        resetPasswordForEmail: async () => {
          throw new TypeError("Failed to fetch");
        },
      },
    };
    expect(await requestPasswordReset(client, "a@b.co", "x")).toEqual({
      ok: false,
      message: RESET_SEND_FAILED,
    });
  });

  it("success says where it went", async () => {
    const client = { auth: { resetPasswordForEmail: async () => ({ error: null }) } };
    expect(await requestPasswordReset(client, "a@b.co", "x")).toEqual({
      ok: true,
      sentTo: "a@b.co",
    });
  });

  it("an empty or malformed address is caught before anything is sent", async () => {
    const spy = vi.fn(async () => ({ error: null }));
    const r = await requestPasswordReset({ auth: { resetPasswordForEmail: spy } }, "nope", "x");
    expect(r).toEqual({ ok: false, message: RESET_BAD_EMAIL });
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    [
      { status: 429, message: "email rate limit exceeded", code: "over_email_send_rate_limit" },
      RESET_RATE_LIMITED,
    ],
    [
      {
        status: 429,
        message: "For security purposes, you can only request this after 52 seconds.",
      },
      RESET_RATE_LIMITED,
    ],
    [{ status: 500, message: "Error sending recovery email" }, RESET_SEND_FAILED],
    [
      { status: 500, message: "Failed to reach hook within maximum time", code: "hook_timeout" },
      RESET_SEND_FAILED,
    ],
    [
      {
        status: 400,
        message: "Unable to validate email address: invalid format",
        code: "validation_failed",
      },
      RESET_BAD_EMAIL,
    ],
  ])("Supabase's %j reads as a message a person can act on", (err, expected) => {
    expect(describeResetError(err)).toBe(expected);
  });

  it("every resetPasswordForEmail in src/ goes through the one helper", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (
          /\.(ts|tsx)$/.test(name) &&
          /\.resetPasswordForEmail\(/.test(readFileSync(p, "utf8"))
        ) {
          hits.push(repoRelative(p, ROOT));
        }
      }
    };
    walk(join(ROOT, "src"));
    expect(hits).toEqual(["src/lib/password-recovery.ts"]);
  });

  it("the profile page no longer asks for a link to /auth", () => {
    const profile = read("src/routes/_authenticated/profile.tsx");
    expect(profile).not.toMatch(/redirectTo:\s*`\$\{appOrigin\(\)\}\/auth`/);
    expect(profile).toContain("passwordResetRedirectHere()");
    const fn = read("src/lib/profile.functions.ts");
    expect(fn).toMatch(
      /requestPasswordReset\(supabase, email, safeResetRedirect\(data\.redirectTo\)\)/,
    );
  });

  it("the server keeps only a redirect this app would have built itself", () => {
    delete process.env.APP_ORIGIN;
    delete process.env.PUBLIC_APP_ORIGIN;
    delete process.env.APP_URL;
    const canonical = "https://app.houndstack.com/reset-password";
    expect(safeResetRedirect(undefined)).toBe(canonical);
    expect(safeResetRedirect("https://app.houndstack.com/auth")).toBe(canonical);
    expect(safeResetRedirect("javascript:alert(1)")).toBe(canonical);
    expect(safeResetRedirect("http://localhost:8080/reset-password")).toBe(
      "http://localhost:8080/reset-password",
    );
    expect(safeResetRedirect(NATIVE_OAUTH_REDIRECT)).toBe(NATIVE_OAUTH_REDIRECT);
  });

  it("/auth's Forgot password uses the helper and shows its failure", () => {
    const auth = read("src/routes/auth.tsx");
    const fn = auth.slice(
      auth.indexOf("const forgotPassword"),
      auth.indexOf("return (", auth.indexOf("const forgotPassword")),
    );
    expect(fn).toContain(
      "requestPasswordReset(supabase, email, await passwordResetRedirectHere())",
    );
    expect(fn).toMatch(/if \(!r\.ok\) setError\(r\.message\)/);
    expect(fn).not.toContain("window.location.origin");
  });
});

// ── 2. THE LINK COMING BACK ────────────────────────────────────────────────

const IMPLICIT =
  "#access_token=AT&expires_in=3600&refresh_token=RT&token_type=bearer&type=recovery";

describe("recognising a recovery link", () => {
  it.each([
    ["/?code=abc", { kind: "code", code: "abc" }],
    ["/reset-password?token_hash=th&type=recovery", { kind: "token_hash", tokenHash: "th" }],
    [`/auth${IMPLICIT}`, { kind: "implicit", accessToken: "AT", refreshToken: "RT" }],
    [
      "/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
      { kind: "error", description: "Email link is invalid or has expired" },
    ],
  ])("%s", (href, expected) => {
    expect(readRecoveryLink(href)).toEqual(expected);
  });

  it.each([
    "/auth",
    "/auth?invite=tok",
    // A web OAuth return: a session, but not a recovery.
    "/#access_token=AT&refresh_token=RT&token_type=bearer",
    "/?error=access_denied&error_description=cancelled",
  ])("%s is not one", (href) => {
    expect(readRecoveryLink(href)).toBeNull();
  });

  it("the root and /auth forward it to /reset-password with everything it came with", () => {
    expect(recoveryForwardPath("/?code=abc")).toBe("/reset-password?code=abc");
    expect(recoveryForwardPath("https://app.houndstack.com/?token_hash=th&type=recovery")).toBe(
      "/reset-password?token_hash=th&type=recovery",
    );
    expect(recoveryForwardPath(`/auth${IMPLICIT}`)).toBe(`/reset-password${IMPLICIT}`);
  });

  it("a ?code= on any other page is that page's, not ours", () => {
    expect(recoveryForwardPath("/settings/promotions?code=SPRING")).toBeNull();
  });

  it("the root route forwards before it redirects to /auth", () => {
    const index = read("src/routes/index.tsx");
    const forward = index.indexOf("recoveryForwardPath(location.href)");
    expect(forward).toBeGreaterThan(-1);
    expect(forward).toBeLessThan(index.indexOf('throw redirect({ to: "/auth" })'));
  });

  it("the URL is captured at boot, before supabase-js strips the hash", () => {
    const root = read("src/routes/__root.tsx");
    expect(root).toMatch(/captureRecoveryFromUrl\(window\.location\.href\)/);
  });
});

describe("a tab mid-recovery is not landed", () => {
  it("/auth checks for a recovery before identity, bootstrap or landing", () => {
    const auth = read("src/routes/auth.tsx");
    const run = auth.slice(auth.indexOf("const run = async () => {"));
    const guard = run.indexOf("recoveryRedirectTarget(window.location.href)");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(run.indexOf("resolveIdentity()"));
    expect(guard).toBeLessThan(run.indexOf("ensureBootstrapped("));
    expect(guard).toBeLessThan(run.indexOf("landingPathForUser("));
  });

  it("a hash read at boot sends /auth to /reset-password even once the URL is clean", () => {
    const store = memoryStore();
    captureRecoveryFromUrl(`https://app.houndstack.com/auth${IMPLICIT}`, store);
    // supabase-js has made a session of the hash and removed it.
    // The used tokens are not replayed: the session already exists.
    expect(recoveryRedirectTarget("https://app.houndstack.com/auth", store)).toBe(
      "/reset-password",
    );
    // And it stays that way for this tab, through a reload, until it is done.
    expect(recoveryRedirectTarget("https://app.houndstack.com/auth", store)).toBe(
      "/reset-password",
    );
    clearRecoveryPending(store);
    expect(recoveryRedirectTarget("https://app.houndstack.com/auth", store)).toBeNull();
  });

  it("a recovery somebody walked away from does not trap a later sign-in", () => {
    const store = memoryStore();
    markRecoveryPending(store, 1_000);
    expect(isRecoveryPending(store, 1_000 + RECOVERY_FLAG_TTL_MS - 1)).toBe(true);
    expect(isRecoveryPending(store, 1_000 + RECOVERY_FLAG_TTL_MS + 1)).toBe(false);
    expect(store.getItem("hs-password-recovery")).toBeNull();
  });

  it("an expired link read at boot is carried to /reset-password, so it can say why", () => {
    const store = memoryStore();
    const hash = "#error=access_denied&error_code=otp_expired&error_description=x";
    captureRecoveryFromUrl(`https://app.houndstack.com/auth${hash}`, store);
    expect(recoveryRedirectTarget("https://app.houndstack.com/auth", store)).toBe(
      `/reset-password${hash}`,
    );
  });

  it("an ordinary sign-in is not mistaken for one", () => {
    const store = memoryStore();
    expect(captureRecoveryFromUrl("https://app.houndstack.com/auth", store)).toBeNull();
    expect(recoveryRedirectTarget("https://app.houndstack.com/auth", store)).toBeNull();
  });

  it("a password sign-in clears it", () => {
    const auth = read("src/routes/auth.tsx");
    const signIn = auth.slice(auth.indexOf("const handleSignIn"));
    expect(signIn.indexOf("clearRecoveryPending()")).toBeGreaterThan(-1);
    expect(signIn.indexOf("clearRecoveryPending()")).toBeLessThan(
      signIn.indexOf("ensureBootstrapped("),
    );
  });
});

// ── 3. /reset-password ─────────────────────────────────────────────────────

function fakeAuth(over: Partial<Record<string, unknown>> = {}) {
  const calls: string[] = [];
  const ok = { error: null };
  const auth = {
    getSession: vi.fn(async () => ({ data: { session: null as unknown } })),
    exchangeCodeForSession: vi.fn(async (_c: string) => (calls.push("exchange"), ok)),
    verifyOtp: vi.fn(
      async (_p: { token_hash: string; type: "recovery" }) => (calls.push("verifyOtp"), ok),
    ),
    setSession: vi.fn(
      async (_p: { access_token: string; refresh_token: string }) => (calls.push("setSession"), ok),
    ),
    ...over,
  };
  return { client: { auth } as never, auth, calls };
}

describe("turning the link into a session", () => {
  it("?code= is exchanged", async () => {
    const { client, auth } = fakeAuth();
    expect(await establishRecoverySession(client, "/reset-password?code=C1")).toEqual({ ok: true });
    expect(auth.exchangeCodeForSession).toHaveBeenCalledWith("C1");
  });

  it("?token_hash= is verified as a recovery", async () => {
    const { client, auth } = fakeAuth();
    expect(
      await establishRecoverySession(client, "/reset-password?token_hash=TH&type=recovery"),
    ).toEqual({ ok: true });
    expect(auth.verifyOtp).toHaveBeenCalledWith({ token_hash: "TH", type: "recovery" });
  });

  it("a hash the app was handed (native) becomes a session with setSession", async () => {
    const { client, auth } = fakeAuth();
    expect(await establishRecoverySession(client, `/reset-password${IMPLICIT}`)).toEqual({
      ok: true,
    });
    expect(auth.setSession).toHaveBeenCalledWith({ access_token: "AT", refresh_token: "RT" });
  });

  it("a hash supabase-js already read is not replayed", async () => {
    const { client, auth } = fakeAuth({
      getSession: vi.fn(async () => ({ data: { session: { user: {} } } })),
    });
    expect(await establishRecoverySession(client, `/reset-password${IMPLICIT}`)).toEqual({
      ok: true,
    });
    expect(auth.setSession).not.toHaveBeenCalled();
  });

  it.each([
    [
      "an expired link",
      "/reset-password#error=access_denied&error_code=otp_expired&error_description=x",
      {},
    ],
    [
      "a used token_hash",
      "/reset-password?token_hash=TH&type=recovery",
      {
        verifyOtp: vi.fn(async () => ({
          error: { message: "Token has expired or is invalid", status: 403 },
        })),
      },
    ],
    [
      "a code from another browser",
      "/reset-password?code=C1",
      {
        exchangeCodeForSession: vi.fn(async () => ({
          error: { message: "invalid flow state", status: 400 },
        })),
      },
    ],
    ["no link and no session", "/reset-password", {}],
    [
      "a client that throws",
      "/reset-password?token_hash=TH",
      {
        verifyOtp: vi.fn(async () => {
          throw new Error("offline");
        }),
      },
    ],
  ])("%s is the expired/invalid state", async (_name, href, over) => {
    const { client } = fakeAuth(over as never);
    expect(await establishRecoverySession(client, href)).toEqual({
      ok: false,
      message: RESET_LINK_INVALID,
    });
  });

  // Found in a browser, not by the tests above: StrictMode runs the effect
  // twice. The exchange ran once (right: tokens are single-use) but its
  // answer was tied to the first run's `cancelled`, which the cleanup had
  // already set, so every link sat on "Checking your reset link…" for good.
  it("the answer reaches whichever run of the effect is still mounted", () => {
    const page = read("src/routes/reset-password.tsx");
    const effect = page.slice(
      page.indexOf("useEffect(() => {"),
      page.indexOf("const handleSubmit"),
    );
    expect(effect).toContain("if (!exchange.current) {");
    const guardEnd = effect.indexOf("\n    }\n", effect.indexOf("if (!exchange.current) {"));
    const listen = effect.indexOf("void exchange.current.then(");
    expect(listen).toBeGreaterThan(guardEnd);
    expect(effect).not.toContain("started.current");
  });

  it("the page offers a fresh link in that state, through the same helper", () => {
    const page = read("src/routes/reset-password.tsx");
    expect(page).toContain("establishRecoverySession(");
    expect(page).toContain('phase.kind === "invalid" && <ResendResetLink');
    expect(page).toContain(
      "requestPasswordReset(supabase, email, await passwordResetRedirectHere())",
    );
    expect(page).toContain("Send a new reset link");
  });
});

describe("setting the new password", () => {
  it("validates before sending", () => {
    expect(validateNewPassword("short", "short")).toMatch(/at least 8/);
    expect(validateNewPassword("        ", "        ")).toMatch(/only spaces/);
    expect(validateNewPassword("longenough1", "longenough2")).toMatch(/don't match/);
    expect(validateNewPassword("longenough1", "longenough1")).toBeNull();
  });

  it("explains updateUser's refusals, and a dead session is the expired-link state", () => {
    expect(
      describeUpdatePasswordError({
        code: "same_password",
        message: "New password should be different from the old password.",
      }),
    ).toEqual({
      message: "That's your current password. Choose a new one.",
      linkDead: false,
    });
    expect(
      describeUpdatePasswordError({
        code: "weak_password",
        message: "Password is known to be weak",
      }).linkDead,
    ).toBe(false);
    expect(describeUpdatePasswordError({ message: "Auth session missing!", status: 400 })).toEqual({
      message: RESET_LINK_INVALID,
      linkDead: true,
    });
  });

  it("the flag is cleared only after updateUser succeeds", () => {
    const page = read("src/routes/reset-password.tsx");
    const submit = page.slice(page.indexOf("const handleSubmit"));
    const update = submit.indexOf("supabase.auth.updateUser({ password })");
    const clear = submit.indexOf("clearRecoveryPending()");
    expect(submit.indexOf("validateNewPassword(")).toBeLessThan(update);
    expect(update).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(update);
    expect(clear).toBeLessThan(submit.indexOf('navigate({ to: "/auth" })'));
  });
});

// ── 4. THE EMAIL'S LINK ────────────────────────────────────────────────────

describe("the send-email hook's link", () => {
  const base = {
    supabaseUrl: "https://api.houndstack.com",
    tokenHash: "pkce_abc",
    siteUrl: "https://app.houndstack.com",
    appOrigin: "https://app.houndstack.com",
  };

  it("a recovery goes straight to /reset-password, not through the allow-list", () => {
    expect(
      authEmailLink({
        ...base,
        type: "recovery",
        redirectTo: "https://app.houndstack.com/reset-password",
      }),
    ).toBe("https://app.houndstack.com/reset-password?token_hash=pkce_abc&type=recovery");
    // The site-URL fallback Supabase uses when the redirect was refused.
    expect(
      authEmailLink({ ...base, type: "recovery", redirectTo: "https://app.houndstack.com" }),
    ).toBe("https://app.houndstack.com/reset-password?token_hash=pkce_abc&type=recovery");
    expect(authEmailLink({ ...base, type: "recovery", redirectTo: "" })).toBe(
      "https://app.houndstack.com/reset-password?token_hash=pkce_abc&type=recovery",
    );
  });

  it("never puts a token on a host that is not this app", () => {
    expect(
      authEmailLink({
        ...base,
        type: "recovery",
        redirectTo: "https://evil.example/reset-password",
      }),
    ).toBe("https://app.houndstack.com/reset-password?token_hash=pkce_abc&type=recovery");
  });

  it("a reset asked for in the iOS app comes back through its scheme", () => {
    const link = authEmailLink({ ...base, type: "recovery", redirectTo: NATIVE_OAUTH_REDIRECT });
    expect(link).toBe(
      `https://api.houndstack.com/auth/v1/verify?token=pkce_abc&type=recovery&redirect_to=${encodeURIComponent(NATIVE_OAUTH_REDIRECT)}`,
    );
  });

  it("other email types are unchanged", () => {
    expect(authEmailLink({ ...base, type: "signup", redirectTo: "" })).toBe(
      "https://api.houndstack.com/auth/v1/verify?token=pkce_abc&type=signup&redirect_to=https%3A%2F%2Fapp.houndstack.com",
    );
  });

  it("the webhook builds its link with it", () => {
    const hook = read("src/routes/email/auth/webhook.ts");
    expect(hook).toContain("authEmailLink({");
    expect(hook).toContain("appOrigin: appOrigin()");
  });
});

// ── 5. NATIVE ──────────────────────────────────────────────────────────────

describe("a recovery link that opens the app", () => {
  let classify: (url: string) => [string, string];
  beforeEach(async () => {
    classify = await (await import("@/lib/app-url-open")).loadClassifier();
  });
  afterEach(() => vi.restoreAllMocks());

  it("iOS: the scheme hand-back opens /reset-password, not the OAuth sign-in", () => {
    expect(classify(`${NATIVE_OAUTH_REDIRECT}${IMPLICIT}`)).toEqual([
      "path",
      `/reset-password${IMPLICIT}`,
    ]);
  });

  it("Android: a recovery at the claimed root opens /reset-password", () => {
    expect(classify(`https://app.houndstack.com/${IMPLICIT}`)).toEqual([
      "path",
      `/reset-password${IMPLICIT}`,
    ]);
    expect(classify("https://app.houndstack.com/?code=C1")).toEqual([
      "path",
      "/reset-password?code=C1",
    ]);
  });

  it("an expired link opens the expired state rather than nothing", () => {
    const url = `${NATIVE_OAUTH_REDIRECT}#error=access_denied&error_code=otp_expired&error_description=x`;
    expect(classify(url)[1]).toBe(
      "/reset-password#error=access_denied&error_code=otp_expired&error_description=x",
    );
  });

  it("an OAuth hand-back and a staff link are sorted as before", () => {
    expect(classify(`${NATIVE_OAUTH_REDIRECT}#access_token=x&refresh_token=y`)[0]).toBe("other");
    expect(classify("https://app.houndstack.com/clients")).toEqual(["path", "/clients"]);
  });

  it("/reset-password is pushed without waiting for a sign-in that cannot happen", () => {
    expect(needsSession("/reset-password#access_token=x")).toBe(false);
    expect(needsSession("/my-day")).toBe(true);
  });
});

// ── 6. NO AUTH CALLBACK ON THE DEAD HOST ───────────────────────────────────

describe("auth callbacks never name www.app.houndstack.com", () => {
  // It has been NXDOMAIN since 2026-08-10, and the production send-email hook
  // still pointed there on 2026-11-09, which failed every auth email (#764).
  // The config is not in this repo; the code is, and must not repeat it.
  it("no code in src/ (comments aside) names it", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx|js|mjs)$/.test(name)) {
          const code = readFileSync(p, "utf8")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .split("\n")
            .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
            .join("\n");
          if (code.includes("www.app.houndstack.com")) offenders.push(repoRelative(p, ROOT));
        }
      }
    };
    walk(join(ROOT, "src"));
    expect(offenders).toEqual([]);
  });
});
