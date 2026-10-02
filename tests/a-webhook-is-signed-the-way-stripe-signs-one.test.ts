// A webhook is signed the way Stripe signs one.
//
//   HoundStack-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">
//
// keyed with the whole `whsec_...` secret. The expected values below were not
// produced by the code under test: they came from openssl, on the command
// line, from the same inputs —
//
//   printf '%s' '1759132800.{"id":"evt_1","type":"visit.completed"}' \
//     | openssl dgst -sha256 -hmac 'whsec_test_secret_0123456789' -hex
//
// — so a change to what is MAC'd (dropping the timestamp, a different
// separator, the secret without its prefix, base64 instead of hex) fails here
// rather than agreeing with itself.

import { describe, expect, it } from "vitest";
import {
  generateWebhookSecret,
  signWebhookPayload,
  verifyWebhookSignature,
} from "@/lib/webhook-delivery.server";
import { WEBHOOK_SIGNATURE_HEADER } from "@/lib/webhooks";

const SECRET = "whsec_test_secret_0123456789";
const T = 1759132800;
const BODY = '{"id":"evt_1","type":"visit.completed"}';
const OPENSSL = "2d0ca1177adca9abefc1d75a495e252a0d47c63610252f76eac8401c6840304d";

describe("the signature header", () => {
  it("is t=<timestamp>,v1=<hex HMAC-SHA256 of timestamp.body>, matching openssl", () => {
    expect(signWebhookPayload(SECRET, T, BODY)).toBe(`t=${T},v1=${OPENSSL}`);
  });

  it("covers every byte of the body", () => {
    // One trailing space, and openssl's answer for that body is different.
    expect(signWebhookPayload(SECRET, T, BODY + " ")).toBe(
      `t=${T},v1=43a22f04708d53703a64ded862811fe766803c7f4b68f11c45881fabe11e43d2`,
    );
  });

  it("covers the timestamp, so an old request cannot be replayed with a new one", () => {
    expect(signWebhookPayload(SECRET, T + 1, BODY)).not.toContain(OPENSSL);
  });

  it("is sent under the header name the help text documents", () => {
    expect(WEBHOOK_SIGNATURE_HEADER).toBe("HoundStack-Signature");
  });
});

describe("what a receiver does with it", () => {
  const now = new Date(T * 1000);

  it("accepts the header it was sent", () => {
    const header = signWebhookPayload(SECRET, T, BODY);
    expect(verifyWebhookSignature(SECRET, header, BODY, { now })).toBe(true);
  });

  it("refuses a different body, a different secret, or a forged v1", () => {
    const header = signWebhookPayload(SECRET, T, BODY);
    expect(verifyWebhookSignature(SECRET, header, BODY.replace("evt_1", "evt_2"), { now })).toBe(
      false,
    );
    expect(verifyWebhookSignature("whsec_other", header, BODY, { now })).toBe(false);
    expect(verifyWebhookSignature(SECRET, `t=${T},v1=${"0".repeat(64)}`, BODY, { now })).toBe(
      false,
    );
  });

  it("refuses a timestamp more than five minutes from now", () => {
    const header = signWebhookPayload(SECRET, T, BODY);
    expect(verifyWebhookSignature(SECRET, header, BODY, { now: new Date((T + 301) * 1000) })).toBe(
      false,
    );
    expect(verifyWebhookSignature(SECRET, header, BODY, { now: new Date((T + 299) * 1000) })).toBe(
      true,
    );
  });
});

describe("the secret", () => {
  it("is whsec_ and 32 random bytes, different every time", () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });
});
