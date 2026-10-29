// Every text to a business's client starts with that business's name (#538):
// carriers want the sender identified in each message, and a client with
// several services on one phone has to know which business is writing.
// Pure, so every sender can brand the body it logs, and `sendTwilioSms`
// applies it again to anything sent from a subaccount.

/**
 * A text to a business's client, starting with that business's name. A body
 * that already starts with the name (any case) is returned unchanged, so a
 * template that names the business first is not named twice.
 */
export function brandedBody(brand: string | null | undefined, body: string): string {
  const name = (brand ?? "").trim();
  const text = body.trim();
  if (!name) return text;
  if (text.toLowerCase().startsWith(name.toLowerCase())) return text;
  return `${name}: ${text}`;
}
