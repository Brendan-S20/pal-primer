import { createServerFn } from "@tanstack/react-start";

/**
 * The Maps JavaScript API browser key, read at RUNTIME — the second of two
 * ways the browser can learn it. See `resolveBrowserKey` in
 * src/lib/maps/google-loader.ts for the first, and for why both exist.
 *
 * Public by design: a browser key is sent to Google from every page that draws
 * a map, so anyone can read it out of the network tab. What protects it is the
 * restriction in Google Cloud (Maps JavaScript API only, the app's referrers
 * only), not secrecy. Unauthenticated for the same reason, and because the
 * customer-facing tracking page has no session.
 *
 * NEVER return a server key from here. GOOGLE_PLACES_API_KEY and
 * GOOGLE_MAPS_API_KEY are unrestricted-by-referrer server credentials; the
 * test tests/google-draws-the-maps.test.ts fails if this file names either.
 */
export const getMapsBrowserKey = createServerFn({ method: "GET" }).handler(async () => {
  const key =
    process.env.GOOGLE_MAPS_BROWSER_KEY ??
    process.env.VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_BROWSER_KEY ??
    "";
  return { key: key.trim() || null };
});
