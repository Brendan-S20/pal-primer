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

const FRAME_HEADERS = ["Content-Security-Policy", "X-Frame-Options"] as const;

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": "frame-ancestors 'self'",
  "X-Frame-Options": "SAMEORIGIN",
  "Permissions-Policy": "camera=(self), microphone=(self), geolocation=(self), interest-cohort=()",
};

/** The one page meant to sit in an iframe on a business's own website: the
 *  embed code in Settings > Online signup pastes /signup/<slug>?embed=1. Frame
 *  headers here would blank every one of those embeds. One segment after
 *  /signup, and not /signup/success (a normal page). */
export function isSignupEmbedPath(pathname: string): boolean {
  const m = /^\/signup\/([^/]+)\/?$/.exec(pathname);
  return !!m && m[1] !== "success";
}

/** Adds the headers the response does not already carry. A route that set its
 *  own value for one of them keeps it (a CSP a route wrote is more specific).
 *  The signup embed route (pass its pathname) gets no frame headers. */
export function withSecurityHeaders(response: Response, pathname?: string): Response {
  const skipFrame = pathname !== undefined && isSignupEmbedPath(pathname);
  const apply = (target: Response) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
      if (skipFrame && (FRAME_HEADERS as readonly string[]).includes(k)) continue;
      if (!target.headers.has(k)) target.headers.set(k, v);
    }
  };
  // Redirects from fetch() and some adapters have immutable headers.
  let target = response;
  try {
    apply(target);
  } catch {
    target = new Response(response.body, response);
    apply(target);
  }
  return target;
}

export const ROBOTS_TXT = `# app.houndstack.com is the signed-in HoundStack app, not a public site.
# The public site is https://www.houndstack.com
User-agent: *
Disallow: /
`;
