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

/** An intentional sign-out is under way, or finished, and nobody has signed
 *  in since. The guard must not hold the page it is being signed out of
 *  (#785): that page belongs to the session that just ended. */
let signingOut = false;

/**
 * A link as an in-app PATH (with its search and hash), or null. Never a full
 * URL: `/auth` delivers a hold with `router.history.push`, which takes a
 * path, and the _authenticated guard used to hold `location.href` (#785). A
 * URL on this page's own origin is reduced to its path; any other origin is
 * not ours to open.
 */
export function asAppPath(link: string): string | null {
  if (typeof link !== "string") return null;
  const raw = link.trim();
  if (!raw) return null;
  if (raw.startsWith("/") && !raw.startsWith("//")) return raw;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const here = typeof window === "undefined" ? null : (window.location?.origin ?? null);
  if (!here || url.origin !== here) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** A page to come back to after sign-in: an in-app path that is not the
 *  sign-in form itself. Holding /auth sends a person who just signed in back
 *  to the form (#785). */
export function asReturnPath(link: string): string | null {
  const path = asAppPath(link);
  if (!path) return null;
  const pathname = path.split(/[?#]/, 1)[0];
  if (pathname === "/auth" || pathname.startsWith("/auth/")) return null;
  return path;
}

/** Hold a link until something can deliver it. A bare `/` is "open the
 *  app", not a target, so it is not held. A later link replaces an earlier
 *  one: the last tap is the one the person meant. Only a path is ever held. */
export function holdDeepLink(path: string, now = Date.now()): void {
  const normalized = asAppPath(path);
  if (!normalized || normalized === "/") return;
  held = { path: normalized, at: now };
}

/** The guard's and a save's "come back here after sign-in" (#659). Refused
 *  while an intentional sign-out is under way: the page being left is not
 *  where the next sign-in should go. A tapped app link is not refused (it
 *  goes through holdDeepLink directly): the person meant it. */
export function holdReturnPath(path: string, now = Date.now()): void {
  if (signingOut) return;
  const normalized = asReturnPath(path);
  if (normalized) holdDeepLink(normalized, now);
}

/** An intentional sign-out starts: drop any held return path, and do not
 *  take a new one until somebody signs in (#785). */
export function beginSignOut(): void {
  forgetDeepLink();
  signingOut = true;
}

/** A password was accepted, or /auth found a session: the guard may hold
 *  pages again. */
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
  return takeDeepLink(now) ?? takeWaitingAppUrl("path");
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
