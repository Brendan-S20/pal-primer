// Validate an inbound Twilio webhook's X-Twilio-Signature using a specific
// account's Auth Token. Twilio signs: the exact request URL (including query
// string) followed by each POST param appended in key-sorted order as
// key+value (no separators), HMAC-SHA1 with the Auth Token, base64.
// https://www.twilio.com/docs/usage/security#validating-requests
import crypto from "node:crypto";

export function twilioSignatureIsValid(
  url: string,
  params: Record<string, string>,
  authToken: string,
  signature: string | null | undefined,
): boolean {
  if (!signature) return false;
  let data = url;
  for (const key of Object.keys(params).sort()) {
    data += key + params[key];
  }
  const expected = crypto.createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
