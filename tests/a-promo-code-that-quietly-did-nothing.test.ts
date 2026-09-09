import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A code typed on Get-started is stored on the org and re-validated when the
// owner actually subscribes. If it no longer earns a discount, checkout is NOT
// blocked -- that is deliberate and stays: a dead code must never stand between
// somebody and paying us.
//
// What was wrong is that it was also SILENT. The owner reached the card form,
// was charged full price, and nothing on screen said the code had not applied.
// They find out on the first statement, or never.
//
// So the reason travels out with the result and is said before the card form.
// The reason matters as much as the fact: four of them are possible and the
// right next step differs, and one case that LOOKS like a drop is not one at
// all.

const FN = readFileSync(join(process.cwd(), "src/lib/billing.functions.ts"), "utf8");
const UI = readFileSync(join(process.cwd(), "src/components/billing/PlanPicker.tsx"), "utf8");

/** The promo block, comments stripped so prose cannot satisfy a check. */
function promoBlock(): string {
  const code = FN.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  const start = code.indexOf("let promoCoupon");
  expect(start, "the promo lookup is gone").toBeGreaterThan(-1);
  const end = code.indexOf("const clientSecretOf", start);
  expect(end).toBeGreaterThan(start);
  return code.slice(start, end);
}

describe("a dropped discount is reported, not swallowed", () => {
  const block = promoBlock();

  it("records why, not merely that", () => {
    expect(block).toMatch(/promoDropped = \{[^}]*reason: "invalid"/);
    expect(block).toMatch(/promoDropped = \{[^}]*reason: "not_in_stripe"/);
    expect(block).toMatch(/promoDropped = \{[^}]*reason: "wrong_plan"/);
    expect(block).toMatch(/promoDropped = \{[^}]*reason: "lookup_failed"/);
  });

  it("still does not block checkout on a dead code", () => {
    // The mutation this guards: "fixing" the silence by throwing. That puts a
    // failed coupon lookup between a customer and a purchase, which is a worse
    // outcome than the missing discount.
    expect(block).not.toMatch(/\bthrow\b/);
  });

  it("reports the lookup failing as unknown rather than as no code", () => {
    // The code IS on the org, so a throw means we could not tell whether it was
    // good. Saying "no code" there would be a third wrong answer.
    const cat = block.slice(block.indexOf("} catch"));
    expect(cat).toMatch(/reason: "lookup_failed"/);
  });

  it("carries the server's own sentence for an invalid code", () => {
    // lookupSignupCode already distinguishes expired / deactivated / fully
    // redeemed in words written for a person. Re-wording that into "not valid"
    // would throw away the only part the customer can act on.
    expect(block).toMatch(/detail: hit\.reason/);
  });
});

describe("a referral code is not a dropped discount", () => {
  it("is excluded explicitly, not by accident", () => {
    // lookupSignupCode resolves to coupon | referral | invalid. A referral
    // produces no coupon BY DESIGN -- the credit reaches the referrer another
    // way. Reporting it would invent a fault and send somebody to support over
    // a code that worked. This is the case a `kind !== "coupon"` test would
    // have got wrong, and the first version of this change did.
    const block = promoBlock();
    expect(block).toMatch(/hit\.kind === "referral"/);
    const referralArm = block.slice(
      block.indexOf('hit.kind === "referral"'),
      block.indexOf('hit.kind === "invalid"'),
    );
    expect(referralArm).not.toMatch(/promoDropped =/);
  });
});

describe("and it reaches the owner while they can still stop", () => {
  it("warns before the card form is mounted, not after the charge", () => {
    const onSuccess = UI.slice(UI.indexOf("onSuccess: async (r: any)"));
    const warn = onSuccess.indexOf("r.promoDropped");
    const mount = onSuccess.indexOf("setSession({");
    expect(warn).toBeGreaterThan(-1);
    expect(mount).toBeGreaterThan(-1);
    expect(warn).toBeLessThan(mount);
  });

  it("holds it on screen longer than a default toast", () => {
    const i = UI.indexOf("r.promoDropped");
    expect(UI.slice(i, i + 200)).toMatch(/duration:\s*15000/);
  });

  it("says a different thing for each reason", () => {
    // A single "your code did not apply" sends all four to support, including
    // wrong_plan, which the customer can fix by choosing another plan.
    const msg = UI.slice(UI.indexOf("function promoDropMessage"));
    const body = msg.slice(0, msg.indexOf("\n}\n"));
    for (const r of ["wrong_plan", "invalid", "not_in_stripe", "lookup_failed"]) {
      expect(body, `no message for ${r}`).toMatch(new RegExp(`case "${r}"`));
    }
    expect(body).toMatch(/may apply to a different plan/);
    expect(body).toMatch(/problem on our side/);
  });

  it("tells them not to just retype it", () => {
    // The instinct on "code did not apply" is to enter it again. On three of
    // the four reasons that wastes their time and ours.
    const msg = UI.slice(UI.indexOf("function promoDropMessage"));
    expect(msg.slice(0, msg.indexOf("\n}\n"))).toMatch(/rather than re-entering it/);
  });
});

// ── AND THE OTHER END OF THE SAME DEFECT ─────────────────────────────────
//
// Everything above is about a code that WAS stored and then earned nothing.
// The worse case is the code that was never stored at all: Get-started
// validates on blur and tells the person it is good, so a capture that then
// fails leaves them promised a discount with nothing on the org -- and
// createPlanSubscription cannot warn them, because an empty column reads the
// same as "never entered one".

const ORG = readFileSync(join(process.cwd(), "src/lib/org.functions.ts"), "utf8");
const SIGNUP = readFileSync(join(process.cwd(), "src/routes/get-started.tsx"), "utf8");

function captureBlock(): string {
  const code = ORG.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  const start = code.indexOf("let promoStored");
  expect(start, "the capture no longer reports whether it worked").toBeGreaterThan(-1);
  const end = code.indexOf("return { organizationId", start);
  expect(end).toBeGreaterThan(start);
  return code.slice(start, end);
}

describe("a code that was never stored says so at signup", () => {
  it("returns whether it was kept", () => {
    expect(ORG).toMatch(/return \{ organizationId: orgId as string, promoStored \}/);
  });

  it("distinguishes 'nothing to keep' from 'failed to keep it'", () => {
    // null vs false. Collapsing them to a boolean would warn every signup that
    // typed no code at all.
    const block = captureBlock();
    expect(block).toMatch(/let promoStored: boolean \| null = null/);
    expect(block).toMatch(/promoStored = false/);
    expect(block).toMatch(/promoStored = true/);
  });

  it("asks what is stored rather than reading zero rows as failure", () => {
    // The `.is(null)` guard makes the write idempotent, so a re-run against an
    // org that already carries a code updates nothing and that is CORRECT. A
    // check that treated zero rows as a failure would warn on the healthy path.
    const block = captureBlock();
    const elseArm = block.slice(block.indexOf("} else {"));
    expect(elseArm).toMatch(/\.select\("signup_promo_code"\)/);
    expect(elseArm).toMatch(/promoStored = !!row\?\.signup_promo_code/);
  });

  it("still does not block signup", () => {
    // Losing a discount is not worth losing a customer. The account is created
    // either way; only the telling is new.
    expect(captureBlock()).not.toMatch(/\bthrow\b/);
  });
});

describe("and the signup screen is the last place that can say it", () => {
  it("warns on false and stays quiet on null", () => {
    // `=== false` and not a truthiness check: null is the ordinary case of
    // somebody who typed no promo code, and warning them would be nonsense.
    expect(SIGNUP).toMatch(/boot\?\.promoStored === false/);
  });

  it("says the account is fine, so the warning does not read as a failed signup", () => {
    const i = SIGNUP.indexOf("boot?.promoStored === false");
    const block = SIGNUP.slice(i, i + 600);
    expect(block).toMatch(/Your account is set up/);
    expect(block).toMatch(/Contact us before you subscribe/);
    expect(block).toMatch(/duration:\s*15000/);
  });
});
