// The rules a new password has to meet: ONE list, read by every form that
// sets a password and by every server path that creates or changes one.
//
// ── WHY THIS FILE EXISTS (#807) ─────────────────────────────────────────────
//
// Brendan, 2026-11-09: "when you enter a password for an account when creating
// one; it doesn't tell you that the password is weak til you're all the way
// through, it should tell you as you try to move from then."
//
// Get started asked for the password on its first step, checked only
// `length >= 8` there, and sent it to the auth server on its LAST step. A
// password the auth server refused came back after the business name, the
// owner's name and the texting opt-in had all been filled in, on a step with
// no password field on it. Each form spelled its own `minLength={8}`, and the
// server's Zod said `.min(8)` a fourth time, so the copies could drift.
//
// ── WHAT THE POLICY IS ──────────────────────────────────────────────────────
//
// The project's effective Supabase Auth policy, and nothing stricter than
// production: nothing in this repo (supabase/config.toml, docs/) configures
// character classes, so there are none here. What is enforced:
//
//   - at least 8 characters (what every form and registerAccount already
//     required, and at least the auth server's own minimum of 6);
//   - no more than 72 characters (GoTrue hashes with bcrypt and refuses
//     anything longer, "Password cannot be longer than 72 characters");
//   - not only spaces (the reset form's existing rule).
//
// If the project ever turns on character classes in Supabase Auth, add a rule
// to PASSWORD_RULES. Every form shows it before typing, checks it live, and
// blocks Continue on it, and the server's Zod refuses it, with no form edited.
// A rule the auth server enforces but this list cannot know (the leaked-
// password check) still comes back from the server; isPasswordRejection()
// recognises that answer so the form keeps the person on the password field.

import { z } from "zod";

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 72;

export type PasswordRule = {
  id: "min-length" | "max-length" | "not-blank";
  /** The rule as listed under the field before anything is typed. */
  label: string;
  /** The rule named as a problem, next to the field and from the server. */
  problem: string;
  /** Listed under the field before typing. A rule that only an unusual
   *  password can break (72 characters) is named only when it is broken. */
  listed: boolean;
  test: (password: string) => boolean;
};

export const PASSWORD_RULES: readonly PasswordRule[] = [
  {
    id: "min-length",
    label: `At least ${PASSWORD_MIN_LENGTH} characters`,
    problem: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`,
    listed: true,
    test: (p) => p.length >= PASSWORD_MIN_LENGTH,
  },
  {
    id: "not-blank",
    label: "Not only spaces",
    problem: "Password can't be only spaces.",
    listed: true,
    // An empty field is the length rule's to name, not this one's.
    test: (p) => p.length === 0 || p.trim().length > 0,
  },
  {
    id: "max-length",
    label: `No more than ${PASSWORD_MAX_LENGTH} characters`,
    problem: `Password can't be longer than ${PASSWORD_MAX_LENGTH} characters.`,
    listed: false,
    test: (p) => p.length <= PASSWORD_MAX_LENGTH,
  },
];

export type PasswordCheck = {
  ok: boolean;
  rules: { rule: PasswordRule; met: boolean }[];
  failing: PasswordRule[];
};

export function checkPassword(password: string): PasswordCheck {
  const rules = PASSWORD_RULES.map((rule) => ({ rule, met: rule.test(password) }));
  const failing = rules.filter((r) => !r.met).map((r) => r.rule);
  return { ok: failing.length === 0, rules, failing };
}

/** The first rule a password breaks, said as a sentence. Null when it passes. */
export function passwordProblem(password: string): string | null {
  return checkPassword(password).failing[0]?.problem ?? null;
}

export const isPasswordAcceptable = (password: string): boolean => checkPassword(password).ok;

/** The server half: the same rules, as Zod, for any server function that
 *  creates or changes a password. */
export const passwordSchema = z.string().superRefine((value, ctx) => {
  for (const rule of checkPassword(value).failing) {
    ctx.addIssue({ code: "custom", message: rule.problem });
  }
});

// ── WHEN THE AUTH SERVER STILL SAYS NO ──────────────────────────────────────

/** Prefix registerAccount puts on a refused password, so the browser can tell
 *  "this password" from "this email" or "the network" in a server function's
 *  error, which arrives as a message only. */
export const PASSWORD_REJECTED_PREFIX = "That password can't be used:";

type ErrorLike = { message?: string | null; code?: string | null; name?: string | null };

/** Whether an error from the auth server (or from a server function that
 *  passed one on) is about the password itself, and so belongs on the
 *  password field rather than at the top of the form. */
export function isPasswordRejection(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as ErrorLike;
  const code = (e.code ?? "").toLowerCase();
  const name = (e.name ?? "").toLowerCase();
  const msg = (e.message ?? "").toLowerCase();
  if (code === "weak_password" || name === "authweakpassworderror") return true;
  if (msg.startsWith(PASSWORD_REJECTED_PREFIX.toLowerCase())) return true;
  // The auth server's own wording, which always opens with "Password" ("Password
  // is known to be weak…", "Password should be at least 6 characters"). Anchored
  // there, so a message that merely mentions a password somewhere (a Zod issue
  // list from a validator, which opens with "[") is not shown as the reason.
  return (
    msg.startsWith("password ") &&
    (msg.includes("weak") ||
      msg.includes("pwned") ||
      msg.includes("leaked") ||
      msg.includes("breach") ||
      msg.includes("should be at least") ||
      msg.includes("should contain") ||
      msg.includes("longer than"))
  );
}

/** The server's refusal, worded for the person typing. Keeps the server's own
 *  reason (a leaked-password check says so), with one prefix, once. */
export function passwordRejectionMessage(raw: string | null | undefined): string {
  const reason = (raw ?? "").trim();
  if (!reason) return `${PASSWORD_REJECTED_PREFIX} choose a different one.`;
  if (reason.toLowerCase().startsWith(PASSWORD_REJECTED_PREFIX.toLowerCase())) return reason;
  return `${PASSWORD_REJECTED_PREFIX} ${reason}`;
}
