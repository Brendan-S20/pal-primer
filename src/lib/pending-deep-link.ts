// A link that opened the app, held until the app knows who is signed in.
//
// On a cold start the app boots at `/`, routes/index.tsx sends that to
// /auth, and /auth's landing effect sends a signed-in user to their role's
// page. A tapped link (an Android App Link, or the iPhone Live Activity's
// consulting.thenorth.houndstack://open/my-day?...) arrives as appUrlOpen in
// the middle of all that. Pushed straight away, it lost to one of two
// things: the router's own first redirect to /auth, which finished after the
// push, or /auth's landing navigate, which ran after the guard bounced the
// link back to /auth while the session was still being read. Either way the
// person landed on My Day or the dashboard, not on what they tapped (#621).
//
// So the link is held here instead of pushed, and delivered by whichever
// comes first:
//
//   - the app is already past sign-in (a warm app): routeDeepLink pushes it
//     once the router is idle;
//   - /auth decides where a signed-in person lands: it takes the held link
//     and goes there instead of the role landing (src/routes/auth.tsx).
//
// A page that does not need a session (an invitation) never waits for /auth:
// it is pushed once the router is idle, signed in or not.

let held: string | null = null;

/** Hold a link until something can deliver it. A bare `/` is "open the
 *  app", not a target, so it is not held. A later link replaces an earlier
 *  one: the last tap is the one the person meant. */
export function holdDeepLink(path: string): void {
  if (!path || path === "/") return;
  held = path;
}

/** The held link, cleared, or null when there is none. */
export function takeDeepLink(): string | null {
  const path = held;
  held = null;
  return path;
}

/** The held link, left in place. */
export function peekDeepLink(): string | null {
  return held;
}

/** Pages a link may open without anyone signed in. Each handles a missing
 *  session itself. */
const NEEDS_NO_SESSION = ["/invite/"];

export function needsSession(path: string): boolean {
  return !NEEDS_NO_SESSION.some((p) => path.startsWith(p));
}

/** The screens a launch passes through before it knows who is signed in. A
 *  link that needs a session waits on these for /auth to deliver it. */
const LANDING_PATHS = ["/", "/auth"];

export interface DeepLinkEnv {
  /** The router's current pathname. */
  pathname: () => string;
  /** Resolves when the router has no navigation in flight. */
  idle: () => Promise<void>;
  /** Go to an in-app path (with its search and hash). */
  push: (path: string) => void;
}

/**
 * What the appUrlOpen listener does with a link. Holds it, waits for the
 * router to settle (on a cold start, its first redirect to /auth), then
 * either pushes it or leaves it for /auth.
 */
export async function routeDeepLink(path: string, env: DeepLinkEnv): Promise<void> {
  holdDeepLink(path);
  await env.idle();
  const next = peekDeepLink();
  if (!next) return; // /auth took it while the router settled
  if (needsSession(next) && LANDING_PATHS.includes(env.pathname())) return;
  takeDeepLink();
  env.push(next);
}

/** Tests only. */
export function __resetDeepLinkForTests(): void {
  held = null;
}
