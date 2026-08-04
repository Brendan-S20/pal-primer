import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  continuationToken,
  continuationTokenValid,
  secretEq,
} from "@/lib/twilio-inbound-auth.server";

// Both inbound routes read as "shared secret OR per-tenant Twilio signature".
// In practice only the first ever ran: `resolveOrgTwilioConfig` returns null for
// EVERY org today (subaccount provisioning is in the 10DLC queue), so the
// signature branch could not succeed for anyone. One platform-wide secret,
// carried in the QUERY STRING, was the whole of inbound authentication.
//
// After it passed, the organization was resolved from the attacker-supplied
// `To` form field — so anyone holding it could forge an inbound message to ANY
// tenant. A forged STOP suppresses that tenant's messaging to a customer of the
// attacker's choosing; a forged message invokes the AI receptionist, which is
// METERED and BILLED to the tenant.
//
// And the voice route echoed the secret back out: its TwiML continuation URL
// was `?s=<the platform secret>`, so every multi-turn call wrote the master
// credential into Twilio's stored call log.

const ROOT = new URL("..", import.meta.url).pathname;
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const SMS = "src/routes/api/public/hooks/twilio.ts";
const VOICE = "src/routes/api/public/hooks/twilio-voice.ts";

/** Comments are not code — a rule this repo has had to learn twice. Both files
 *  now explain the defect in prose, so raw matching finds the fix as the bug. */
const code = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");

describe("the shared query secret is no longer the first thing tried", () => {
  for (const route of [SMS, VOICE]) {
    it(`${route} verifies through the shared resolver`, () => {
      const src = code(read(route));
      expect(src).toContain("verifyTwilioInbound(");
      // The original read the secret straight off the query string in the
      // handler and short-circuited the signature check on it.
      expect(src).not.toMatch(/searchParams\.get\("s"\)/);
      expect(src).not.toMatch(/\bsharedOk\b/);
    });
  }

  it("tries the platform signature before the secret", () => {
    // Order is the whole fix. Checking the secret first is what made the
    // stronger check unreachable.
    const src = code(read("src/lib/twilio-inbound-auth.server.ts"));
    const platform = src.indexOf("TWILIO_AUTH_TOKEN");
    const shared = src.indexOf("TWILIO_INBOUND_SECRET");
    expect(platform).toBeGreaterThan(-1);
    expect(shared).toBeGreaterThan(platform);
  });

  it("still accepts the secret, because removing it would take inbound SMS down", () => {
    // A security fix that breaks the product on deploy is not one. It is the
    // LAST resort now, and it says so in the log whenever it is what let a
    // request through.
    const src = code(read("src/lib/twilio-inbound-auth.server.ts"));
    expect(src).toMatch(/via: "shared_secret"/);
    expect(src).toMatch(/console\.warn\(/);
  });
});

describe("the voice continuation no longer carries the platform secret", () => {
  const src = code(read(VOICE));

  it("does not put the raw secret in the TwiML it hands back to Twilio", () => {
    // `?s=${encodeURIComponent(shared!)}` — written into Twilio's call log on
    // every multi-turn call.
    expect(src).not.toMatch(/\?s=\$\{encodeURIComponent\(shared/);
    expect(src).not.toMatch(/shared!/);
  });

  it("hands back a per-call, per-turn token instead", () => {
    expect(src).toMatch(/continuationToken\(callSid, turn \+ 1\)/);
    expect(src).toMatch(/\?t=\$\{encodeURIComponent\(nextToken\)\}/);
  });

  it("validates that token for the turn being served", () => {
    expect(src).toMatch(/continuationTokenValid\(callSid, turn, url\.searchParams\.get\("t"\)\)/);
  });
});

describe("the continuation token", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    vi.stubEnv("TWILIO_INBOUND_SECRET", "s3cret-platform-value");
  });
  afterEach(() => {
    process.env = { ...saved };
    vi.unstubAllEnvs();
  });

  it("is not the secret", () => {
    const t = continuationToken("CA123", 1);
    expect(t).toBeTruthy();
    expect(t).not.toContain("s3cret-platform-value");
  });

  it("is accepted only for the call and turn it was minted for", () => {
    const t = continuationToken("CA123", 2)!;
    expect(continuationTokenValid("CA123", 2, t)).toBe(true);
    // A leaked log line must not be aimable at another call...
    expect(continuationTokenValid("CA999", 2, t)).toBe(false);
    // ...nor replayable a turn later.
    expect(continuationTokenValid("CA123", 3, t)).toBe(false);
  });

  it("refuses an absent or empty token", () => {
    expect(continuationTokenValid("CA123", 1, null)).toBe(false);
    expect(continuationTokenValid("CA123", 1, "")).toBe(false);
    expect(continuationTokenValid("", 1, "anything")).toBe(false);
  });

  it("mints nothing when no secret is configured", () => {
    // Then Twilio's own signature on the continuation request is doing the
    // work and no token is needed.
    vi.stubEnv("TWILIO_INBOUND_SECRET", "");
    expect(continuationToken("CA123", 1)).toBeNull();
    expect(continuationTokenValid("CA123", 1, "whatever")).toBe(false);
  });
});

describe("secretEq", () => {
  it("compares equal values as equal", () => {
    expect(secretEq("abc", "abc")).toBe(true);
  });

  it("does not leak length through an early return", () => {
    // The originals did `ba.length === bb.length && timingSafeEqual(...)`,
    // which answers "wrong length" faster than "wrong value". Hashing first
    // makes every comparison the same size and the same cost.
    expect(secretEq("abc", "abcdefghijklmnop")).toBe(false);
    expect(secretEq("", "x")).toBe(false);
  });
});
