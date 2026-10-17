// Who is signed in, answered without a network when there isn't one.
//
// ── WHY THIS MOVED OUT OF THE ROUTE FILE ──────────────────────────────────
//
// This logic lived inline in `_authenticated/route.tsx`, which meant only the
// authenticated tree could use it. `/auth` could not, and `/auth` is the screen
// a cold native launch actually lands on: the app boots at
// `capacitor://localhost/`, `routes/index.tsx` redirects `/` to `/auth`
// unconditionally, and `/auth` then decides whether to send an already
// signed-in user onward.
//
// It made that decision with a bare `supabase.auth.getUser()` — a NETWORK
// call — and returned early when it failed. So on a cold launch with no signal
// a signed-in tech was left sitting on a sign-in form, holding a valid session
// that was still on the device, unable to submit the form because submitting
// needs the network they do not have. iOS QA 2026-08-20 reproduced exactly
// that: Wi-Fi off, kill, relaunch, and the app renders `/auth` while the
// Supabase session and `hs:offline-reads:*` are both still in localStorage.
//
// Both callers now share this, so the two can never drift into disagreeing
// about who is signed in — which is the state that produced the sign-in wall.
//
// ── WHY IT DOES NOT ASK navigator.onLine ──────────────────────────────────
//
// `lib/offline/connectivity.ts` exists because that property is not refreshed
// reliably in a WKWebView: an app suspended through a dead zone can resume
// reporting `onLine === true` against no connection at all. `isDefinitelyOffline`
// ORs in what @capacitor/network actually says about the interface, so it can
// only ever return true in MORE cases, never fewer.
//
// ── WHY EVERY CALL IS BOUNDED ─────────────────────────────────────────────
//
// `lib/offline/action-owner.ts` already documents the trap: `getSession()`
// reads local storage EXCEPT when the stored access token has expired, in
// which case supabase-js refreshes it over the network first — and offline
// that request hangs. This runs on the boot path of every launch, so an
// unbounded hang here is a permanently blank app rather than a slow one. Both
// calls therefore have a deadline, and a deadline that expires is read as
// "could not ask", never as "the answer was no".

import type { User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { readLastUser } from "@/lib/offline/read-cache";
import { isOfflineAuthFailure } from "@/lib/offline/read-cache-policy";
import { isDefinitelyOffline } from "@/lib/offline/connectivity";
import { withDeadline, ActionTimeout } from "@/lib/offline/run-or-queue";
import { IS_NATIVE_BUNDLE } from "@/lib/native-build";

/** `rejected` distinguishes "the server said no" from "we could not ask".
 *  Only the first should wipe the device — wiping on the second would delete
 *  the tech's day every time they open the app in a dead zone, which is the
 *  case this whole feature exists for. */
export type IdentityResult =
  | { ok: true; userId: string; user: User | null }
  /** True only when the auth server actually answered and the answer was no. */
  | { ok: false; rejected: boolean };

/** getUser() is a round trip. Long enough for a slow cell connection to
 *  answer, short enough that a launch in a dead zone is not a blank screen. */
export const IDENTITY_DEADLINE_MS = 4_000;

/** getSession() is a local read in every case that matters; waiting longer is
 *  waiting on a token refresh that cannot succeed. Same second
 *  `resolveOfflineUserId` allows itself, for the same reason. */
export const SESSION_DEADLINE_MS = 1_000;

/**
 * How long a "yes" from the auth server is taken as still true without asking
 * again. On BOTH builds, deliberately (see the note inside resolveIdentity on
 * why the rest of this file's differences are native-only).
 *
 * resolveIdentity() is the _authenticated route's beforeLoad, and the router
 * runs every matched route's beforeLoad on EVERY navigation and on every
 * intent preload (a touchstart on a link). So until 2026-10-08 every tab tap,
 * every tap into a client, and every thumb that came to rest on a list of
 * links while scrolling it, made a round trip to the auth server before
 * anything could change on the screen: the 100-300ms of a cell connection,
 * and on one bar up to IDENTITY_DEADLINE_MS, on every single navigation. That
 * wait, and not the animation after it, is most of what a person calls an
 * app "not smooth", and the laptop in the evening paid it as well as the
 * phone in the driveway.
 *
 * Nothing about it was protection. Every server function verifies the token
 * itself (auth-middleware.ts, getClaims), so a session the server would
 * refuse is refused there whatever this says. What this answer decides is
 * only whether to draw the signed-in shell or the sign-in screen, and asking
 * once every few minutes decides that as well as asking on every tap.
 *
 * The reuse ends at once when the signed-in user changes or signs out
 * (watchSignedInUser below), so a sign-out or a switch of account is never
 * answered from here.
 */
export const IDENTITY_REUSE_MS = 5 * 60_000;

let verified: { userId: string; user: User; at: number } | null = null;
let watching = false;

/** Reuse the shell's verified user while the identity answer is fresh. */
export function getVerifiedUser(): User | null {
  return verified && Date.now() - verified.at < IDENTITY_REUSE_MS ? verified.user : null;
}

/** Forget the reused answer the moment the session says someone else, or
 *  nobody, is signed in. Subscribed on the first verified answer rather than
 *  at import, so importing this module has no side effect. */
function watchSignedInUser() {
  if (watching) return;
  watching = true;
  supabase.auth.onAuthStateChange((event, session) => {
    if (
      !session ||
      event === "SIGNED_OUT" ||
      event === "USER_UPDATED" ||
      session.user.id !== verified?.userId
    ) {
      verified = null;
    }
  });
}

/** For tests, and for any path that wants the next check to ask. */
export function forgetVerifiedIdentity() {
  verified = null;
}

/**
 * Who is signed in, tolerating a dead connection.
 *
 * The fallbacks only ever apply when the failure looks like a lost network
 * (never a 4xx from the auth server), and they grant nothing but a read of data
 * already on this device; every server call still needs a real token.
 */
export async function resolveIdentity(): Promise<IdentityResult> {
  // NATIVE ONLY, both of the differences below. On the hosted app this function
  // behaves exactly as the copy that used to live in _authenticated/route.tsx:
  // navigator.onLine, and no deadlines. A browser tab that has lost the network
  // is a tab that cannot have loaded this page in the first place, so neither
  // the stale-onLine problem nor the hanging-refresh problem exists there — and
  // `main` deploys straight to app.houndstack.com, so changing the live sign-in
  // path is not something an iOS pass gets to do as a side effect.
  //
  // The reuse just below is the exception, made on purpose for both builds:
  // see IDENTITY_REUSE_MS.
  if (verified && Date.now() - verified.at < IDENTITY_REUSE_MS) {
    return { ok: true, userId: verified.userId, user: verified.user };
  }

  const online = IS_NATIVE_BUNDLE
    ? !isDefinitelyOffline()
    : typeof navigator === "undefined" || navigator.onLine !== false;

  let authError: unknown = null;
  try {
    const getUser = supabase.auth.getUser();
    const { data, error } = await (IS_NATIVE_BUNDLE
      ? withDeadline(getUser, IDENTITY_DEADLINE_MS, "auth.getUser")
      : getUser);
    if (data?.user) {
      verified = { userId: data.user.id, user: data.user, at: Date.now() };
      watchSignedInUser();
      return { ok: true, userId: data.user.id, user: data.user };
    }
    authError = error;
  } catch (e) {
    authError = e;
  }

  // A deadline that expired is definitionally "we could not ask". Checked
  // before isOfflineAuthFailure because an ActionTimeout carries no status and
  // its message says nothing about the network, so the text matching in there
  // would fall through to the `online` flag and could call it a rejection.
  const timedOut = authError instanceof ActionTimeout;

  // Not a transport failure: the server answered, and the answer was no.
  if (!timedOut && !isOfflineAuthFailure(authError, { online })) {
    return { ok: false, rejected: true };
  }

  // Local read of the persisted session — no network, still authoritative
  // about which account this device belongs to.
  try {
    const getSession = supabase.auth.getSession();
    const { data } = await (IS_NATIVE_BUNDLE
      ? withDeadline(getSession, SESSION_DEADLINE_MS, "auth.getSession")
      : getSession);
    if (data.session?.user) {
      return { ok: true, userId: data.session.user.id, user: data.session.user };
    }
  } catch {
    /* fall through to the pointer below */
  }

  // The access token expired overnight and cannot be refreshed without a
  // network: exactly the 7am-in-a-dead-zone case this feature exists for.
  // The pointer is written only on a verified sign-in and deleted on sign-out,
  // so it can only name a user whose session is still on this device.
  const lastUser = readLastUser();
  return lastUser ? { ok: true, userId: lastUser, user: null } : { ok: false, rejected: false };
}
