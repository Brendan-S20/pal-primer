import { describe, expect, it } from "vitest";
import { getCsrfRequestValidationResult } from "@tanstack/start-client-core";
import { isAllowedOrigin } from "@/lib/cors.server";

// This app shipped with NO CSRF protection: createStartHandler installs its
// default middleware only when no start instance supplies requestMiddleware,
// and src/start.ts has always supplied one, so the default was replaced
// silently.
//
// These tests drive TanStack's OWN validator with the exact options src/start.ts
// passes, rather than re-implementing the decision here — a test that restates
// the rule agrees with itself no matter how the library actually behaves. The
// options are duplicated below because start.ts is the server entry and
// importing it pulls in the whole app; if they drift, the last test in this
// file is what notices.

const NATIVE = "capacitor://localhost";
const SELF = "https://app.houndstack.com";

/** The shape the library hands a matcher — only the request is used here. */
type Ctx = { request: Request; handlerType?: string };

const opts = {
  filter: (ctx: Ctx) => ctx.handlerType === "serverFn",
  secFetchSite: async (value: string, ctx: Ctx) => {
    if (value === "same-origin") return true;
    return isAllowedOrigin(ctx.request.headers.get("origin"), process.env.NATIVE_CORS_ORIGINS);
  },
  origin: async (value: string, ctx: Ctx) => {
    if (value === new URL(ctx.request.url).origin) return true;
    return isAllowedOrigin(value, process.env.NATIVE_CORS_ORIGINS);
  },
  allowRequestsWithoutOriginCheck: false,
};

function ctxFor(headers: Record<string, string>, url = `${SELF}/_serverFn/setAutopay`): Ctx {
  return { request: new Request(url, { method: "POST", headers }) };
}

const verdict = (headers: Record<string, string>) =>
  getCsrfRequestValidationResult(
    opts as unknown as Parameters<typeof getCsrfRequestValidationResult>[0],
    ctxFor(headers) as unknown as Parameters<typeof getCsrfRequestValidationResult>[1],
  );

describe("the attack this exists to stop", () => {
  it("refuses a cross-site POST from another website", async () => {
    // The portal authenticates with a COOKIE (hs_portal_), which the browser
    // attaches automatically. Without this check, a page the customer happens
    // to be visiting could reschedule their visits or flip their autopay.
    await expect(
      verdict({ "sec-fetch-site": "cross-site", origin: "https://evil.test" }),
    ).resolves.toBe(false);
  });

  it("refuses a cross-site POST that sends no Origin at all", async () => {
    await expect(verdict({ "sec-fetch-site": "cross-site" })).resolves.toBe(false);
  });

  it("refuses a same-site POST from a sibling host", async () => {
    // A compromised subdomain is still not us.
    await expect(
      verdict({ "sec-fetch-site": "same-site", origin: "https://blog.houndstack.com" }),
    ).resolves.toBe(false);
  });

  it("refuses a request with nothing to judge it by", async () => {
    // No Sec-Fetch-Site, no Origin, no Referer. allowRequestsWithoutOriginCheck
    // is false, so the library returns undefined and the caller treats that as
    // a refusal.
    await expect(verdict({})).resolves.toBeUndefined();
  });
});

describe("the callers that must keep working", () => {
  it("allows the web app's own calls", async () => {
    await expect(verdict({ "sec-fetch-site": "same-origin" })).resolves.toBe(true);
  });

  it("allows the native app, which is legitimately cross-site", async () => {
    // capacitor://localhost is a different origin by construction. This is the
    // case that makes a naive `secFetchSite: ["same-origin","cross-site"]`
    // tempting — and that would admit evil.test too.
    await expect(verdict({ "sec-fetch-site": "cross-site", origin: NATIVE })).resolves.toBe(true);
  });

  it("allows an older WebView that sends Origin but no Sec-Fetch-Site", async () => {
    await expect(verdict({ origin: NATIVE })).resolves.toBe(true);
  });

  it("still allows a same-origin request when Sec-Fetch-Site is absent", async () => {
    // Supplying `origin` replaces the library's built-in same-origin
    // comparison; forgetting to restate it would break the web app's own
    // calls on any browser that omits the header.
    await expect(verdict({ origin: SELF })).resolves.toBe(true);
  });
});

describe("scope", () => {
  it("validates server functions and leaves route handlers alone", async () => {
    // Stripe and Twilio webhooks are cross-site POSTs with their own signature
    // verification. Running CSRF over them would reject every payment event.
    expect(opts.filter({ handlerType: "serverFn" })).toBe(true);
    expect(opts.filter({ handlerType: "request" })).toBe(false);
  });
});

describe("the options here match the ones the server actually uses", () => {
  it("keeps start.ts and this file in step", async () => {
    // The options are duplicated (start.ts pulls in the world). This is the
    // guard against them drifting: if start.ts stops filtering to serverFn, or
    // starts allowing unchecked requests, or hard-codes a bare "cross-site",
    // the tests above would keep passing while production changed.
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync(new URL("../src/start.ts", import.meta.url), "utf8");
    // Comments stripped first. The header in start.ts spells out the wrong
    // configuration in order to warn against it, so a naive scan finds the very
    // string it is checking is absent — the same mistake the dead-machinery
    // check made when it counted TypeScript comments as callers.
    const src = raw
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n");
    expect(src).toContain("createCsrfMiddleware");
    expect(src).toContain('handlerType === "serverFn"');
    expect(src).toContain("allowRequestsWithoutOriginCheck: false");
    expect(src).toContain("isAllowedOrigin");
    // A literal array containing cross-site would disable the whole check.
    expect(src).not.toMatch(/secFetchSite:\s*\[/);
  });
});
