// Frame-control and feature headers for every response app.houndstack.com sends.
//
// Issue #1023: the signed-out app sent HSTS, Referrer-Policy and nosniff but no
// frame-ancestors, X-Frame-Options or Permissions-Policy, so any site could put
// the sign-in page in an iframe.
//
// Deliberately NOT a full Content-Security-Policy: the app loads Stripe, Maps,
// Sentry and inline styles, and a script-src written from memory would break
// one of them silently. frame-ancestors is the part of CSP that is safe to
// ship alone. Nothing in src/ renders this app inside an iframe.
//
// Permissions-Policy is not the marketing site's blanket disable: the signed-in
// app uses the camera (photos, scanning), the microphone (voice notes) and
// geolocation (routing, check-in), so those stay on for the app's own origin
// and off for anything embedded in it. Features the app never uses are off.

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": "frame-ancestors 'self'",
  "X-Frame-Options": "SAMEORIGIN",
  "Permissions-Policy": "camera=(self), microphone=(self), geolocation=(self), interest-cohort=()",
};

/** Adds the headers the response does not already carry. A route that set its
 *  own value for one of them keeps it (a CSP a route wrote is more specific). */
export function withSecurityHeaders(response: Response): Response {
  // Redirects from fetch() and some adapters have immutable headers.
  let target = response;
  try {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
      if (!target.headers.has(k)) target.headers.set(k, v);
    }
  } catch {
    target = new Response(response.body, response);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
      if (!target.headers.has(k)) target.headers.set(k, v);
    }
  }
  return target;
}

export const ROBOTS_TXT = `# app.houndstack.com is the signed-in HoundStack app, not a public site.
# The public site is https://www.houndstack.com
User-agent: *
Disallow: /
`;
