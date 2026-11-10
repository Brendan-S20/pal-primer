// #807 follow-up (Product should-fix on #810). A leaked-password (HIBP)
// refusal can only come from the auth server: whether a password is in a
// breach corpus is known to nobody else. Production has the check on.
//
// So the stub that stands in for the auth server has to answer the way the
// auth server answers: the RAW GoTrue body, `error_code: "weak_password"`,
// "Password is known to be weak and easy to guess, please choose a different
// one." The app's own prefix ("That password can't be used: …") is something
// registerAccount ADDS on the way out, and a stub that already carries it
// skips the step that adds it. #810's browser spec did exactly that.
//
// This file walks the whole chain with the raw shape at the start:
//
//   GoTrue's error object (as supabase-js hands it to createUser's caller)
//     → registerAccount's handler re-throws it with the prefix
//     → that message, and the raw one, are both recognised in the browser.
//
// The browser half (a form keeping the person on the password field) is in
// tests/a-weak-password-was-only-named-at-the-end.test.tsx and
// tests/viewports/a-weak-password-is-named-before-continue.spec.ts /
// a-teammate-joining-is-told-the-password-rules.spec.ts, all of which now
// answer with the raw server text.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  handlers: new Map<string, (a: { data: unknown }) => Promise<unknown>>(),
  validators: new Map<string, (d: unknown) => unknown>(),
  createUser: vi.fn(),
  order: [] as string[],
}));

vi.mock("@tanstack/react-start", () => ({
  // Each createServerFn() in auth-entry.functions.ts, in file order; the
  // handler and validator are kept so the test can call them directly.
  createServerFn: () => {
    const slot = { validator: (d: unknown) => d };
    const chain = {
      middleware: () => chain,
      inputValidator: (v: (d: unknown) => unknown) => {
        slot.validator = v;
        return chain;
      },
      handler: (fn: (a: { data: unknown }) => Promise<unknown>) => {
        const name = `fn${h.order.length}`;
        h.order.push(name);
        h.handlers.set(name, fn);
        h.validators.set(name, slot.validator);
        return Object.assign(async (a: { data: unknown }) => fn({ data: slot.validator(a.data) }), {
          __name: name,
        });
      },
    };
    return chain;
  },
  createMiddleware: () => {
    const chain: Record<string, () => unknown> = {};
    chain.server = () => chain;
    chain.client = () => chain;
    chain.middleware = () => chain;
    return chain;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { auth: { admin: { createUser: h.createUser } } },
}));

import { registerAccount } from "@/lib/auth-entry.functions";
import {
  PASSWORD_REJECTED_PREFIX,
  isPasswordRejection,
  passwordRejectionMessage,
} from "@/lib/password-policy";

const HIBP = "Password is known to be weak and easy to guess, please choose a different one.";

/** What supabase-js gives createUser's caller when GoTrue refuses a password
 *  on its leaked-password check: an AuthWeakPasswordError built from the
 *  422 body `{"code":422,"error_code":"weak_password","msg":"…",
 *  "weak_password":{"reasons":["pwned"]}}`. */
function goTrueWeakPassword() {
  return Object.assign(new Error(HIBP), {
    name: "AuthWeakPasswordError",
    __isAuthError: true,
    status: 422,
    code: "weak_password",
    reasons: ["pwned"],
  });
}

const call = (data: Record<string, unknown>) =>
  (registerAccount as unknown as (a: { data: unknown }) => Promise<unknown>)({ data });

const STRONG_ENOUGH = {
  email: "owner@acme.test",
  password: "password1234",
  orgName: "Great Lakes Yard Patrol",
  displayName: "Robin Okafor-Lindqvist",
};

beforeEach(() => {
  h.createUser.mockReset();
});

describe("registerAccount, given the auth server's raw weak_password refusal", () => {
  it("re-throws it with the prefix, keeping the server's own reason", async () => {
    h.createUser.mockResolvedValueOnce({ data: { user: null }, error: goTrueWeakPassword() });
    await expect(call(STRONG_ENOUGH)).rejects.toThrow(`${PASSWORD_REJECTED_PREFIX} ${HIBP}`);
  });

  it("the prefixed message it throws is one the browser treats as a password refusal", async () => {
    h.createUser.mockResolvedValueOnce({ data: { user: null }, error: goTrueWeakPassword() });
    const thrown = await call(STRONG_ENOUGH).catch((e: unknown) => e);
    expect(isPasswordRejection(thrown)).toBe(true);
  });

  it("only a password refusal gets the prefix", async () => {
    h.createUser.mockResolvedValueOnce({
      data: { user: null },
      error: Object.assign(new Error("Database error creating new user"), { status: 500 }),
    });
    const thrown = (await call(STRONG_ENOUGH).catch((e: unknown) => e)) as Error;
    expect(thrown.message).toBe("Database error creating new user");
    expect(isPasswordRejection(thrown)).toBe(false);
  });

  it("the auth server is reached only for a password the shared rules pass", async () => {
    await expect(call({ ...STRONG_ENOUGH, password: "short" })).rejects.toThrow();
    expect(h.createUser).not.toHaveBeenCalled();
  });
});

describe("the browser recognises both shapes of the same refusal", () => {
  it.each([
    ["GoTrue's error object", goTrueWeakPassword()],
    ["GoTrue's text alone, as a server function's error carries it", new Error(HIBP)],
    [
      "the 422 body's error_code, without the class name",
      { code: "weak_password", message: HIBP, status: 422 },
    ],
    ["registerAccount's prefixed re-throw", new Error(passwordRejectionMessage(HIBP))],
  ])("%s", (_label, err) => {
    expect(isPasswordRejection(err)).toBe(true);
  });
});
