// A save whose session has gone (R2-19, #659).
//
// Every server function behind requireSupabaseAuth refuses a request with no
// usable session by throwing "Unauthorized: ...". Settings -> Users caught
// that and showed it as a raw error, or for the address Save, showed it and
// threw the typed addresses away on the way to /auth -- and /auth then sent
// the person to their role's landing page, not back to the page they were on.
//
// So: say what happened in words ("You've been signed out"), keep what they
// typed in sessionStorage (this tab only, gone when the tab closes), and hold
// the page with lib/pending-deep-link.ts, which /auth already delivers after
// sign-in. Nothing new on /auth: it reuses the hold it has for app links.

import { holdReturnPath } from "@/lib/pending-deep-link";

export const SIGNED_OUT_MESSAGE =
  "You've been signed out. Sign in again to save. What you typed is kept, and you'll come back here.";

/** True for the refusal requireSupabaseAuth throws when there is no session. */
export function isSignedOutError(e: unknown): boolean {
  const message =
    e instanceof Error
      ? e.message
      : typeof e === "string"
        ? e
        : (e as { message?: unknown })?.message;
  return typeof message === "string" && message.startsWith("Unauthorized");
}

/** Remember the page so /auth returns to it after sign-in. A path, never a
 *  full URL or /auth itself, and nothing while a sign-out is under way
 *  (#785, lib/pending-deep-link.ts). */
export function returnHereAfterSignIn(path: string): void {
  holdReturnPath(path);
}

const DRAFT_PREFIX = "houndstack.draft.";

function store(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function keepDraft(key: string, value: unknown): void {
  try {
    store()?.setItem(DRAFT_PREFIX + key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the toast still says what happened.
  }
}

export function readDraft<T>(key: string): T | null {
  try {
    const raw = store()?.getItem(DRAFT_PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function forgetDraft(key: string): void {
  try {
    store()?.removeItem(DRAFT_PREFIX + key);
  } catch {
    // Nothing to do.
  }
}
