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
//
// None of that helped on a real phone until the link reached the root at all:
// Capacitor hands a cold-start link to the first appUrlOpen listener only, and
// /auth's OAuth listener used to be first and drop it. See lib/app-url-open.ts.

import { takeWaitingAppUrl } from "@/lib/app-url-open";

/** A link older than this is not what the person is doing now. It covers a
 *  link held through onboarding or a long wait on the sign-in form, which a
 *  much later landing would otherwise deliver out of nowhere. */
export const DEEP_LINK_TTL_MS = 10 * 60_000;

let held: { path: string; at: number } | null = null;
/** /auth has already sent this session on. A link arriving after that, while
 *  the router still reads /auth, has nobody left to take it, so it is pushed. */
let landed = false;

/** Hold a link until something can deliver it. A bare `/` is "open the
 *  app", not a target, so it is not held. A later link replaces an earlier
 *  one: the last tap is the one the person meant. */
export function holdDeepLink(path: string, now = Date.now()): void {
  const inApp = inAppPath(path);
  if (!inApp) return;
  held = { path: inApp, at: now };
}

/**
 * The in-app path a link names, or null when it names nothing worth holding.
 *
 * Delivered with `router.history.push`, which takes a PATH: a full URL there
 * is pushed as a path segment and draws a not-found page. And /auth is never
 * a destination: holding it sends a person who has just signed in straight
 * back to the sign-in form, which is the #785 screen with no error on it.
 * Bare `/` is "open the app", not a target.
 */
export function inAppPath(link: string): string | null {
  if (!link) return null;
  let path = link;
  if (/^[a-z][a-z0-9+.-]*:/i.test(link) || link.startsWith("//")) {
    try {
      const base = typeof window === "undefined" ? undefined : window.location?.origin;
      const url = new URL(link, base);
      if (base && url.origin !== base) return null;
      path = url.pathname + url.search + url.hash;
    } catch {
      return null;
    }
  }
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  const pathname = path.split(/[?#]/)[0];
  if (pathname === "/" || pathname === "" || pathname === "/auth" || pathname.startsWith("/auth/"))
    return null;
  return path;
}

/** A sign-out on purpose is under way or done, and nobody has signed in
 *  since: the page being left belongs to the session that ended (#785). */
let signingOut = false;

/** The guard's, and a save's, "come back here after sign-in" (#659): an
 *  in-app path, never /auth, and nothing while a sign-out is under way. A
 *  tapped app link goes through holdDeepLink and is still held. */
export function holdReturnPath(path: string, now = Date.now()): void {
  if (signingOut) return;
  holdDeepLink(path, now);
}

/** An intentional sign-out starts: drop any held link, and hold no return
 *  path until somebody signs in. */
export function beginSignOut(): void {
  forgetDeepLink();
  signingOut = true;
}

/** A password was accepted, or /auth found a session: the guard may hold a
 *  page again. */
export function signedInAgain(): void {
  signingOut = false;
}

/** The held link, left in place, or null when there is none or it is stale. */
export function peekDeepLink(now = Date.now()): string | null {
  if (held && now - held.at > DEEP_LINK_TTL_MS) held = null;
  return held?.path ?? null;
}

/** The held link, cleared, or null when there is none or it is stale. */
export function takeDeepLink(now = Date.now()): string | null {
  const path = peekDeepLink(now);
  held = null;
  return path;
}

/** /auth calls this when it sends a signed-in person on. */
export function markLanded(): void {
  landed = true;
}

/**
 * /auth is sending a signed-in person on: the link they tapped, if there is
 * one, or null for their role landing. Two places a link can be waiting:
 * held here by the root, or still in lib/app-url-open.ts because it reached
 * the app's one appUrlOpen listener before the root subscribed. On a cold
 * start the second is the usual case, since /auth subscribes (for the OAuth
 * hand-back) several imports ahead of the root (#621).
 */
export function takeLinkForLanding(now = Date.now()): string | null {
  markLanded();
  const link = takeDeepLink(now) ?? takeWaitingAppUrl("path");
  return link ? inAppPath(link) : null;
}

/** Sign-out: a held link belongs to the person who tapped it, not to the
 *  next account that signs in on this phone, and the next landing is a new
 *  one. */
export function forgetDeepLink(): void {
  held = null;
  landed = false;
}

/** Pages a link may open without anyone signed in. Each handles a missing
 *  session itself. */
const NEEDS_NO_SESSION = [
  "/invite/",
  // A recovery link is the way back in for somebody who cannot sign in; it
  // brings its own session, and /auth must not land it first.
  "/reset-password",
];

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
  if (!landed && needsSession(next) && LANDING_PATHS.includes(env.pathname())) return;
  takeDeepLink();
  env.push(next);
}

/** Tests only. */
export function __resetDeepLinkForTests(): void {
  forgetDeepLink();
  signingOut = false;
}
