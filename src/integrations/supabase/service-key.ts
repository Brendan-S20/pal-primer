// Tells whether a key handed to the admin client is provably NOT a service key.
//
// On 2026-10-15 a local dev server had the anon/publishable key in
// SERVICE_ROLE_KEY. createClient accepted it, so "supabaseAdmin" quietly ran as
// anon against production and Postgres refused 265 reads and writes that the
// code believed were service-role. This check turns that into one clear error
// the first time the admin client is used.
//
// Kept free of supabase-js so it can be tested on its own.

export const SERVICE_KEY_IS_ANON_MESSAGE =
  "SERVICE_ROLE_KEY holds the anon/publishable key. Server code using it would act as an " +
  "anonymous visitor, so row-level security would refuse its reads and writes. Set it to the " +
  "service role key in Project Settings → Secrets.";

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** The `role` claim of a JWT-shaped key, or undefined when the key is not a
 *  JWT, cannot be decoded, or carries no role. */
function jwtRole(key: string): unknown {
  const parts = key.split(".");
  if (parts.length !== 3 || !parts.every((p) => BASE64URL.test(p))) return undefined;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const payload: unknown = JSON.parse(atob(padded));
    if (payload && typeof payload === "object" && "role" in payload) {
      return (payload as { role: unknown }).role;
    }
  } catch {
    // Not decodable: no evidence either way, so no objection.
  }
  return undefined;
}

/**
 * A message explaining why `key` cannot be the service role key, or null.
 *
 * Rejects only what is provable: a publishable key, or a JWT whose role claim
 * says something other than service_role. Anything opaque (sb_secret_ keys, the
 * placeholders tests and the Playwright config use) is accepted. The message
 * never contains the key.
 */
export function serviceKeyProblem(key: string): string | null {
  if (key.startsWith("sb_publishable_")) return SERVICE_KEY_IS_ANON_MESSAGE;
  const role = jwtRole(key);
  if (role !== undefined && role !== "service_role") return SERVICE_KEY_IS_ANON_MESSAGE;
  return null;
}
