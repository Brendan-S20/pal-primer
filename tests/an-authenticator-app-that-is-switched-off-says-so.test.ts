// gaps-r2-13: with TOTP switched off for the Supabase project, "Use an
// authenticator app" printed the server's own words, "MFA enroll is disabled
// for TOTP", under the buttons. Now the card recognises that refusal as a
// SETTING: it hides the button and says in plain words that authenticator
// apps aren't available. Copy and availability only; the database's two-step
// rule (mfa_satisfied / require_mfa_policy) is untouched.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import {
  SECOND_STEP_UNAVAILABLE,
  isSecondStepDisabled,
  secondStepErrorMessage,
  secondStepUnavailableNote,
} from "@/lib/mfa";

const totpOff = {
  name: "AuthApiError",
  message: "MFA enroll is disabled for TOTP",
  code: "mfa_totp_enroll_not_enabled",
};
const totpOffNoCode = { message: "MFA enroll is disabled for TOTP" };
const phoneOff = {
  message: "MFA enroll is disabled for Phone",
  code: "mfa_phone_enroll_not_enabled",
};

describe("a second step the project has switched off", () => {
  it("is recognised by code or by message, and only for its own kind", () => {
    expect(isSecondStepDisabled(totpOff, "totp")).toBe(true);
    expect(isSecondStepDisabled(totpOffNoCode, "totp")).toBe(true);
    expect(isSecondStepDisabled({ code: "mfa_totp_verify_not_enabled" }, "totp")).toBe(true);
    expect(isSecondStepDisabled(phoneOff, "phone")).toBe(true);
    expect(isSecondStepDisabled(totpOff, "phone")).toBe(false);
    expect(isSecondStepDisabled(phoneOff, "totp")).toBe(false);
    expect(isSecondStepDisabled({ message: "Invalid TOTP code entered" }, "totp")).toBe(false);
  });

  it("never reaches the screen as the raw server string", () => {
    for (const e of [totpOff, totpOffNoCode]) {
      const said = secondStepErrorMessage(e, "totp");
      expect(said).toBe(SECOND_STEP_UNAVAILABLE.totp);
      expect(said).not.toMatch(/MFA enroll|disabled for TOTP/i);
    }
    const phone = secondStepErrorMessage(phoneOff, "phone");
    expect(phone).toMatch(/^Text-message codes aren't set up for HoundStack yet\./);
    expect(phone).not.toMatch(/MFA enroll/i);
  });

  it("other errors keep their own sentences", () => {
    expect(secondStepErrorMessage({ message: "Invalid TOTP code entered" })).toMatch(
      /That code didn't work/,
    );
    expect(secondStepErrorMessage({ message: "Too many requests" })).toMatch(/Too many tries/);
  });

  it("the card's note names what is off, and says so when nothing is left", () => {
    expect(secondStepUnavailableNote({ totp: false, phone: false })).toBe("");
    expect(secondStepUnavailableNote({ totp: true, phone: false })).toBe(
      "Authenticator apps aren't available for HoundStack yet.",
    );
    const both = secondStepUnavailableNote({ totp: true, phone: true });
    expect(both).toMatch(/Authenticator apps aren't available/);
    expect(both).toMatch(/Text-message codes aren't set up/);
    expect(both).toMatch(/can't be turned on/);
  });

  it("TwoStepCard hides the button it learned is off instead of printing the error", () => {
    const src = readFileSync(
      path.resolve(import.meta.dirname, "../src/components/TwoStepCard.tsx"),
      "utf8",
    );
    expect(src).toMatch(/isSecondStepDisabled\(e,\s*"totp"\)[\s\S]{0,120}setUnavailable/);
    expect(src).toMatch(/isSecondStepDisabled\(e,\s*"phone"\)[\s\S]{0,120}setUnavailable/);
    expect(src).toMatch(/!unavailable\.totp && !factors\.some\(\(f\) => f\.type === "totp"\)/);
    expect(src).toMatch(/!unavailable\.phone && !factors\.some\(\(f\) => f\.type === "phone"\)/);
    expect(src).toMatch(/secondStepUnavailableNote\(unavailable\)/);
  });
});
