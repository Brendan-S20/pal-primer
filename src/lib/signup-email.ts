/**
 * The address typed on /auth (or carried by a /sign-up?email= link), handed
 * to /get-started without riding in the URL (#651).
 *
 * It used to be `/get-started?email=…&invite=…`, which put a person's email
 * in browser history, in referrer headers and in every analytics hit for the
 * page. sessionStorage is per tab and gone when the tab closes, which is the
 * whole lifetime this hand-off needs. Read once, then removed.
 */
const KEY = "hs.signup-email";

export function handOffSignupEmail(email: string | null | undefined): void {
  const value = (email ?? "").trim();
  if (!value || typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(KEY, value);
  } catch {
    // Private mode or storage off: the person types it again. Never fatal.
  }
}

export function takeSignupEmail(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.sessionStorage.getItem(KEY);
    window.sessionStorage.removeItem(KEY);
    return value && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}
