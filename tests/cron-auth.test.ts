import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authorizeCronRequest } from "@/lib/cron-auth.server";

// The regression this file exists for: the anon/publishable key must never
// authorize an unattended cron endpoint again. It ships in the browser bundle,
// so accepting it means anyone who has loaded the app can fire the platform's
// dunning run, digest emails and announcement blasts on demand.

const SERVICE = "svc-role-key-abc123";
const SECRET = "cron-secret-xyz789";
const ANON = "anon-publishable-key-public";

const req = (opts: { headers?: Record<string, string>; query?: string } = {}) =>
  new Request(`https://app.example.com/api/public/hooks/nightly${opts.query ?? ""}`, {
    method: "POST",
    headers: opts.headers ?? {},
  });

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {
    CRON_SECRET: process.env.CRON_SECRET,
    SERVICE_ROLE_KEY: process.env.SERVICE_ROLE_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY,
  };
  process.env.CRON_SECRET = SECRET;
  process.env.SERVICE_ROLE_KEY = SERVICE;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_PUBLISHABLE_KEY = ANON;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("the anon key is not a credential", () => {
  it("refuses the publishable key in an apikey header", () => {
    // The whole point. pg_cron still SENDS this header alongside the Bearer
    // token, so the check has to ignore it rather than be satisfied by it.
    const auth = authorizeCronRequest(req({ headers: { apikey: ANON } }));
    expect(auth.ok).toBe(false);
  });

  it("refuses the publishable key presented as a Bearer token", () => {
    const auth = authorizeCronRequest(req({ headers: { authorization: `Bearer ${ANON}` } }));
    expect(auth.ok).toBe(false);
  });

  it("still authorizes when the anon header rides ALONG WITH a real credential", () => {
    // Exactly what the live cron sends: both headers. Tightening the check must
    // not reject the job that has been running all along.
    const auth = authorizeCronRequest(
      req({ headers: { apikey: ANON, authorization: `Bearer ${SERVICE}` } }),
    );
    expect(auth).toEqual({ ok: true, via: "service_role" });
  });
});

describe("private credentials", () => {
  it("accepts the service role key as a Bearer token", () => {
    const auth = authorizeCronRequest(req({ headers: { authorization: `Bearer ${SERVICE}` } }));
    expect(auth).toEqual({ ok: true, via: "service_role" });
  });

  it("accepts CRON_SECRET from the header and from the query string", () => {
    expect(authorizeCronRequest(req({ headers: { "x-cron-secret": SECRET } })).ok).toBe(true);
    expect(authorizeCronRequest(req({ query: `?s=${SECRET}` })).ok).toBe(true);
  });

  it("falls back to SUPABASE_SERVICE_ROLE_KEY, matching the admin client", () => {
    // client.server.ts resolves SERVICE_ROLE_KEY || SUPABASE_SERVICE_ROLE_KEY.
    // If this check resolved them differently, a deployment setting only the
    // legacy name would authenticate its database writes and fail its cron.
    delete process.env.SERVICE_ROLE_KEY;
    process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE;
    expect(authorizeCronRequest(req({ headers: { authorization: `Bearer ${SERVICE}` } })).ok).toBe(
      true,
    );
  });

  it("refuses a near-miss Bearer token", () => {
    expect(authorizeCronRequest(req({ headers: { authorization: `Bearer ${SERVICE}x` } })).ok).toBe(
      false,
    );
  });

  it("refuses everything when nothing is presented", () => {
    expect(authorizeCronRequest(req()).ok).toBe(false);
  });
});

describe("an unset secret never authorizes", () => {
  it("does not match an absent CRON_SECRET against an absent header", () => {
    // The classic undefined === undefined hole: with neither configured nor
    // presented, a careless equality check authorizes everyone.
    delete process.env.CRON_SECRET;
    delete process.env.SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(authorizeCronRequest(req()).ok).toBe(false);
    expect(authorizeCronRequest(req({ headers: { authorization: "Bearer undefined" } })).ok).toBe(
      false,
    );
  });
});

describe("the rejection explains itself without leaking anything", () => {
  it("distinguishes a mismatched token from a missing one", () => {
    const mismatched = authorizeCronRequest(req({ headers: { authorization: "Bearer wrong" } }));
    const missing = authorizeCronRequest(req());
    if (mismatched.ok || missing.ok) throw new Error("expected both to be refused");
    expect(mismatched.detail.presentedBearer).toBe(true);
    expect(String(mismatched.detail.hint)).toMatch(/rotated/i);
    expect(missing.detail.presentedBearer).toBe(false);
    expect(String(missing.detail.hint)).toMatch(/No Bearer token/i);
  });

  it("never puts key material in the diagnostic", () => {
    // This object goes to logs. A hint that quoted the expected key would move
    // the secret somewhere it was never meant to be.
    const auth = authorizeCronRequest(
      req({ headers: { authorization: `Bearer ${ANON}`, apikey: ANON } }),
    );
    if (auth.ok) throw new Error("expected refusal");
    const serialized = JSON.stringify(auth.detail);
    expect(serialized).not.toContain(SERVICE);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(ANON);
  });
});
