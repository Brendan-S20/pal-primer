// Two-step sign-in, on Supabase's own MFA.
//
// Two kinds of second step, both Supabase factors:
//   * an authenticator app (TOTP) -- works everywhere, costs nothing, and is
//     the stronger of the two;
//   * a text message -- only once an SMS provider (Twilio Verify) is connected
//     in the Supabase dashboard and Phone MFA is switched on there. Until then
//     enrolling one fails, and the screens say so in words.
//
// The database is what actually enforces it (public.mfa_satisfied(), see
// supabase/migrations/20261002010000_a-password-was-the-only-lock.sql): these
// helpers only decide which screen to show.

import { supabase } from "@/integrations/supabase/client";

export type SecondStepFactor = {
  id: string;
  type: "totp" | "phone";
  label: string;
};

/** True when this session signed in with the first step only and the user has
 *  a verified second step: the app must ask for the code before anything else.
 *  Read from the session on the device, so it answers offline too. */
export async function needsSecondStep(): Promise<boolean> {
  // "Cannot tell" answers no. This only decides which screen to show; the
  // database is what refuses an unfinished session (public.mfa_satisfied), so
  // a failure here can cost a confusing screen, never an open door -- and it
  // must not be able to break signing in for the people who never turned
  // two-step on.
  try {
    const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (error || !data) return false;
    return data.currentLevel === "aal1" && data.nextLevel === "aal2";
  } catch {
    return false;
  }
}

/** The user's verified factors, authenticator app first. */
export async function verifiedFactors(): Promise<SecondStepFactor[]> {
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error) throw new Error(error.message);
  const out: SecondStepFactor[] = [];
  for (const f of data?.totp ?? []) {
    out.push({ id: f.id, type: "totp", label: f.friendly_name || "Authenticator app" });
  }
  for (const f of (
    data as { phone?: Array<{ id: string; friendly_name?: string; phone?: string }> }
  )?.phone ?? []) {
    out.push({
      id: f.id,
      type: "phone",
      label: f.phone ? `Text to ${maskPhone(f.phone)}` : f.friendly_name || "Text message",
    });
  }
  return out;
}

/** Factors left half-made by an enrolment somebody abandoned. Supabase refuses
 *  a second unverified factor with the same name, so they are cleared before a
 *  new attempt. */
export async function clearUnverifiedFactors(): Promise<void> {
  const { data } = await supabase.auth.mfa.listFactors();
  for (const f of data?.all ?? []) {
    if (f.status !== "verified") await supabase.auth.mfa.unenroll({ factorId: f.id });
  }
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 4 ? `•••• ${digits.slice(-4)}` : "your phone";
}

/** The sentence for a kind of second step this Supabase project has switched
 *  off (Authentication > Multi-Factor in the dashboard; `[auth.mfa.totp]` /
 *  `[auth.mfa.phone]` in supabase/config.toml for the local stack). */
export const SECOND_STEP_UNAVAILABLE: Record<"totp" | "phone", string> = {
  totp: "Authenticator apps aren't available for HoundStack yet.",
  phone: "Text-message codes aren't set up for HoundStack yet.",
};

/** True when Supabase refused because enrolling (or verifying) this kind of
 *  factor is switched off for the project: a setting, not something the
 *  person did wrong. Matches the error code where the client gives one
 *  (`mfa_totp_enroll_not_enabled`), and the message ("MFA enroll is disabled
 *  for TOTP") where it does not. This only decides what the profile OFFERS;
 *  it never loosens what the database requires (public.mfa_satisfied,
 *  require_mfa_policy). */
export function isSecondStepDisabled(e: unknown, type: "totp" | "phone"): boolean {
  const code = String((e as { code?: string })?.code ?? "");
  const msg = String((e as { message?: string })?.message ?? e ?? "");
  if (new RegExp(`^mfa_${type}_(enroll|verify)_not_enabled$`).test(code)) return true;
  const kind = type === "totp" ? "totp" : "(phone|sms)";
  return new RegExp(`(enroll|verif)\\w*\\s+is\\s+disabled\\s+for\\s+${kind}`, "i").test(msg);
}

/** What the profile says in place of the buttons Supabase has switched off. */
export function secondStepUnavailableNote(off: { totp: boolean; phone: boolean }): string {
  const parts: string[] = [];
  if (off.totp) parts.push(SECOND_STEP_UNAVAILABLE.totp);
  if (off.phone) parts.push(SECOND_STEP_UNAVAILABLE.phone);
  if (off.totp && off.phone) {
    parts.push(
      "Two-step sign-in can't be turned on until one of them is switched on. Your password still signs you in.",
    );
  }
  return parts.join(" ");
}

/** A sentence for an MFA error, never Supabase's raw text on its own. */
export function secondStepErrorMessage(e: unknown, type: "totp" | "phone" = "totp"): string {
  const msg = String((e as { message?: string })?.message ?? e ?? "");
  if (isSecondStepDisabled(e, type)) {
    return type === "totp"
      ? SECOND_STEP_UNAVAILABLE.totp
      : `${SECOND_STEP_UNAVAILABLE.phone} Use an authenticator app instead.`;
  }
  if (/invalid.*(totp|code)|code.*invalid|expired/i.test(msg)) {
    return "That code didn't work. Codes change every 30 seconds; enter the one showing now.";
  }
  if (type === "phone" && /(phone|sms).*(disabled|not enabled|provider)|mfa_phone/i.test(msg)) {
    return "Text-message codes aren't set up for HoundStack yet. Use an authenticator app instead.";
  }
  if (/rate|too many/i.test(msg)) return "Too many tries. Wait a minute and try again.";
  return msg || "Something went wrong. Try again.";
}

/** Where /two-step sends a person once the code is accepted: a path on this
 *  site, and never back to /two-step. Anything else goes to the dashboard. */
export function safeNextPath(next: string | undefined | null): string {
  if (!next || typeof next !== "string") return "/dashboard";
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/dashboard";
  if (next === "/two-step" || next.startsWith("/two-step?") || next.startsWith("/two-step/")) {
    return "/dashboard";
  }
  return next;
}
