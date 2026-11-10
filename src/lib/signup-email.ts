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

/**
 * The sentence registerAccount refuses a taken address with. Shared so the
 * page can recognise it and send the person to sign in, with the address
 * filled in and a reset one tap away, instead of leaving them on an error
 * (#765). A person who was taken off a business and tries to "start again"
 * from /get-started is exactly who reads it.
 */
export const EMAIL_ALREADY_REGISTERED = "That email already has an account. Sign in instead.";

const EXISTING_KEY = "hs.existing-account-email";

/** Hand a taken address to /auth, which opens on the password step. */
export function handOffExistingAccount(email: string | null | undefined): void {
  const value = (email ?? "").trim();
  if (!value || typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(EXISTING_KEY, value);
  } catch {
    // Storage off: /auth asks for the address again. Never fatal.
  }
}

/** Read once, then removed. */
export function takeExistingAccount(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.sessionStorage.getItem(EXISTING_KEY);
    window.sessionStorage.removeItem(EXISTING_KEY);
    return value && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}
