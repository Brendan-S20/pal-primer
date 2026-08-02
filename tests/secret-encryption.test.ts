import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ENCRYPTION_KEY_ENV,
  MissingEncryptionKeyError,
  decryptSecret,
  encryptSecret,
  isEncrypted,
  loadEncryptionKey,
  secretLast4,
} from "@/lib/secret-encryption.server";

// IMP-1 — credentials a tenant entrusts to us (BYO AI keys, Twilio auth tokens,
// accounting OAuth tokens) were stored as plaintext. RLS kept them out of
// tenant queries, but RLS is access control, not storage: a dump, a backup, a
// replica, or any service-role bug reads plaintext straight out.

const keyEnv = (key = randomBytes(32)) => ({ [ENCRYPTION_KEY_ENV]: key.toString("base64") });
const SECRET = "sk-ant-api03-ExampleKeyMaterial-not-a-real-key-4f2a";

describe("secret encryption (IMP-1)", () => {
  it("round-trips a secret", () => {
    const env = keyEnv();
    const stored = encryptSecret(SECRET, env);
    expect(decryptSecret(stored, env)).toBe(SECRET);
  });

  it("never stores the plaintext, in whole or in part", () => {
    const stored = encryptSecret(SECRET, keyEnv());
    expect(stored).not.toContain(SECRET);
    // The tail is what gets rendered as a hint; it must not leak from the blob.
    expect(stored).not.toContain("4f2a");
    expect(isEncrypted(stored)).toBe(true);
  });

  it("produces a different ciphertext every time (fresh IV)", () => {
    const env = keyEnv();
    const a = encryptSecret(SECRET, env);
    const b = encryptSecret(SECRET, env);
    // Deterministic ciphertext would let anyone with read access tell that two
    // tenants configured the same key.
    expect(a).not.toBe(b);
    expect(decryptSecret(a, env)).toBe(decryptSecret(b, env));
  });

  it("refuses to decrypt with the wrong key rather than returning garbage", () => {
    const stored = encryptSecret(SECRET, keyEnv());
    expect(() => decryptSecret(stored, keyEnv())).toThrow();
  });

  it("detects tampering — the reason for GCM over CBC", () => {
    const env = keyEnv();
    const stored = encryptSecret(SECRET, env);
    const [v, iv, tag, ct] = stored.split(".");
    // Flip a byte of ciphertext, leaving the envelope shape intact.
    const bytes = Buffer.from(ct, "base64url");
    bytes[0] ^= 0xff;
    const tampered = [v, iv, tag, bytes.toString("base64url")].join(".");
    expect(() => decryptSecret(tampered, env)).toThrow();
  });

  it("REFUSES to write when no key is configured — never silently plaintext", () => {
    // The failure mode that would defeat the entire item: storing plaintext
    // because the env var was forgotten, and nobody noticing.
    expect(() => encryptSecret(SECRET, {})).toThrow(MissingEncryptionKeyError);
  });

  it("rejects a key that is not exactly 32 bytes", () => {
    // A short key still "works" in the sense that it produces ciphertext, which
    // is exactly why this has to be loud.
    expect(() =>
      loadEncryptionKey({ [ENCRYPTION_KEY_ENV]: randomBytes(16).toString("base64") }),
    ).toThrow(/32 bytes/);
    expect(loadEncryptionKey({})).toBeNull();
  });

  it("passes legacy plaintext through, so deploying and rolling back are safe", () => {
    const legacy = "sk-plaintext-written-before-this-shipped";
    expect(isEncrypted(legacy)).toBe(false);
    // Readable with or without a key configured — a pre-existing row keeps
    // working either way.
    expect(decryptSecret(legacy, keyEnv())).toBe(legacy);
    expect(decryptSecret(legacy, {})).toBe(legacy);
  });

  it("cannot read an encrypted value without the key", () => {
    const stored = encryptSecret(SECRET, keyEnv());
    expect(() => decryptSecret(stored, {})).toThrow(MissingEncryptionKeyError);
  });

  it("derives the display hint from the plaintext at write time", () => {
    expect(secretLast4(SECRET)).toBe("4f2a");
    expect(secretLast4("abc")).toBeNull();
  });

  it("handles a malformed envelope without leaking or hanging", () => {
    expect(() => decryptSecret("v1.only.three", keyEnv())).toThrow(/malformed/);
  });
});
