// The client portal account page shows SMS_CONSENT_TEXT from
// src/lib/clients.functions.ts. That is a different program from the one
// Twilio reviewed (texts from a business to its own client, not from
// HoundStack to an account holder), so its sender and topics are its own. The
// disclosures it shares with the reviewed wording in
// src/components/SmsOptInFields.tsx (shown on /legal/sms-opt-in) are not: they
// have to be the reviewed sentences word for word, because two phrasings of
// the same disclosure is the drift a reviewer reads as two programs.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const clientsFunctions = readFileSync(join(root, "src/lib/clients.functions.ts"), "utf8");
const optInFields = readFileSync(join(root, "src/components/SmsOptInFields.tsx"), "utf8");

const PORTAL_TEXT =
  "I agree to receive text messages from this business at the number provided about my " +
  "appointments, visit updates and billing. Consent is optional and is not a condition of " +
  "purchase. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out, " +
  "HELP for help.";

const SHARED_DISCLOSURES = [
  "Consent is optional and is not a condition of purchase.",
  "Message frequency varies.",
  "Msg & data rates may apply.",
  "Reply STOP to opt out, HELP for help.",
];

/** The body of `export const SMS_CONSENT_TEXT = ...;` in a source file. */
function declaration(src: string, file: string): string {
  const decl = /export const SMS_CONSENT_TEXT =\n(.*?);\n/s.exec(src);
  expect(decl, `SMS_CONSENT_TEXT declaration in ${file}`).not.toBeNull();
  return decl![1];
}

/** The portal string at runtime, from its concatenated double-quoted literals. */
function portalConsentText(): string {
  const body = declaration(clientsFunctions, "src/lib/clients.functions.ts");
  const pieces = [...body.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  expect(pieces.length, "string literal pieces").toBeGreaterThan(0);
  return pieces.join("");
}

/** The reviewed string at runtime, from its concatenated template literals. */
function reviewedConsentText(): string {
  const body = declaration(optInFields, "src/components/SmsOptInFields.tsx");
  const pieces = [...body.matchAll(/`([^`]*)`/g)].map((m) => m[1]);
  expect(pieces.length, "template literal pieces").toBeGreaterThan(0);
  return pieces.join("").replaceAll("${APP_NAME}", "HoundStack").replace(/\s+/g, " ").trim();
}

describe("the portal consent uses the reviewed disclosures", () => {
  it("the portal text is exactly the agreed wording", () => {
    expect(portalConsentText()).toBe(PORTAL_TEXT);
  });

  it.each(SHARED_DISCLOSURES)("both consent texts say %j", (sentence) => {
    expect(portalConsentText(), "portal SMS_CONSENT_TEXT").toContain(sentence);
    expect(reviewedConsentText(), "reviewed SMS_CONSENT_TEXT").toContain(sentence);
  });
});
