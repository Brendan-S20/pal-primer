// #772 and #776, three owner-facing promises on the way through setup.
//
//   * "Continue setup" opened /setup?step=zones for an owner whose zones step
//     was already done: startingStep() returned the REMEMBERED step even when
//     the server said it was finished. The dashboard checklist's "Guide me"
//     and /setup with no step in the URL both resumed through it.
//   * "Price walks" looked like a save button and was a link to Settings.
//     Since #769 walks are priced by a form on /setup; this pins that the
//     setup page never turns the walks part back into a link.
//   * Step 6 told the owner to "open the link we sent when you signed up",
//     and signup never said a link was sent.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { setupBanner, startingStep } from "../src/lib/setup-guide";
import { SETUP_VERIFY_EMAIL_FIRST, signupVerifyNotice } from "@/lib/verify-email-copy";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const ZONES_DONE = [
  { id: "business", done: true, label: "Business" },
  { id: "zones", done: true, label: "Prices" },
  { id: "clients", done: false, label: "Add a client" },
  { id: "staff", done: false, label: "Team" },
] as const;

describe("Continue setup (#772)", () => {
  it("skips a remembered step that is already done", () => {
    expect(startingStep(ZONES_DONE, "zones")).toBe("clients");
    expect(startingStep(ZONES_DONE, "business")).toBe("clients");
  });

  it("still resumes a remembered step that is open", () => {
    expect(startingStep(ZONES_DONE, "staff")).toBe("staff");
  });

  it("opens the first step when every step is done", () => {
    const all = ZONES_DONE.map((s) => ({ ...s, done: true }));
    expect(startingStep(all, "zones")).toBe("business");
  });

  it("the banner's button never points at the finished zones step", () => {
    const b = setupBanner(ZONES_DONE, "zones");
    expect(b.step).toBe("clients");
    expect(b.nextLabel).toBe("Add a client");
  });

  it("the checklist and /setup resume through the same resolver", () => {
    expect(read("src/components/OnboardingChecklist.tsx")).toMatch(
      /startingStep\(steps, readRememberedStep\(guide\.userId\)\)/,
    );
    expect(read("src/routes/_authenticated/setup.tsx")).toMatch(
      /stepParam \?\? startingStep\(steps, readRememberedStep\(guide\.userId\)\)/,
    );
  });
});

describe("Price walks (#772)", () => {
  it("the setup page draws the walk price form for the walks part, not a link", () => {
    const src = read("src/routes/_authenticated/setup.tsx");
    expect(src).toMatch(/part\.id !== "area" && part\.id !== "walks" && \(/);
    expect(src).toMatch(/data-setup-price-form="walks"/);
  });
});

describe("Verify your email (#776)", () => {
  it("step 6 does not claim a link was sent at signup", () => {
    const src = read("src/routes/_authenticated/setup.tsx");
    expect(src).not.toMatch(/we sent when you signed up/);
    expect(SETUP_VERIFY_EMAIL_FIRST).not.toMatch(/signed up|we sent/i);
  });

  it("step 6 leads with the existing resend action, before Set up payouts", () => {
    const src = read("src/routes/_authenticated/setup.tsx");
    const panel = src.slice(src.indexOf("function PayoutsPanel"));
    expect(panel).toMatch(/SETUP_VERIFY_EMAIL_FIRST/);
    expect(panel).toMatch(/<ResendVerificationButton/);
    // The same server function Payments uses: no new send path.
    expect(read("src/components/ResendVerificationButton.tsx")).toMatch(
      /from "@\/lib\/auth-entry\.functions"/,
    );
    expect(read("src/routes/_authenticated/payments.tsx")).toMatch(/<ResendVerificationButton/);
  });

  it("signup says what happened to the verify link", () => {
    expect(signupVerifyNotice("a@b.co", true)).toMatch(/We sent a link to a@b\.co/);
    expect(signupVerifyNotice("a@b.co", false)).toMatch(/could not send/);
    expect(signupVerifyNotice("a@b.co", false)).not.toMatch(/We sent/);
    for (const s of [signupVerifyNotice("a@b.co", true), signupVerifyNotice("a@b.co", false)]) {
      expect(s).not.toMatch(/—/);
    }
    // How get-started wires it is pinned in
    // the-verify-notice-waits-for-the-send-it-describes.test.ts.
  });
});
