#!/usr/bin/env node
// Apple's "client secret" is not a secret you can copy. It is a JWT you sign.
//
// ── WHY THIS SCRIPT EXISTS ────────────────────────────────────────────────
//
// Every other provider hands you a string. You paste it into Supabase and you
// are done. Apple does not: the developer portal gives you a .p8 PRIVATE KEY,
// and Supabase's "Secret Key (for OAuth)" field wants an ES256 JWT SIGNED with
// that key. Nowhere in Apple's UI is the JWT shown, because it does not exist
// until somebody generates it. That gap is where Apple sign-in setups stall,
// and it is why Supabase answers:
//
//     {"error_code":"validation_failed",
//      "msg":"Unsupported provider: missing OAuth secret"}
//
// while the provider toggle reads "enabled".
//
// ── THE SIX-MONTH FUSE ────────────────────────────────────────────────────
//
// Apple caps the token at 15777000 seconds -- roughly six months -- and
// REFUSES anything longer. So this is not a one-off task: whatever you paste
// into Supabase stops working on a date this script prints, and it fails the
// way Google failed on 2026-08-25, at the provider, invisible to the app.
// `npm run check:oauth` is what notices.
//
// Usage:
//   node scripts/apple-client-secret.mjs \
//     --p8 ./AuthKey_ABC123DEFG.p8 \
//     --team-id 1A2B3C4D5E \
//     --key-id ABC123DEFG \
//     --services-id consulting.thenorth.houndstack.web
//
// Nothing is transmitted. The key is read, signed with locally, and never
// leaves this machine.
import { readFileSync } from "node:fs";
import { createPrivateKey, sign } from "node:crypto";

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
};

const p8Path = arg("p8");
const teamId = arg("team-id");
const keyId = arg("key-id");
const servicesId = arg("services-id");

const missing = [
  ["--p8", p8Path],
  ["--team-id", teamId],
  ["--key-id", keyId],
  ["--services-id", servicesId],
].filter(([, v]) => !v);

if (missing.length) {
  console.error(`Missing: ${missing.map(([f]) => f).join(", ")}\n`);
  console.error("  --p8            the AuthKey_XXXXXXXXXX.p8 downloaded from Apple (once, ever)");
  console.error("  --team-id       Apple Developer -> top right, 10 characters");
  console.error("  --key-id        the KEY's id, the XXXXXXXXXX in the filename");
  console.error("  --services-id   the SERVICES ID, e.g. consulting.thenorth.houndstack.web");
  console.error("                  NOT the App ID. This is the single most common mistake:");
  console.error("                  the App ID identifies the iOS app, the Services ID");
  console.error("                  identifies the WEB sign-in client, and Apple rejects");
  console.error("                  the former with invalid_client.");
  process.exit(2);
}

let privateKey;
try {
  privateKey = createPrivateKey(readFileSync(p8Path, "utf8"));
} catch (e) {
  console.error(`Could not read a private key from ${p8Path}: ${e.message}`);
  console.error("It should start with -----BEGIN PRIVATE KEY-----");
  process.exit(2);
}

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const now = Math.floor(Date.now() / 1000);
const SIX_MONTHS = 15777000; // Apple's hard ceiling. Longer is rejected outright.
const exp = now + SIX_MONTHS;

const header = { alg: "ES256", kid: keyId };
const payload = {
  iss: teamId,
  iat: now,
  exp,
  aud: "https://appleid.apple.com",
  // The client_id Apple will see. Supabase must be given the SAME value in its
  // "Client IDs" field, or Apple rejects the exchange with invalid_client.
  sub: servicesId,
};

const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;

// ES256 signatures must be raw r||s (JOSE), not the DER that OpenSSL emits by
// default. Node calls that encoding ieee-p1363. A DER signature here produces a
// token Apple rejects with no useful message.
const signature = sign("sha256", Buffer.from(signingInput), {
  key: privateKey,
  dsaEncoding: "ieee-p1363",
});

const jwt = `${signingInput}.${b64url(signature)}`;

console.log("\nPaste this into Supabase -> Authentication -> Providers -> Apple -> Secret Key:\n");
console.log(jwt);
console.log(`\n  Client IDs field: ${servicesId}`);
console.log(`  Expires:          ${new Date(exp * 1000).toISOString().slice(0, 10)}  <-- diarise this`);
console.log("\nThen run: npm run check:oauth\n");
