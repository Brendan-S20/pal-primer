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

/** The sign-in is over one way or the other: the person is signed in and
 *  /auth sent them on, or they signed out on purpose. Clears the hand-off and
 *  the step the form was on. */
export function signInLanded(): void {
  heldPassword = null;
  try {
    store()?.removeItem(SIGN_IN_HANDOFF_KEY);
  } catch {
    /* nothing to clear */
  }
  forgetSignInStep();
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

// ── THE STEP THE FORM IS ON ─────────────────────────────────────────────────
//
// /auth is two steps, and the second exists only in React state. Anything
// that draws the page afresh (the router swapping in its pending skeleton
// for a slow navigation and back, an error boundary resetting, a reload)
// used to put the person on an empty email step with no word of why, which
// is the screen #785 keeps being filed about. So the email that got them to
// the password step is kept in this tab's sessionStorage (never the
// password) until they leave the form one way or the other.

export const SIGN_IN_STEP_KEY = "hs:sign-in-step";

/** Long enough to cover a person reading their password manager; short
 *  enough that tomorrow's visit starts on a clean form. */
export const SIGN_IN_STEP_TTL_MS = 10 * 60_000;

/** /auth calls this when Continue takes the person to the password step. */
export function rememberSignInStep(email: string, now = Date.now()): void {
  try {
    store()?.setItem(SIGN_IN_STEP_KEY, JSON.stringify({ email, at: now } satisfies Stored));
  } catch {
    /* storage blocked: a redraw costs the step, as it did before */
  }
}

/** The email of a password step the form was on, if recent. Left in place:
 *  the person is still on that step until they leave it. */
export function readSignInStep(now = Date.now()): string | null {
  try {
    const raw = store()?.getItem(SIGN_IN_STEP_KEY);
    const parsed = raw ? (JSON.parse(raw) as Stored) : null;
    if (!parsed || typeof parsed.email !== "string" || typeof parsed.at !== "number") return null;
    if (now - parsed.at > SIGN_IN_STEP_TTL_MS || now < parsed.at) {
      forgetSignInStep();
      return null;
    }
    return parsed.email;
  } catch {
    return null;
  }
}

/** "Use a different email", a sign-in that landed, or a sign-out. */
export function forgetSignInStep(): void {
  try {
    store()?.removeItem(SIGN_IN_STEP_KEY);
  } catch {
    /* nothing to clear */
  }
}

/** The slice of the router this needs: TanStack's `router.subscribe`. */
export type ResolvedSubscribe = (
  event: "onResolved",
  fn: (e: { toLocation: { pathname: string } }) => void,
) => () => void;

/** The watch the latest Sign in started, if it is still running. */
let activeWatch: (() => void) | null = null;

/**
 * Watch where a sign-in ends up, for as long as a bounce could still be one.
 *
 * #799 watched only the FIRST navigation and dropped the hand-off as soon as
 * it resolved anywhere but /auth. On 2026-11-10 and 11-11 QA's first sign-in
 * landed, and the session was gone by the next navigation, which the guard
 * sent to /auth: the hand-off had already been dropped, so that /auth was a
 * blank first visit. Landing on a page is not the same as staying signed in.
 *
 * So this keeps watching for SIGN_IN_HANDOFF_TTL_MS. Any navigation that
 * resolves on /auth in that window is a bounce and the page is told; one
 * anywhere else means the person has left the form, so the remembered STEP
 * is cleared (the hand-off is not). A sign-out on purpose clears the hand-off
 * first (signOutAndClearDevice), so it is never reported as a failure. Not
 * tied to the /auth component, which unmounts on a landing and is drawn
 * afresh on a bounce.
 */
export function watchSignInLanding(
  subscribe: ResolvedSubscribe,
  target: Pick<Window, "dispatchEvent"> | null = typeof window === "undefined" ? null : window,
  ttlMs = SIGN_IN_HANDOFF_TTL_MS,
): () => void {
  let stop: (() => void) | null = null;
  let done = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const finish = () => {
    done = true;
    if (activeWatch === finish) activeWatch = null;
    if (timer) clearTimeout(timer);
    timer = null;
    stop?.();
  };
  // A second Sign in replaces the first attempt's watch rather than adding
  // to it: one sign-in, one listener.
  activeWatch?.();
  activeWatch = finish;
  stop = subscribe("onResolved", (e) => {
    if (done) return;
    if (e.toLocation.pathname === "/auth") {
      finish();
      target?.dispatchEvent(new Event(SIGN_IN_BOUNCED));
    } else {
      forgetSignInStep();
    }
  });
  if (done) stop();
  else timer = setTimeout(finish, ttlMs);
  return finish;
}

// ── WORDS FOR A FAILURE ─────────────────────────────────────────────────────
//
// supabase-js hands back whatever the failure carried as `message`. For a
// wrong password that is a sentence ("Invalid login credentials"). For a
// gateway error with an empty body it was the two characters "{}", and for no
// answer at all the browser's "Failed to fetch": both shown as they were, on
// the form, as the only explanation (#785, measured in
// tests/viewports/a-sign-in-never-resets-to-the-email-step.spec.ts).

/** What a person reads when a sign-in step fails. Keeps a real sentence from
 *  the auth server; replaces transport noise with one that says what to do. */
export function signInFailureMessage(
  error: unknown,
  doing: "sign-in" | "email-check" = "sign-in",
): string {
  const err = (error ?? {}) as { message?: unknown; status?: unknown; name?: unknown };
  const message = typeof err.message === "string" ? err.message.trim() : "";
  const status = typeof err.status === "number" ? err.status : null;
  const retry =
    doing === "sign-in"
      ? "Your email and password are still here. Press Sign in to try again."
      : "Press Continue to try again.";
  const what = doing === "sign-in" ? "sign you in" : "check that email";

  const unreachable =
    /failed to fetch|networkerror|network request failed|load failed|timed? ?out|aborted/i.test(
      message,
    ) ||
    (status === 0 && err.name === "AuthRetryableFetchError");
  if (unreachable)
    return `We couldn't reach HoundStack to ${what}. Check your connection. ${retry}`;

  const noise = !message || /^[[{(]/.test(message) || /^(undefined|null|error)$/i.test(message);
  if (noise || (status !== null && status >= 500) || err.name === "AuthRetryableFetchError") {
    return `We couldn't ${what} just now. ${retry}`;
  }
  return message;
}
