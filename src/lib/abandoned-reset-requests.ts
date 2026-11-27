// Auth requests whose reply makes supabase-js save a session (#1058).
//
// updateUser, setSession, verifyOtp and a code exchange each write the session
// to this device when their reply arrives, even if the person has pressed
// "Cancel reset and sign out" in the meantime: the sign-out ran, then the late
// reply signed them back in. supabase-js takes no abort signal for these, so
// the client's `fetch` gives them one here. Once aborted they fail like a
// dropped connection, and nothing is saved.

const SAVES_A_SESSION = /\/auth\/v1\/(?:user|verify|token\?(?:.*&)?grant_type=pkce)(?:[?&]|$)/;

let current = new AbortController();

/**
 * Fail every such request, those already sent and any started from now, until
 * the returned function is called. Call it once the work that was making them
 * has settled.
 */
export function abandonSessionRequests(): () => void {
  const abandoned = current;
  abandoned.abort();
  return () => {
    if (current === abandoned) current = new AbortController();
  };
}

export function fetchUnlessAbandoned(input: RequestInfo | URL, init?: RequestInit) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!SAVES_A_SESSION.test(url)) return fetch(input, init);
  const { signal } = current;
  return new Promise<Response>((resolve, reject) => {
    // Rejects by itself too: a reply that still comes back from a fetch that
    // ignored the abort must go nowhere.
    const abandon = () =>
      reject(new DOMException("The password reset was cancelled", "AbortError"));
    if (signal.aborted) return abandon();
    signal.addEventListener("abort", abandon, { once: true });
    // The body is read here as well, so an abort between the headers and the
    // body still counts.
    fetch(input, { ...init, signal })
      .then(async (res) => {
        const body = await res.arrayBuffer();
        resolve(
          new Response(body.byteLength ? body : null, {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers,
          }),
        );
      })
      .catch(reject)
      .finally(() => signal.removeEventListener("abort", abandon));
  });
}
