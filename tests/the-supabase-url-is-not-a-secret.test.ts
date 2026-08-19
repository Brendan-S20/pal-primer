import { describe, expect, it, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { PUBLIC_SUPABASE_URL, resolveSupabaseUrl } from "@/lib/supabase-url";

// Transactional email was 100% dead in production — 360 of 360 rows in
// `net._http_response` were `500 {"error":"Server configuration error"}` — and
// the cause was not a bounce, not the Resend key, not the service role key. Six
// routes under src/routes/email/ read the Supabase project URL from
// `import.meta.env.VITE_SUPABASE_URL`, which Vite INLINES AT BUILD. The
// variable was absent when the bundle was built, so every one of them compiled
// to `undefined`, tripped its own config guard, and no value added to a runtime
// secret store afterwards could reach the already-built code.
//
// Nothing else in the product noticed, because src/integrations/supabase/client.ts
// hard-codes its own copy of the same string. The app signed in and worked
// perfectly while every invoice, OTP, receipt and reminder went undelivered.
//
// These tests hold the shape of the fix: the URL is public, it is a constant,
// and no route may go back to reading it from a build-time-only variable.

const EMAIL_ROUTES = [
  "src/routes/email/transactional/send.ts",
  "src/routes/email/auth/webhook.ts",
  "src/routes/email/unsubscribe.ts",
  "src/routes/email/queue/process.ts",
  "src/routes/email/suppression.ts",
];

describe("the Supabase URL server code uses", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("is never undefined, whatever the environment holds", () => {
    delete process.env.SUPABASE_URL;
    delete process.env.VITE_SUPABASE_URL;
    expect(resolveSupabaseUrl()).toBe(PUBLIC_SUPABASE_URL);
    // An ORIGIN: https, a host, and nothing else. Not `\S+\.supabase\.co`,
    // which this asserted until the custom domain was activated on 2026-08-19
    // — that pinned the vendor's hostname, which is exactly the thing a custom
    // domain exists to stop depending on. What actually matters here is the
    // shape: a trailing slash or a path would make every call `//rest/v1/...`
    // or `/path/rest/v1/...` and fail a long way from the cause.
    expect(resolveSupabaseUrl()).toMatch(/^https:\/\/[^/\s]+$/);
  });

  it("treats an empty env var as absent rather than returning an empty URL", () => {
    // `??` would have accepted "" here and produced `"/rest/v1/..."` — a
    // same-origin request to the app itself, which fails far from the cause.
    process.env.SUPABASE_URL = "";
    expect(resolveSupabaseUrl()).toBe(PUBLIC_SUPABASE_URL);
  });

  it("lets an explicit runtime variable win, so staging can point elsewhere", () => {
    process.env.SUPABASE_URL = "https://staging.supabase.co";
    expect(resolveSupabaseUrl()).toBe("https://staging.supabase.co");
  });

  it("prefers SUPABASE_URL over the VITE_ name, which only exists at build", () => {
    process.env.SUPABASE_URL = "https://runtime.supabase.co";
    process.env.VITE_SUPABASE_URL = "https://buildtime.supabase.co";
    expect(resolveSupabaseUrl()).toBe("https://runtime.supabase.co");
  });

  it("matches the URL the browser client already ships to every visitor", () => {
    // The proof it is not a secret, and the coupling that must not drift: if
    // the project ever moves, both copies move together or server mail and
    // browser reads talk to different databases.
    const client = readFileSync("src/integrations/supabase/client.ts", "utf8");
    expect(client).toContain(`"${PUBLIC_SUPABASE_URL}"`);
  });
});

describe("no email route reads the URL from a build-time-only variable", () => {
  for (const route of EMAIL_ROUTES) {
    it(`${route} resolves it at runtime`, () => {
      const src = readFileSync(route, "utf8");
      // Comments in these files explain the outage by name, so match the
      // property access, not the bare word.
      const codeReads = /import\.meta\.env[?.\s]*\.?\s*VITE_SUPABASE_URL/.test(
        src.replace(/^\s*\/\/.*$/gm, ""),
      );
      expect(codeReads).toBe(false);
      expect(src).toContain("resolveSupabaseUrl()");
    });
  }
});
