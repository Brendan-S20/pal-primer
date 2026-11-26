// A sign-out of this device that the auth server never answers (#1058).
//
// supabase-js waits for POST /logout before it removes the saved session, with
// no time limit, so "leave the password reset" could wait for ever while the
// recovery lock kept every other page closed.
//
// The REQUEST is aborted, not merely given up on. supabase-js reads an aborted
// request as a dropped connection and removes the session from this device
// itself. A request left running would do that whenever it finally came back,
// and take a sign-in made in the meantime with it.
//
// Only `scope=local` (leaving a reset). Every other request goes through as is.

export const LOCAL_SIGN_OUT_DEADLINE_MS = 8_000;

const LOCAL_LOGOUT = /\/auth\/v1\/logout\?(?:.*&)?scope=local(?:&|$)/;

export function fetchWithLocalSignOutDeadline(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!LOCAL_LOGOUT.test(url)) return fetch(input, init);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), LOCAL_SIGN_OUT_DEADLINE_MS);
  return fetch(input, { ...init, signal: abort.signal }).finally(() => clearTimeout(timer));
}
