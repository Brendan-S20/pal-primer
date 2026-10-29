// The words a business's client agrees to before that business may text them
// (#538). One builder for every place consent is asked: the client portal,
// the public booking link, and the office recording a verbal yes. Each stores
// the exact string it showed (record_client_sms_consent), so the wording names
// the business and carries the business's own Terms and Privacy links in the
// stored text itself: the stored text is what a carrier reads back months
// later.
//
// This is a different program from the one HoundStack filed for its own
// toll-free number (SMS_CONSENT_TEXT in components/SmsOptInFields, account
// holders only). The disclosures it shares with that one are the reviewed
// sentences, word for word (tests/the-portal-consent-uses-the-reviewed-disclosures).

export const CLIENT_SMS_DISCLOSURES =
  "Consent is optional and is not a condition of purchase. Message frequency varies. " +
  "Msg & data rates may apply. Reply STOP to opt out, HELP for help.";

export type ClientSmsConsentWording = {
  /** The business's own name, as its texts are signed. */
  businessName: string;
  /** That business's Terms and Privacy pages, from its texting registration.
   *  Null until the owner has filed them in Settings → Texting. */
  termsUrl: string | null;
  privacyUrl: string | null;
  /** The name as the sentence uses it ("this business" when unknown). */
  displayName: string;
  /** The agreement without the links, for a screen that draws them as links. */
  lead: string;
  /** The full sentence, links included: what is shown and what is stored. */
  text: string;
};

export function clientSmsConsentText(p: {
  businessName: string;
  termsUrl?: string | null;
  privacyUrl?: string | null;
}): string {
  const name = p.businessName.trim() || "this business";
  const base = consentLead(name);
  const links: string[] = [];
  if (p.termsUrl) links.push(`Terms: ${p.termsUrl}`);
  if (p.privacyUrl) links.push(`Privacy Policy: ${p.privacyUrl}`);
  // No punctuation straight after a URL, so a reader copying it gets the URL.
  return links.length ? `${base} ${name} ${links.join(" ")}` : base;
}

function consentLead(name: string): string {
  return (
    `I agree to receive text messages from ${name} at the number provided about my ` +
    `appointments, visit updates and billing. ${CLIENT_SMS_DISCLOSURES}`
  );
}

export function clientSmsConsentWording(p: {
  businessName: string;
  termsUrl?: string | null;
  privacyUrl?: string | null;
}): ClientSmsConsentWording {
  const displayName = p.businessName.trim() || "this business";
  return {
    businessName: p.businessName.trim(),
    displayName,
    lead: consentLead(displayName),
    termsUrl: p.termsUrl ?? null,
    privacyUrl: p.privacyUrl ?? null,
    text: clientSmsConsentText(p),
  };
}

/** The confirmation a client is texted once consent is recorded, when the
 *  business can already text. Names the business, says what to expect and
 *  how to stop. Also filed with Twilio as the opt-in confirmation sample. */
export function optInConfirmationText(businessName: string): string {
  const name = businessName.trim() || "This business";
  return (
    `${name}: You're subscribed to appointment, visit and billing texts. ` +
    `Message frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.`
  );
}
