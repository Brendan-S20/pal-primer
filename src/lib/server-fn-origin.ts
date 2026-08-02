// BUILD-9. Re-anchors server-function calls to the real API origin in a
// bundled native build.
//
// @tanstack/start-client-core bakes each server function's URL into the client
// bundle at build time:
//
//   createClientRpc: `const url = process.env.TSS_SERVER_FN_BASE + functionId`
//
// and TSS_SERVER_FN_BASE is produced by createServerFnBasePath(), which is
// `joinPaths(["/", routerBasepath, serverFnBase, "/"])`. joinPaths collapses
// repeated slashes, so an absolute `serverFns.base` does NOT survive — passing
// "https://app.houndstack.com/_serverFn" yields the string
// "/https:/app.houndstack.com/_serverFn/". There is no build-time option that
// points server functions at another origin; the value is always a path.
//
// A path is correct on the web, where the document is served from the same
// origin as the API. It is wrong the moment the app boots from an app bundle:
// the document origin becomes capacitor://localhost (iOS) or https://localhost
// (Android), so "/_serverFn/..." resolves to the bundle, which serves no API.
// Every server function — which is how essentially all data in this app is
// fetched — would fail with a working network, so the app would launch offline
// and stay that way.
//
// `serverFns.fetch` (createStart, src/start.ts) is the supported runtime hook:
// createClientRpc reads it back out of the start options on every call. So the
// path is rewritten at call time rather than at build time.

// Baked in by vite.config.ts. "" for the web build, where the relative path is
// already right — the branch in src/start.ts folds away with it.
const NATIVE_API_ORIGIN: string = import.meta.env.VITE_NATIVE_API_ORIGIN ?? "";

export const hasNativeApiOrigin = NATIVE_API_ORIGIN !== "";

/**
 * Rewrites the root-relative server-function path onto NATIVE_API_ORIGIN.
 *
 * Deliberately does NOT set `credentials: "include"`: this app authenticates
 * server functions with a bearer token attached per-call by attachSupabaseAuth
 * (src/integrations/supabase/auth-attacher.ts) out of Supabase's localStorage
 * session, not with cookies. Sending cookies cross-origin would add a
 * SameSite/third-party-cookie dependency the app does not need.
 */
export const fetchFromNativeApiOrigin: typeof fetch = (input, init) => {
  if (typeof input === "string" && input.startsWith("/")) {
    return fetch(NATIVE_API_ORIGIN + input, init);
  }
  return fetch(input, init);
};
