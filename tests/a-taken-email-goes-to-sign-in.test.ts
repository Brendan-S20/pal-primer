// Signing up with an address that already has an account went nowhere (#765).
//
// The removed Detroit Doo Disposal teammate tried the obvious thing after
// sign-in failed: create a new account. /get-started said "That email already
// has an account. Sign in instead." and stayed where it was, on a form that
// could not continue, for a person whose problem was that they could not sign
// in. Now the address goes to /auth, which opens on the password step with it
// filled in and a reset button in the message.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const state = vi.hoisted(() => ({
  createUser: null as null | ((args: any) => Promise<any>),
}));

vi.mock("@tanstack/react-start", () => {
  const createServerFn = () => {
    let validate: (d: unknown) => unknown = (d) => d;
    const builder: any = {
      middleware: () => builder,
      inputValidator: (fn: typeof validate) => {
        validate = fn;
        return builder;
      },
      handler: (fn: any) => async (args?: { data: unknown }) =>
        fn({ data: validate(args?.data), context: {} }),
    };
    return builder;
  };
  return { createServerFn, createServerOnlyFn: (fn: unknown) => fn };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { auth: { admin: { createUser: (a: any) => state.createUser!(a) } } },
}));

const { registerAccount } = await import("@/lib/auth-entry.functions");
const { EMAIL_ALREADY_REGISTERED, handOffExistingAccount, takeExistingAccount } =
  await import("@/lib/signup-email");
const { SIGNUP_ORG_PENDING } = await import("@/lib/signup-marker");

const call = registerAccount as unknown as (a: { data: unknown }) => Promise<unknown>;

describe("registerAccount", () => {
  let created: any[];
  beforeEach(() => {
    created = [];
    state.createUser = async (a) => {
      created.push(a);
      return { error: null };
    };
  });

  it("marks a signup that named a business as unfinished, server-side", async () => {
    await call({
      data: {
        email: "new@example.com",
        password: "longenough",
        orgName: "Bark Patrol",
        displayName: "Jo",
      },
    });
    expect(created[0].app_metadata).toEqual({ [SIGNUP_ORG_PENDING]: true });
    expect(created[0].user_metadata[SIGNUP_ORG_PENDING]).toBeUndefined();
  });

  it("does not mark an invited teammate, who joins rather than builds", async () => {
    await call({ data: { email: "tech@example.com", password: "longenough", displayName: "Sam" } });
    expect(created[0].app_metadata).toBeUndefined();
  });

  it("refuses a taken address with the one sentence the page recognises", async () => {
    state.createUser = async () => ({
      error: { message: "A user with this email address has already been registered" },
    });
    await expect(
      call({
        data: {
          email: "owner@example.com",
          password: "longenough",
          orgName: "X Co",
          displayName: "O",
        },
      }),
    ).rejects.toThrow(EMAIL_ALREADY_REGISTERED);
  });
});

describe("the hand-off to sign-in", () => {
  it("carries the address once, in this tab, and not in the URL", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    });
    handOffExistingAccount("  owner@example.com ");
    expect(takeExistingAccount()).toBe("owner@example.com");
    expect(takeExistingAccount()).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe("the pages", () => {
  const started = codeOnly(read("src/routes/get-started.tsx"));
  const auth = codeOnly(read("src/routes/auth.tsx"));

  it("Get started sends a taken address to /auth instead of showing a dead-end error", () => {
    const cont = started.slice(started.indexOf("const continueFromAccount"));
    expect(cont.slice(0, cont.indexOf("const join"))).toMatch(
      /if \(r\.exists\) \{\s*sendToSignIn\(navigate, email\);/,
    );
    expect(started).toMatch(
      /function sendToSignIn[\s\S]{0,200}handOffExistingAccount\(email\);\s*navigate\(\{ to: "\/auth" \}\)/,
    );
    expect(started).not.toMatch(/setError\("That email already has an account/);
  });

  it("every registerAccount on Get started routes a refusal for a taken address the same way", () => {
    const calls = (started.match(/await registerAccount\(/g) ?? []).length;
    const routed = (
      started.match(/if \(isTakenEmail\(err\)\) return sendToSignIn\(navigate, email\);/g) ?? []
    ).length;
    expect(calls).toBeGreaterThan(0);
    expect(routed).toBe(calls);
  });

  it("the business signup (finishSignup, #795) routes a taken address too, but only before it registered", () => {
    const fin = started.slice(started.indexOf("const finish = async"));
    expect(fin.slice(0, fin.indexOf("return ("))).toMatch(
      /if \(!progress\.current\.registered && isTakenEmail\(err\)\) return sendToSignIn\(navigate, email\);\s*setError\(signupErrorMessage\(err, progress\.current\)\);/,
    );
  });

  it("/auth opens on the password step with the address, and offers the reset as a button", () => {
    expect(auth).toMatch(
      /const taken = takeExistingAccount\(\);[\s\S]{0,120}setEmail\(taken\);\s*setStage\("password"\);\s*setOfferReset\(true\);/,
    );
    expect(read("src/routes/auth.tsx")).toMatch(
      /offerReset && stage === "password"[\s\S]{0,300}void forgotPassword\(\)[\s\S]{0,250}Email me a reset link/,
    );
  });

  it("the password step still has Forgot password? beside the field", () => {
    expect(read("src/routes/auth.tsx")).toMatch(
      /void forgotPassword\(\)[\s\S]{0,600}Forgot password\?/,
    );
  });

  it("a failed reset says so in words, never silently", () => {
    const fp = auth.slice(auth.indexOf("const forgotPassword"));
    expect(fp.slice(0, 700)).toMatch(/if \(!r\.ok\) setError\(r\.message\);/);
  });
});
