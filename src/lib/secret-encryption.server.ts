// IMP-1: encryption at rest for third-party credentials the tenant entrusts to
// us — BYO AI keys, Twilio auth tokens, and accounting OAuth tokens.
//
// These columns were plaintext `text`. RLS kept them away from tenant queries,
// but RLS is an access-control mechanism, not a storage one: a database dump, a
// stray backup, a read-replica, a support engineer with console access, or any
// service-role bug reads them straight out. A tenant's Twilio auth token is
// their money and their phone number; a QuickBooks OAuth token is their books.
//
// Application-layer AES-256-GCM rather than pgsodium or Supabase Vault, and the
// reason is the threat we actually care about: with Vault the DATABASE can
// decrypt, so anything that compromises the database compromises the secrets.
// Here the key lives only in the app's environment, so the database holds
// ciphertext it has no way to read. These values are never filtered, joined, or
// sorted on — they are fetched by server code and handed to an external API —
// so we give up nothing by making them opaque to SQL.
//
// GCM (not CBC) because it authenticates: a tampered ciphertext fails to
// decrypt rather than silently yielding altered bytes.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** Bumped if the scheme ever changes, so stored values stay self-describing
 *  and a future reader knows how to handle what it finds. */
const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96 bits, the GCM standard
const KEY_BYTES = 32; // AES-256

export const ENCRYPTION_KEY_ENV = "CREDENTIAL_ENCRYPTION_KEY";

export class MissingEncryptionKeyError extends Error {
  constructor(action: string) {
    super(
      `${ENCRYPTION_KEY_ENV} is not set, so ${action} is refused. ` +
        `Generate one with: openssl rand -base64 32`,
    );
    this.name = "MissingEncryptionKeyError";
  }
}

/** Reads and validates the key. Returns null when unset so READ paths can still
 *  serve legacy plaintext; write paths turn null into a hard failure. */
export function loadEncryptionKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = env[ENCRYPTION_KEY_ENV];
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    // Loud, not silent: a short key would still "work" and produce ciphertext
    // that is far weaker than it looks.
    throw new Error(
      `${ENCRYPTION_KEY_ENV} must decode to exactly ${KEY_BYTES} bytes (got ${key.length}). ` +
        `Generate one with: openssl rand -base64 32`,
    );
  }
  return key;
}

/** True when a stored value is in our envelope format rather than legacy
 *  plaintext. Cheap prefix check — never attempts decryption. */
export function isEncrypted(stored: string | null | undefined): boolean {
  return typeof stored === "string" && stored.startsWith(`${VERSION}.`);
}

/**
 * Encrypt a secret for storage. Throws when no key is configured — a write
 * path must NEVER quietly fall back to storing plaintext, because the failure
 * would be invisible and the whole point would be lost.
 */
export function encryptSecret(plaintext: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = loadEncryptionKey(env);
  if (!key) throw new MissingEncryptionKeyError("storing a credential");

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/**
 * Decrypt a stored secret.
 *
 * A value without our version prefix is treated as legacy plaintext and
 * returned as-is. That is what makes deploying this safe and reversible: rows
 * written before the change keep working, and rolling back does not strand
 * anyone. (There were none at the time of writing — all three credential
 * tables were empty — but the path costs nothing and removes the need to get
 * deploy ordering exactly right.)
 */
export function decryptSecret(stored: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!isEncrypted(stored)) return stored;

  const key = loadEncryptionKey(env);
  if (!key) throw new MissingEncryptionKeyError("reading an encrypted credential");

  const parts = stored.split(".");
  if (parts.length !== 4) throw new Error("Stored credential is malformed");
  const [, ivB64, tagB64, ctB64] = parts;

  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  // Throws on a wrong key or tampered ciphertext rather than returning garbage
  // — that is the property GCM buys us over CBC.
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/** The last four characters of a secret, for "•••• 4f2a" style hints.
 *  Computed at WRITE time and stored in its own non-secret column, so rendering
 *  a settings page never needs to decrypt anything. */
export function secretLast4(plaintext: string): string | null {
  return plaintext.length >= 4 ? plaintext.slice(-4) : null;
}
