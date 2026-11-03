// ── WHERE THE SIGNED-IN SESSION IS KEPT ON THIS DEVICE (native-r2-09) ────
//
// From 2026-07-10 until this file, client.ts passed
// `storageKey: impersonating ? '…' : undefined`. An explicit `undefined`
// overwrites supabase-js's own default in its options spread, so every
// session on every device was saved as localStorage["undefined"]: measured on
// the iOS shipped bundle, 2,029 characters under that literal key. It worked,
// but any other code that wrote localStorage["undefined"] (an easy accident:
// `setItem(someKey, …)` with an unset variable) would sign the person out, and
// nothing that looks for a Supabase session by name could find it.
//
// The key is now a name, and it is a constant rather than supabase-js's
// derived `sb-<first label of the host>-auth-token`, because the derived one
// changes whenever the API host does (the custom domain already moved it once).
//
// ── NOBODY IS SIGNED OUT BY THE CHANGE ──────────────────────────────────
//
// `moveSessionToNamedKey` runs once, synchronously, before the client is
// created, so the very first read GoTrue makes already finds the session
// under the new name. It moves (copies, then removes) whatever sits under the
// old keys, and only when the new key is empty: a session saved under the
// new name is never overwritten by an older one. PKCE's code verifier lives
// beside the session as `<key>-code-verifier`, so a sign-in with Google or
// Apple that was half-way through when the app updated still finishes.
//
// An impersonation tab is untouched: it has its own key in sessionStorage.

/** The localStorage key a signed-in session is saved under. Matches the
 *  `sb-*-auth-token` shape the e2e helpers and support scripts look for. */
export const SESSION_STORAGE_KEY = "sb-houndstack-auth-token";

/** The literal key the explicit `undefined` produced. */
export const LEGACY_SESSION_KEY = "undefined";

/** supabase-js's own default for a URL, which is what it would have used had
 *  the option been omitted rather than `undefined`. Checked second, for a
 *  device that somehow holds one (a build from before 2026-07-10). */
export function derivedSessionKey(supabaseUrl: string): string | null {
  try {
    return `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`;
  } catch {
    return null;
  }
}

/** What a stored Supabase session looks like, enough to tell it from some
 *  other value that happened to land under the literal key "undefined". */
function looksLikeSession(raw: string | null): raw is string {
  if (!raw) return false;
  try {
    const v = JSON.parse(raw) as Record<string, unknown> | null;
    return (
      !!v &&
      typeof v === "object" &&
      typeof v.access_token === "string" &&
      typeof v.refresh_token === "string"
    );
  } catch {
    return false;
  }
}

type KeyValueStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * Move a session saved under an old key to SESSION_STORAGE_KEY.
 * Returns the key it moved from, or null when there was nothing to move.
 * Never throws: storage that refuses access (private mode, a locked-down
 * WebView) just means there is nothing this can do, and the client still
 * gets created.
 */
export function moveSessionToNamedKey(
  storage: KeyValueStore | undefined,
  supabaseUrl: string,
): string | null {
  if (!storage) return null;
  try {
    const derived = derivedSessionKey(supabaseUrl);
    const candidates = [LEGACY_SESSION_KEY, derived].filter(
      (k): k is string => !!k && k !== SESSION_STORAGE_KEY,
    );
    // The PKCE verifier on its own: an OAuth sign-in started before the
    // update has a verifier and no session yet.
    const newVerifier = `${SESSION_STORAGE_KEY}-code-verifier`;
    if (storage.getItem(newVerifier) === null) {
      for (const from of candidates) {
        const v = storage.getItem(`${from}-code-verifier`);
        if (v === null) continue;
        storage.setItem(newVerifier, v);
        if (storage.getItem(newVerifier) === v) storage.removeItem(`${from}-code-verifier`);
        break;
      }
    }
    if (storage.getItem(SESSION_STORAGE_KEY) !== null) return null;
    for (const from of candidates) {
      const raw = storage.getItem(from);
      if (!looksLikeSession(raw)) continue;
      storage.setItem(SESSION_STORAGE_KEY, raw);
      // Only remove the old copy once the new one reads back: a write that
      // silently failed (storage full) must not cost the person the session.
      if (storage.getItem(SESSION_STORAGE_KEY) !== raw) return null;
      storage.removeItem(from);
      return from;
    }
  } catch {
    /* storage unavailable: nothing to move */
  }
  return null;
}
