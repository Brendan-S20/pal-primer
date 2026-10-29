// The consent a business's client gives (portal, booking link, office) is
// built by clientSmsConsentText in src/lib/client-sms-consent.ts. That is a
// different program from the one Twilio reviewed for HoundStack's own number
// (texts from HoundStack to an account holder), so its sender and topics are
// its own: since #538 it names the business and carries that business's own
// Terms and Privacy. The disclosures it shares with the reviewed wording in
// src/components/SmsOptInFields.tsx (shown on /legal/sms-opt-in) are not: they
// have to be the reviewed sentences word for word, because two phrasings of
// the same disclosure is the drift a reviewer reads as two programs.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clientSmsConsentText, clientSmsConsentWording } from "@/lib/client-sms-consent";

const root = join(__dirname, "..");
const optInFields = readFileSync(join(root, "src/components/SmsOptInFields.tsx"), "utf8");

const AGREED =
  "I agree to receive text messages from Detroit Doo Disposal at the number provided about my " +
  "appointments, visit updates and billing. Consent is optional and is not a condition of " +
  "purchase. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out, " +
  "HELP for help.";

const SHARED_DISCLOSURES = [
  "Consent is optional and is not a condition of purchase.",
  "Message frequency varies.",
  "Msg & data rates may apply.",
  "Reply STOP to opt out, HELP for help.",
];

/** The reviewed string at runtime, from its concatenated template literals. */
function reviewedConsentText(): string {
  const decl = /export const SMS_CONSENT_TEXT =\n(.*?);\n/s.exec(optInFields);
  expect(decl, "SMS_CONSENT_TEXT declaration in SmsOptInFields.tsx").not.toBeNull();
  const pieces = [...decl![1].matchAll(/`([^`]*)`/g)].map((m) => m[1]);
  expect(pieces.length, "template literal pieces").toBeGreaterThan(0);
  return pieces.join("").replaceAll("${APP_NAME}", "HoundStack").replace(/\s+/g, " ").trim();
}

describe("the client consent uses the reviewed disclosures", () => {
  it("names the business, in exactly the agreed wording", () => {
    expect(clientSmsConsentText({ businessName: "Detroit Doo Disposal" })).toBe(AGREED);
  });

  it("carries the business's own Terms and Privacy when it has filed them", () => {
    const text = clientSmsConsentText({
      businessName: "Detroit Doo Disposal",
      termsUrl: "https://detroitdoo.com/terms",
      privacyUrl: "https://detroitdoo.com/privacy",
    });
    expect(text.startsWith(AGREED)).toBe(true);
    expect(text).toContain("Detroit Doo Disposal Terms: https://detroitdoo.com/terms");
    expect(text).toContain("Privacy Policy: https://detroitdoo.com/privacy");
    // Never HoundStack's: the client is agreeing to the business's texts.
    expect(text).not.toMatch(/houndstack/i);
  });

  it("the shown wording and the stored wording are one string", () => {
    const w = clientSmsConsentWording({
      businessName: "Detroit Doo Disposal",
      termsUrl: "https://detroitdoo.com/terms",
      privacyUrl: "https://detroitdoo.com/privacy",
    });
    expect(w.text.startsWith(w.lead)).toBe(true);
  });

  it.each(SHARED_DISCLOSURES)("both consent texts say %j", (sentence) => {
    expect(clientSmsConsentText({ businessName: "Acme" }), "client consent").toContain(sentence);
    expect(reviewedConsentText(), "reviewed SMS_CONSENT_TEXT").toContain(sentence);
  });
});
