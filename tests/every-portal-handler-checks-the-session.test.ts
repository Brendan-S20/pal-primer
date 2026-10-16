import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// QA finding #4 was Critical: `/portal/{uuid}` had no authentication at all, and
// anyone holding the link could see a client's schedule and the assigned tech's
// name, then add a card and switch on autopay. OTP verification was built in
// July and the finding was marked fixed.
//
// Re-verified 2026-08-02, three independent ways rather than by reading the
// note — a month of changes had landed since it was written:
//
//   1. Every `portal_*` RPC is revoked from `anon` and `authenticated` at the
//      database. Their ACLs are `postgres` and `service_role` only, so the
//      publishable key cannot reach one even holding a valid token.
//   2. All 22 server functions that call a `portal_*` RPC establish a session
//      first — this file.
//   3. `portalContext`, the one that looked ungated, calls `portal_get_client`
//      only INSIDE its `if (session)` branch. Unverified callers get the org
//      name and masked contact channels and nothing else.
//
// The claim held. This pins (2), because "twenty-two call sites and one of them
// forgot" is the exact shape this codebase keeps finding — nine tables where a
// server function was the only gate, three superseded RPCs still callable, a
// second skip_visit nothing had called since July. Handler twenty-three is the
// one to worry about, and nothing mechanical was stopping it.

// portal-training.functions.ts (2026-10-16) holds the Training page's
// handlers; the same rule covers them.
const source = ["portal.functions.ts", "portal-training.functions.ts"]
  .map((f) => readFileSync(fileURLToPath(new URL(`../src/lib/${f}`, import.meta.url)), "utf8"))
  .join("\n");

/** Each `export const NAME = createServerFn…` block, to the start of the next. */
function handlers(): Array<{ name: string; body: string }> {
  return source
    .split(/export const /)
    .slice(1)
    .map((part) => ({ name: part.slice(0, part.indexOf(" ")), body: part }));
}

const touchingClientData = handlers().filter((h) => /sb\.rpc\("portal_[a-z_]+"/.test(h.body));

describe("no portal handler reaches client data without a session", () => {
  it("finds the handlers at all", () => {
    // A parser that matches nothing would make every assertion below vacuous —
    // a green tick over an empty set, which is what this suite keeps catching
    // elsewhere.
    expect(handlers().length).toBeGreaterThan(20);
    expect(touchingClientData.length).toBeGreaterThanOrEqual(20);
    expect(touchingClientData.map((h) => h.name)).toContain("portalRequestTrainingLesson");
  });

  for (const h of touchingClientData) {
    const rpcs = [...h.body.matchAll(/sb\.rpc\("(portal_[a-z_]+)"/g)].map((m) => m[1]);
    it(`${h.name} establishes a session before ${rpcs.join(", ")}`, () => {
      // Either form counts. Most handlers call requirePortalSession, which
      // throws; portalContext calls getPortalSession and branches on it, which
      // is why a plain "must call requirePortalSession" rule would have been
      // wrong here and reported a correct handler as a hole.
      expect(
        /requirePortalSession\(|getPortalSession\(/.test(h.body),
        `${h.name} calls ${rpcs.join(", ")} without establishing a portal session. ` +
          `The RPC filters by portal_token, but the token is the thing in the URL — ` +
          `it is the credential the OTP exists to stop being sufficient on its own. ` +
          `This is QA finding #4, which was Critical.`,
      ).toBe(true);
    });
  }
});
