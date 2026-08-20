// Twilio rejected the toll-free verification: 30475, "Cannot combine messaging
// consent with service requirement".
//
// ── WHAT WAS ACTUALLY WRONG ───────────────────────────────────────────────
//
// Not the checkbox. That was already unticked by default, already optional in
// code (`if (smsConsent && phone.trim())`), and the send paths were already
// gated in SQL by `client_may_be_texted`. Three other things said the opposite:
//
//   1. The signup wizard's last step was named "Texting". A mandatory
//      three-step flow whose final stage is the opt-in tells a reviewer that
//      messaging is part of enrolling, whatever the box underneath says.
//
//   2. The consent sentence promised "login codes". Business users never
//      receive an SMS login code — org auth is email/password plus EMAIL otp,
//      and the only SMS send path in this repo is `sendSmsToClient`, which
//      texts a TENANT'S OWN CUSTOMERS. So the sentence promised messages that
//      are never sent, and told the person ticking it that agreeing to texts
//      was how they would get into their account. That is messaging consent as
//      a condition of using the service, stated in the consent record itself.
//
//   3. `/legal/sms` quoted the old sentence. Twilio asks that the submitted
//      opt-in workflow match the live customer journey, so the public evidence
//      page and the stored consent record have to be the same words.
//
// ── WHY A TEST AND NOT JUST CARE ──────────────────────────────────────────
//
// (3) is a two-copy problem, and two copies of a sentence drift. The page and
// the constant were already out of step before anyone looked. The comparison
// below reconstructs the runtime string from the template literal and the
// rendered quote from the JSX and requires them to be identical, so the next
// person to reword one is told about the other.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const getStarted = readFileSync(join(root, "src/routes/get-started.tsx"), "utf8");
const legalSms = readFileSync(join(root, "src/routes/legal.sms.tsx"), "utf8");
const legalTerms = readFileSync(join(root, "src/routes/legal.terms.tsx"), "utf8");
const legalPrivacy = readFileSync(join(root, "src/routes/legal.privacy.tsx"), "utf8");

/** The consent string as it exists at runtime, from the template literal. */
function storedConsentText(): string {
  const decl = /export const SMS_CONSENT_TEXT =\n(.*?);\n/s.exec(getStarted);
  expect(decl, "SMS_CONSENT_TEXT declaration").not.toBeNull();
  const pieces = [...decl![1].matchAll(/`([^`]*)`/g)].map((m) => m[1]);
  expect(pieces.length, "template literal pieces").toBeGreaterThan(0);
  return pieces.join("").replaceAll("${APP_NAME}", "HoundStack").replace(/\s+/g, " ").trim();
}

/** The same sentence as the public policy page renders it. */
function publishedConsentText(): string {
  const quote = /<p className="rounded-md border bg-muted\/40 p-3 text-sm">\s*(.*?)\s*<\/p>/s.exec(
    legalSms,
  );
  expect(quote, "quoted consent block on /legal/sms").not.toBeNull();
  return quote![1]
    .replaceAll("{APP_NAME}", "HoundStack")
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^"|"$/g, "");
}

describe("messaging consent cannot be a condition of service", () => {
  it("does not promise login codes, which are never sent to a business user", () => {
    // The regression that mattered. Org auth is email/password + email OTP;
    // the only SMS send path is sendSmsToClient, to a tenant's customers.
    expect(storedConsentText()).not.toMatch(/login code/i);
    expect(legalSms).not.toMatch(/text you login codes/i);
  });

  it("says in the stored record itself that consent is optional", () => {
    // Not only in the UI around it: the stored text is what a carrier reads
    // back months later, when the page has moved on.
    const t = storedConsentText();
    expect(t).toMatch(/not a condition of purchase/i);
    expect(t).toMatch(/optional/i);
  });

  it("carries the rest of the express-consent elements a carrier looks for", () => {
    const t = storedConsentText();
    expect(t).toMatch(/message frequency varies/i);
    expect(t).toMatch(/message & data rates may apply/i);
    expect(t).toMatch(/reply STOP to opt out/i);
    expect(t).toMatch(/HELP/);
  });

  it("publishes exactly the sentence it stores", () => {
    expect(publishedConsentText()).toBe(storedConsentText());
  });

  it("does not name a signup step after the opt-in", () => {
    // A required stage called "Texting" makes messaging look like enrollment.
    const steps = /const STEPS = \[(.*?)\] as const;/s.exec(getStarted);
    expect(steps, "STEPS declaration").not.toBeNull();
    expect(steps![1]).not.toMatch(/text/i);
    expect(steps![1]).not.toMatch(/sms/i);
  });

  it("keeps the checkbox unticked by default", () => {
    expect(getStarted).toMatch(/const \[smsConsent, setSmsConsent\] = useState\(false\)/);
  });

  it("only records consent when the box was actually ticked", () => {
    // The opt-in must not ride along with account creation.
    expect(getStarted).toMatch(/if \(smsConsent && phone\.trim\(\)\)/);
  });

  // ── Twilio's SECOND rejection: "Consent for Messaging Cannot Be Part of
  // Other Agreements" ────────────────────────────────────────────────────
  //
  // The first round fixed the signup flow. This one is about the paperwork
  // around it: the Terms are accepted implicitly ("By creating an account or
  // using the service you agree to them"), so unless each agreement says out
  // loud that it does NOT carry messaging consent, a reviewer reads the
  // blanket acceptance as the vehicle for it. Nothing in the app was
  // collecting consent that way — but nothing said it wasn't, and the reviewer
  // only has the documents.
  it("says in the Terms that accepting them is not messaging consent", () => {
    expect(legalTerms).toMatch(/do not give consent to receive text messages/i);
    expect(legalTerms).toMatch(/legal\/sms/);
  });

  it("says the same in the Privacy Policy", () => {
    expect(legalPrivacy).toMatch(/does not give consent to receive text messages/i);
  });

  it("names every other agreement on the SMS policy, so the carve-out is not vague", () => {
    const s = legalSms;
    expect(s).toMatch(/Consent is separate from every other agreement/i);
    expect(s).toMatch(/legal\/terms/);
    expect(s).toMatch(/legal\/privacy/);
    // Creating an account / paying / using the service, spelled out.
    expect(s).toMatch(/Creating an account[\s\S]{0,160}does not give consent/i);
  });

  it("promises withdrawal costs the customer nothing, in all three documents", () => {
    // "Not a condition" has to hold going forward too, or consent is coerced
    // by the cost of revoking it.
    expect(legalSms).toMatch(/withdrawing consent later, changes nothing/i);
    expect(legalTerms).toMatch(/withdrawing it changes nothing/i);
    expect(legalPrivacy).toMatch(/without any effect on your account/i);
  });

  it("every opt-in screenshot the policy links actually exists", () => {
    // These URLs are what goes in Twilio's `optInImageUrls`. A rename that 404s
    // one of them breaks a live verification submission, silently, and the
    // failure surfaces as a rejection weeks later rather than as a broken link.
    const linked = [...legalSms.matchAll(/\/sms-opt-in\/[a-z0-9-]+\.png/g)].map((m) => m[0]);
    expect(linked.length, "screenshots linked from /legal/sms").toBeGreaterThanOrEqual(8);
    const missing = linked.filter((u) => !existsSync(join(root, "public", u)));
    expect(missing, `linked but not in public/: ${missing.join(", ")}`).toEqual([]);
  });
});
