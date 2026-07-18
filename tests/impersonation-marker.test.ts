// H2 deferred item: impersonation marker on tenant activity entries.
// The marker keys off the minted auth session's JWT session_id — exact match,
// no heuristics — so a user's own concurrent sessions can never be marked.
import { describe, expect, it } from "vitest";
import {
  impersonationMetaFor,
  sessionIdFromAuthHeader,
} from "@/lib/impersonation-marker";

const jwtWith = (payload: Record<string, unknown>) =>
  `Bearer x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.y`;

describe("sessionIdFromAuthHeader", () => {
  it("extracts session_id from a bearer JWT", () => {
    expect(sessionIdFromAuthHeader(jwtWith({ sub: "u1", session_id: "sess-1" }))).toBe("sess-1");
  });

  it("returns null without a bearer header", () => {
    expect(sessionIdFromAuthHeader(null)).toBeNull();
    expect(sessionIdFromAuthHeader(undefined)).toBeNull();
    expect(sessionIdFromAuthHeader("Basic abc")).toBeNull();
  });

  it("returns null for malformed tokens", () => {
    expect(sessionIdFromAuthHeader("Bearer not-a-jwt")).toBeNull();
    expect(sessionIdFromAuthHeader("Bearer a.!!!.c")).toBeNull();
  });

  it("returns null when the claim is absent or empty", () => {
    expect(sessionIdFromAuthHeader(jwtWith({ sub: "u1" }))).toBeNull();
    expect(sessionIdFromAuthHeader(jwtWith({ session_id: "" }))).toBeNull();
    expect(sessionIdFromAuthHeader(jwtWith({ session_id: 42 }))).toBeNull();
  });
});

describe("impersonationMetaFor", () => {
  const grant = { id: "g1", actor_user_id: "admin-1", target_user_id: "user-1" };

  it("marks activity written by the impersonated user under the granted session", () => {
    expect(impersonationMetaFor("user-1", grant)).toEqual({
      grant_id: "g1",
      admin_user_id: "admin-1",
    });
  });

  it("does not mark activity for a different actor even if a grant is active", () => {
    expect(impersonationMetaFor("someone-else", grant)).toBeNull();
  });

  it("does not mark system events (no actor) or sessions with no grant", () => {
    expect(impersonationMetaFor(null, grant)).toBeNull();
    expect(impersonationMetaFor("user-1", null)).toBeNull();
  });
});
