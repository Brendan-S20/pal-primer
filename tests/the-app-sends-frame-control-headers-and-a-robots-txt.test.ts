// Issue #1023: the signed-out app had no frame-ancestors, X-Frame-Options or
// Permissions-Policy, and /robots.txt was the SPA's HTML 404.

import { describe, expect, it } from "vitest";
import { ROBOTS_TXT, SECURITY_HEADERS, withSecurityHeaders } from "@/lib/security-headers";

describe("withSecurityHeaders", () => {
  it("adds frame-ancestors, X-Frame-Options and Permissions-Policy", () => {
    const res = withSecurityHeaders(new Response("<html></html>"));
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(res.headers.get("permissions-policy")).toBeTruthy();
  });

  it("keeps the camera, microphone and geolocation the signed-in app uses", () => {
    const pp = SECURITY_HEADERS["Permissions-Policy"];
    for (const f of ["camera", "microphone", "geolocation"]) {
      expect(pp).toContain(`${f}=(self)`);
      expect(pp).not.toContain(`${f}=()`);
    }
  });

  it("does not overwrite a header a route already set", () => {
    const res = withSecurityHeaders(
      new Response("x", { headers: { "Content-Security-Policy": "default-src 'none'" } }),
    );
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'");
  });

  it("works on a response with immutable headers", () => {
    const res = withSecurityHeaders(Response.redirect("https://app.houndstack.com/auth", 302));
    expect(res.status).toBe(302);
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });
});

describe("robots.txt", () => {
  it("keeps crawlers out of the app and points at the public site", () => {
    expect(ROBOTS_TXT).toMatch(/^User-agent: \*$/m);
    expect(ROBOTS_TXT).toMatch(/^Disallow: \/$/m);
    expect(ROBOTS_TXT).toContain("www.houndstack.com");
  });

  it("is served as text/plain with a 200", async () => {
    const { Route } = await import("@/routes/robots[.]txt");
    const handler = (
      Route.options as unknown as {
        server: { handlers: { GET: (c: unknown) => Promise<Response> } };
      }
    ).server.handlers.GET;
    const res: Response = await handler({});
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await res.text()).toBe(ROBOTS_TXT);
  });
});
