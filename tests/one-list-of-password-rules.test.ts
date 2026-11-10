// #807: the password rules are ONE list, in src/lib/password-policy.ts, and
// every form that sets a password and every server path that creates or
// changes one reads it. Before, Get started, the invite join form and the
// reset form each spelled `minLength={8}` / `length >= 8`, and registerAccount
// spelled `.min(8)` again: four copies, free to drift.
//
// The forms themselves are driven in a-weak-password-was-only-named-at-the-
// end.test.tsx. This file pins the list and the wiring.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_REJECTED_PREFIX,
  PASSWORD_RULES,
  checkPassword,
  isPasswordRejection,
  passwordProblem,
  passwordRejectionMessage,
  passwordSchema,
} from "@/lib/password-policy";
import { describeUpdatePasswordError, validateNewPassword } from "@/lib/password-recovery";
import { repoRelative } from "./support/repo-paths";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const SAMPLES = [
  "",
  "short",
  "1234567",
  "12345678",
  "        ",
  "  pass  ",
  "correct horse",
  "x".repeat(PASSWORD_MAX_LENGTH),
  "x".repeat(PASSWORD_MAX_LENGTH + 1),
  "ünïcødé✓✓",
];

describe("the policy", () => {
  it("is the project's effective Supabase Auth policy, and no stricter", () => {
    // Nothing in this repo configures character classes; 8 is what every
    // form and registerAccount already required; 72 is bcrypt's limit,
    // which the auth server enforces.
    expect(PASSWORD_MIN_LENGTH).toBe(8);
    expect(PASSWORD_MAX_LENGTH).toBe(72);
    expect(PASSWORD_RULES.map((r) => r.id).sort()).toEqual([
      "max-length",
      "min-length",
      "not-blank",
    ]);
    expect(checkPassword("abcdefgh").ok).toBe(true);
  });

  it("names the rule a password breaks", () => {
    expect(passwordProblem("short")).toMatch(/at least 8 characters/);
    expect(passwordProblem("        ")).toMatch(/only spaces/);
    expect(passwordProblem("x".repeat(73))).toMatch(/longer than 72/);
    expect(passwordProblem("correct horse")).toBeNull();
    // Empty is the length rule's to name, not "only spaces".
    expect(checkPassword("").failing.map((r) => r.id)).toEqual(["min-length"]);
  });

  it("lists, before typing, every rule an ordinary password could break", () => {
    const listed = PASSWORD_RULES.filter((r) => r.listed).map((r) => r.label);
    expect(listed).toContain("At least 8 characters");
    expect(listed).toContain("Not only spaces");
  });

  it("the server's Zod and the forms' check give the same answer on every sample", () => {
    for (const p of SAMPLES) {
      const zodOk = passwordSchema.safeParse(p).success;
      expect({ p, ok: zodOk }).toEqual({ p, ok: checkPassword(p).ok });
    }
    const r = passwordSchema.safeParse("short");
    expect(!r.success && r.error.issues[0].message).toBe(passwordProblem("short"));
  });

  it("the reset form's own check is the same list", () => {
    for (const p of SAMPLES) {
      expect(validateNewPassword(p, p)).toBe(passwordProblem(p));
    }
    expect(validateNewPassword("correct horse", "correct horsf")).toMatch(/don't match/);
  });
});

describe("telling a refused password from any other refusal", () => {
  it.each([
    [{ code: "weak_password", message: "Password is known to be weak and easy to guess" }],
    [{ name: "AuthWeakPasswordError", message: "anything" }],
    [{ message: "Password is known to be weak and easy to guess, please choose a different one." }],
    [{ message: "Password should be at least 6 characters." }],
    [{ message: "Password should contain at least one character of each: abc..." }],
    [{ message: "Password cannot be longer than 72 characters" }],
    [new Error(`${PASSWORD_REJECTED_PREFIX} Password has appeared in a data breach`)],
  ])("is a password refusal: %o", (err) => {
    expect(isPasswordRejection(err)).toBe(true);
  });

  it.each([
    [new Error("That email already has an account. Sign in instead.")],
    [new Error("Failed to fetch")],
    [{ message: "Invalid login credentials" }],
    [{ message: "Auth session missing!", status: 400 }],
    // A validator's issue list mentions the rule but is not the auth server's
    // answer; shown behind the prefix it would read as a raw blob (review on #810).
    [
      new Error(
        '[{"code":"custom","message":"Password must be at least 8 characters.","path":["password"]}]',
      ),
    ],
    [new Error("We need your password to be at least as long as before")],
    [null],
    ["weak password"],
  ])("is not: %o", (err) => {
    expect(isPasswordRejection(err)).toBe(false);
  });

  it("keeps the server's reason, prefixed once", () => {
    const once = passwordRejectionMessage("Password is known to be weak");
    expect(once).toBe(`${PASSWORD_REJECTED_PREFIX} Password is known to be weak`);
    expect(passwordRejectionMessage(once)).toBe(once);
    expect(passwordRejectionMessage("")).toMatch(/choose a different one/);
  });

  it("the reset form's description of updateUser's refusal says the server's reason", () => {
    const d = describeUpdatePasswordError({
      code: "weak_password",
      message: "Password is known to be weak",
    });
    expect(d).toEqual({
      message: `${PASSWORD_REJECTED_PREFIX} Password is known to be weak`,
      linkDead: false,
    });
  });
});

describe("the wiring", () => {
  const FORMS = ["src/routes/get-started.tsx", "src/routes/reset-password.tsx"];

  it.each(FORMS)("%s takes its rules from the shared list, not its own copy", (file) => {
    const src = read(file);
    expect(src).toMatch(/from "@\/components\/PasswordField"/);
    expect(src).toMatch(/from "@\/lib\/password-policy"/);
    expect(src).not.toMatch(/minLength=\{\s*\d+\s*\}/);
    expect(src).not.toMatch(/password\.length\s*[<>]=?\s*\d/);
    expect(src).not.toMatch(/At least 8 characters/);
  });

  it("registerAccount validates with the shared schema and marks a refused password as one", () => {
    const src = read("src/lib/auth-entry.functions.ts");
    expect(src).toMatch(/password:\s*passwordSchema/);
    expect(src).not.toMatch(/password:\s*z\.string\(\)/);
    expect(src).toMatch(
      /isPasswordRejection\(error\)\)\s*throw new Error\(passwordRejectionMessage\(/,
    );
  });

  it("every place in src/ that sets a password reads the shared list", () => {
    // Creating a user with a password, or changing one: the browser's
    // updateUser({ password }), the admin createUser / updateUserById with a
    // password. Wherever one appears, password-policy has to be in reach,
    // either in the file itself or in the form that feeds it.
    const setsPassword =
      /updateUser\(\s*\{\s*password\b|createUser\(\s*\{[^}]*\bpassword\b|updateUserById\([^)]*\{[^}]*\bpassword\b/s;
    const offenders = walk(join(root, "src"))
      .filter((f) => setsPassword.test(readFileSync(f, "utf8")))
      .filter((f) => !/password-policy/.test(readFileSync(f, "utf8")))
      .map((f) => repoRelative(f, root));
    expect(offenders).toEqual([]);
    // And the sweep is looking at something: both known sites match it.
    const found = walk(join(root, "src"))
      .filter((f) => setsPassword.test(readFileSync(f, "utf8")))
      .map((f) => repoRelative(f, root))
      .sort();
    expect(found).toEqual(["src/lib/auth-entry.functions.ts", "src/routes/reset-password.tsx"]);
  });
});
