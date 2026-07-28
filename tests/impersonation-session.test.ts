import { describe, expect, it } from "vitest";
import {
  IMPERSONATION_SESSION_TTL_MS,
  isSessionWindowOpen,
} from "@/lib/impersonation-session.shared";
import { isImpersonationExpiredError } from "@/lib/impersonation-expiry";
import { ImpersonationExpiredError } from "@/lib/impersonation-session.server";

// BUG-2 — an impersonation session used to outlive its grant silently, because
// only the single-use link was bounded and the minted Supabase session then
// refreshed itself indefinitely. Guardrail 10.4: the window is enforced
// server-side, so these cover the decision the server gate actually makes.
const NOW = Date.parse("2026-07-28T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("impersonation session window", () => {
  it("is open before the stored expiry", () => {
    expect(
      isSessionWindowOpen({ session_expires_at: iso(NOW + 60_000), consumed_at: iso(NOW) }, NOW),
    ).toBe(true);
  });

  it("is closed after the stored expiry — the idle-tab case in the finding", () => {
    expect(
      isSessionWindowOpen(
        { session_expires_at: iso(NOW - 1_000), consumed_at: iso(NOW - 7_200_000) },
        NOW,
      ),
    ).toBe(false);
  });

  it("is closed exactly at the boundary rather than one tick late", () => {
    expect(isSessionWindowOpen({ session_expires_at: iso(NOW), consumed_at: iso(NOW) }, NOW)).toBe(
      false,
    );
  });

  it("bounds grants consumed before the migration via consumed_at + the TTL", () => {
    // Pre-existing live sessions carry a NULL session_expires_at; they must be
    // bounded, not immortal.
    const insideTtl = NOW - IMPERSONATION_SESSION_TTL_MS + 60_000;
    const pastTtl = NOW - IMPERSONATION_SESSION_TTL_MS - 60_000;
    expect(
      isSessionWindowOpen({ session_expires_at: null, consumed_at: iso(insideTtl) }, NOW),
    ).toBe(true);
    expect(isSessionWindowOpen({ session_expires_at: null, consumed_at: iso(pastTtl) }, NOW)).toBe(
      false,
    );
  });

  it("prefers the stored expiry over the consumed_at fallback", () => {
    // A grant consumed long ago but explicitly extended stays open: the stored
    // window is the record of what the session actually ran under (10.6).
    expect(
      isSessionWindowOpen(
        { session_expires_at: iso(NOW + 60_000), consumed_at: iso(NOW - 86_400_000) },
        NOW,
      ),
    ).toBe(true);
  });

  it("fails closed when neither timestamp is readable", () => {
    expect(isSessionWindowOpen({ session_expires_at: null, consumed_at: null }, NOW)).toBe(false);
    expect(
      isSessionWindowOpen({ session_expires_at: "not-a-date", consumed_at: "also-bad" }, NOW),
    ).toBe(false);
  });
});

describe("expiry error crosses the server-fn boundary", () => {
  it("is recognized from the reduced message string the client receives", () => {
    // Server fns surface errors as their message only, so the client matcher
    // has to work off the message — not instanceof.
    const asClientSeesIt = new Error(new ImpersonationExpiredError().message);
    expect(isImpersonationExpiredError(asClientSeesIt)).toBe(true);
  });

  it("does not fire on unrelated failures", () => {
    expect(isImpersonationExpiredError(new Error("Not authorized"))).toBe(false);
    expect(isImpersonationExpiredError(undefined)).toBe(false);
  });
});
