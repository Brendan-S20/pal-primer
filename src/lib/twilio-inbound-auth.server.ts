// Who is allowed to deliver an inbound SMS or voice webhook.
//
// ── WHAT THIS REPLACES, AND WHY IT MATTERED MORE THAN IT LOOKED ───────────
//
// Both inbound routes did:
//
//     const sharedOk = !!shared && secretEq(url.searchParams.get("s") ?? "", shared);
//     ...
//     if (!sharedOk) { ...validate the ORG's Twilio signature... }
//
// which reads as "shared secret OR per-tenant signature". In practice it was
// only ever the first, because `resolveOrgTwilioConfig` returns null for EVERY
// org today — subaccount provisioning sits in the 10DLC queue — so the
// signature branch cannot succeed for anyone. A single platform-wide secret,
// carried in the QUERY STRING, was the whole of inbound authentication.
//
// Three things follow from that:
//
//   1. Query strings are the worst place to carry a credential. They are
//      written to server access logs, proxy logs, and Twilio's own request and
//      call logs, in full, in plaintext, for ever.
//
//   2. One secret authenticates every tenant. After the check passes, the org
//      is resolved from the attacker-controlled `To` form field — so anyone
//      holding it can forge an inbound message to ANY organization.
//
//   3. What that buys is not theoretical. A forged inbound STOP silently
//      suppresses a tenant's messaging to a customer of the attacker's
//      choosing, and a forged message invokes the AI receptionist, which is
//      METERED and BILLED to that tenant.
//
// And the voice route echoed the secret straight back out: its TwiML
// continuation URL was `?s=<the platform secret>`, so every multi-turn call
// wrote the master credential into Twilio's stored call log.
//
// ── WHAT REPLACES IT ──────────────────────────────────────────────────────
//
// Twilio signs every webhook it sends, with the auth token of the account that
// owns the number. That is the mechanism built for this, it needs no secret in
// a URL, and it cannot be replayed against a different request. So:
//
//   * PLATFORM-managed numbers verify against TWILIO_AUTH_TOKEN.
//   * Provisioned subaccounts verify against their own token, as before.
//   * The shared secret still works, because removing it before
//     TWILIO_AUTH_TOKEN is set would take inbound SMS down — but it is now the
//     LAST resort rather than the first, and it says so in the log every time
//     it is the thing that let a request through.
//
// Set TWILIO_AUTH_TOKEN and the secret stops being load-bearing. Nothing here
// forces that, because a security fix that takes the product offline the moment
// it deploys is not one.

import crypto from "node:crypto";
import { twilioSignatureIsValid } from "@/lib/twilio-signature.server";
import { appOrigin } from "@/lib/app-origin";

/** Constant-time compare that does not leak length through early return. */
export function secretEq(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export type InboundAuth =
  /** How the request proved itself. `shared_secret` is the weak path and is
   *  reported so it can be seen in logs rather than assumed absent. */
  { ok: true; via: "platform_signature" | "tenant_signature" | "shared_secret" } | { ok: false };

/**
 * Is this inbound webhook really from Twilio, for this organization?
 *
 * Signature first, secret last. Order matters: checking the secret first is
 * what made the stronger check unreachable in the original.
 */
export async function verifyTwilioInbound(opts: {
  requestUrl: string;
  pathWithQuery: string;
  params: Record<string, string>;
  signature: string | null;
  orgId: string;
  /** Already-validated continuation token, for multi-turn voice. */
  continuationOk?: boolean;
}): Promise<InboundAuth> {
  const { requestUrl, pathWithQuery, params, signature, orgId } = opts;

  // Twilio signs the exact public URL it was configured with. Behind a proxy
  // `request.url` can differ in scheme/host/www, so both forms are tried —
  // without this a correct signature is rejected and BYOK inbound breaks (M4).
  const canonical = appOrigin() + pathWithQuery;
  const signedWith = (token: string) =>
    twilioSignatureIsValid(requestUrl, params, token, signature) ||
    twilioSignatureIsValid(canonical, params, token, signature);

  const platformToken = process.env.TWILIO_AUTH_TOKEN;
  if (platformToken && signedWith(platformToken)) return { ok: true, via: "platform_signature" };

  const { resolveOrgTwilioConfig } = await import("@/lib/twilio-credentials.server");
  const tenant = await resolveOrgTwilioConfig(orgId);
  if (tenant?.authToken && signedWith(tenant.authToken)) {
    return { ok: true, via: "tenant_signature" };
  }

  if (opts.continuationOk) return { ok: true, via: "shared_secret" };

  const shared = process.env.TWILIO_INBOUND_SECRET;
  const url = new URL(requestUrl);
  if (shared && secretEq(url.searchParams.get("s") ?? "", shared)) {
    if (!platformToken) {
      console.warn(
        "inbound Twilio webhook authenticated by the SHARED QUERY SECRET. This is the weakest " +
          "path: it is platform-wide, it appears in every access and call log it passes through, " +
          "and after it passes the organization is taken from the attacker-supplied `To` field. " +
          "Set TWILIO_AUTH_TOKEN to authenticate by signature instead.",
      );
    }
    return { ok: true, via: "shared_secret" };
  }

  return { ok: false };
}

// ── Multi-turn voice continuations ────────────────────────────────────────
//
// A voice call is several requests: greet, gather, respond, gather again. The
// TwiML returned each turn names the URL Twilio should call next, and the old
// code put the raw platform secret in it. Twilio stores that TwiML.
//
// Twilio signs the continuation request too, so with TWILIO_AUTH_TOKEN set none
// of this is needed. Without it, the continuation carries a token derived from
// the secret rather than the secret itself: scoped to ONE call and ONE turn, so
// a leaked log line is not a reusable credential and cannot be pointed at a
// different call or replayed a turn later.

function continuationKey(): string | null {
  return process.env.TWILIO_INBOUND_SECRET ?? null;
}

/** Token for the NEXT turn of this call, or null when no secret is configured
 *  (in which case the signature is doing the work and none is needed). */
export function continuationToken(callSid: string, turn: number): string | null {
  const key = continuationKey();
  if (!key || !callSid) return null;
  return crypto
    .createHmac("sha256", key)
    .update(`${callSid}:${turn}`)
    .digest("base64url")
    .slice(0, 32);
}

export function continuationTokenValid(
  callSid: string,
  turn: number,
  token: string | null | undefined,
): boolean {
  if (!token || !callSid) return false;
  const expected = continuationToken(callSid, turn);
  if (!expected) return false;
  return secretEq(expected, token);
}
