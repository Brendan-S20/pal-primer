// Whether a password is in the Have I Been Pwned corpus, asked the same way
// the auth server asks it (#807).
//
// lib/password-policy.ts holds every rule the browser can check on its own.
// The one it cannot is production Supabase Auth's leaked-password check, so
// until this file a breached password was refused only by registerAccount,
// on Get started's LAST step, after the business name and the owner's name
// had been typed. checkNewPassword (auth-entry.functions.ts) runs this when
// the person leaves the password field or presses Continue on the FIRST step,
// so the refusal arrives where the password is typed.
//
// k-anonymity: only the first five hex characters of the SHA-1 leave the
// server, never the password or its full hash, and `Add-Padding` makes every
// response the same size. This is a courtesy: anything other than a clean
// answer is `null` ("couldn't tell"), the form carries on, and the auth
// server's own check at the end is still the source of truth.

export const HIBP_RANGE_URL = "https://api.pwnedpasswords.com/range/";

async function sha1Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

/** true: breached. false: not in the corpus. null: could not tell. */
export async function isPasswordBreached(
  password: string,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<boolean | null> {
  const doFetch = opts.fetch ?? fetch;
  try {
    const hash = await sha1Hex(password);
    const prefix = hash.slice(0, 5);
    const suffix = hash.slice(5);
    const res = await doFetch(`${HIBP_RANGE_URL}${prefix}`, {
      headers: { "Add-Padding": "true" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 2500),
    });
    if (!res.ok) return null;
    const body = await res.text();
    for (const line of body.split("\n")) {
      const [s, count] = line.trim().split(":");
      // Padding rows carry a count of 0 and are not real entries.
      if (s?.toUpperCase() === suffix && Number(count) > 0) return true;
    }
    return false;
  } catch {
    return null;
  }
}
