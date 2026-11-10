// A sign-in that was accepted and then came back to /auth must say so (#785).
//
// /auth hands a signed-in person to the router, and from there it is the
// _authenticated guard's call. When the guard says no, it redirects to /auth,
// and until #785 that arrival looked exactly like a first visit: no error, and
// (when the page was drawn afresh) the email step, empty. Onboarding QA on
// 2026-11-09, in an isolated Incognito window: a known-good owner password,
// submitted once, "returned to the initial email page with no visible error";
// the same password worked on the retry. A new owner reads that as "wrong
// password" or "my account is broken", and some of them stop there.
//
// The cause of the refusal itself is fixed where it starts
// (lib/offline/identity.ts, trustFreshSignIn). This is the floor under every
// other cause, present or future: whatever bounced the sign-in, the person
// lands back on the password step with their email, their password and a
// sentence that says what happened.
//
// ── WHAT IS KEPT WHERE ────────────────────────────────────────────────────
//
// The EMAIL goes in this tab's sessionStorage, so it survives a full reload of
// /auth as well as a redirect. The PASSWORD never touches storage: it is held
// in this module's memory, which is the same JavaScript heap the form's own
// state already holds it in, and only until the handoff is taken, lands or
// expires. A reload loses it, and the person types it once more; the error
// still says why.

export const SIGN_IN_HANDOFF_KEY = "hs:sign-in-handoff";

/** Fired on window when a sign-in that /auth handed on resolved back at /auth. */
export const SIGN_IN_BOUNCED = "hs:sign-in-bounced";

/** A redirect back happens within seconds of the hand-off. Long enough for a
 *  slow bootstrap on a cell connection; short enough that a sign-out minutes
 *  later is never mistaken for one. */
export const SIGN_IN_HANDOFF_TTL_MS = 60_000;

export const SIGN_IN_BOUNCED_MESSAGE =
  "Your password was accepted, but we couldn't finish signing you in. Press Sign in to try again.";

type Stored = { email: string; at: number };

let heldPassword: string | null = null;

function store(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** /auth calls this after a password was accepted, just before handing on. */
export function handOffSignIn(email: string, password: string, now = Date.now()): void {
  heldPassword = password;
  try {
    store()?.setItem(SIGN_IN_HANDOFF_KEY, JSON.stringify({ email, at: now } satisfies Stored));
  } catch {
    /* storage blocked: the in-memory half still covers a redirect */
  }
}

/** The sign-in got where it was going, or the person is signed in anyway. */
export function signInLanded(): void {
  heldPassword = null;
  try {
    store()?.removeItem(SIGN_IN_HANDOFF_KEY);
  } catch {
    /* nothing to clear */
  }
}

/**
 * The handed-off sign-in, cleared, if it is recent: what /auth puts back on
 * the form when it finds itself showing a signed-out page after one.
 */
export function takeBouncedSignIn(now = Date.now()): { email: string; password: string } | null {
  let parsed: Stored | null = null;
  try {
    const raw = store()?.getItem(SIGN_IN_HANDOFF_KEY);
    parsed = raw ? (JSON.parse(raw) as Stored) : null;
  } catch {
    parsed = null;
  }
  const password = heldPassword ?? "";
  signInLanded();
  if (!parsed || typeof parsed.email !== "string" || typeof parsed.at !== "number") return null;
  if (now - parsed.at > SIGN_IN_HANDOFF_TTL_MS || now < parsed.at) return null;
  return { email: parsed.email, password };
}

/** The slice of the router this needs: TanStack's `router.subscribe`. */
export type ResolvedSubscribe = (
  event: "onResolved",
  fn: (e: { toLocation: { pathname: string } }) => void,
) => () => void;

/**
 * Watch the ONE navigation a sign-in starts. Where it resolves decides it: on
 * /auth, the guard sent the person back, and the page is told; anywhere else,
 * they arrived, and the handoff is dropped. Not tied to the /auth component,
 * which unmounts on a successful landing and may be drawn afresh on a bounce.
 */
export function watchSignInLanding(
  subscribe: ResolvedSubscribe,
  target: Pick<Window, "dispatchEvent"> | null = typeof window === "undefined" ? null : window,
): () => void {
  let stop: (() => void) | null = null;
  let done = false;
  stop = subscribe("onResolved", (e) => {
    if (done) return;
    done = true;
    stop?.();
    if (e.toLocation.pathname === "/auth") target?.dispatchEvent(new Event(SIGN_IN_BOUNCED));
    else signInLanded();
  });
  if (done) stop();
  return () => {
    done = true;
    stop?.();
  };
}
