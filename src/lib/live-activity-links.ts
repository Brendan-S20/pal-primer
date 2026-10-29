// The links the route on the lock screen opens the app with.
//
// The Live Activity's Start and Complete buttons, and a tap anywhere else on
// the card, do not DO anything from the lock screen. Completing a stop can
// need a photo, a checklist or a cash entry, and starting one stamps the
// visit's time; none of that should happen from a pocket. They open the app
// on the stop instead, through the app's own URL scheme (Info.plist
// CFBundleURLTypes), built in ios/App/RouteActivity/RouteLiveActivity.swift:
//
//   consulting.thenorth.houndstack://open/my-day?date=2026-10-07&visit=<uuid>&action=start
//
// iOS hands that to SceneDelegate, Capacitor's App plugin raises appUrlOpen,
// and initAppLinks (src/lib/native.ts) asks this file what to do with it.
// My Day then scrolls to the stop and puts the tech's thumb on the button
// (src/components/my-day/use-live-activity-action.ts).
//
// Everything about the incoming URL is checked and nothing is passed through:
// the path is rebuilt from the three values this file recognises, each one
// validated, so a link can only ever land on /my-day, and only with an action
// on the allowlist. The OAuth hand-back on the same scheme
// (consulting.thenorth.houndstack://auth-callback, src/lib/native-oauth.ts)
// is a different host and is never matched here.

/** The app's URL scheme: capacitor.config.ts appId, and Info.plist. */
export const APP_URL_SCHEME = "consulting.thenorth.houndstack";
/** The host the Live Activity's links use. auth-callback is the OAuth one. */
export const LIVE_ACTIVITY_LINK_HOST = "open";
/** The one page a lock-screen link may open. */
export const LIVE_ACTIVITY_LINK_PATH = "/my-day";
/** What a link may ask My Day to do. Each OPENS a button; none presses it. */
export const LIVE_ACTIVITY_ACTIONS = ["start", "complete"] as const;
export type LiveActivityAction = (typeof LIVE_ACTIVITY_ACTIONS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function isLiveActivityAction(v: unknown): v is LiveActivityAction {
  return typeof v === "string" && (LIVE_ACTIVITY_ACTIONS as readonly string[]).includes(v);
}

/**
 * The in-app path for a link from the Live Activity, or null when the URL is
 * not one. A visit id that is not a UUID, a day that is not a day, and an
 * action not on the allowlist are each dropped, not passed on: the link still
 * opens My Day, just without the part that did not check out.
 */
export function liveActivityLinkTarget(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== `${APP_URL_SCHEME}:`) return null;
  if (u.host !== LIVE_ACTIVITY_LINK_HOST) return null;
  if (u.username || u.password || u.port) return null;
  if (u.pathname !== LIVE_ACTIVITY_LINK_PATH) return null;

  const out = new URLSearchParams();
  const date = u.searchParams.get("date");
  if (date && DAY.test(date) && !Number.isNaN(new Date(date).getTime())) out.set("date", date);
  const visit = u.searchParams.get("visit");
  if (visit && UUID.test(visit)) {
    out.set("visit", visit.toLowerCase());
    // An action is about a stop; without one there is nothing to open.
    const action = u.searchParams.get("action");
    if (isLiveActivityAction(action)) out.set("action", action);
  }
  const q = out.toString();
  return q ? `${LIVE_ACTIVITY_LINK_PATH}?${q}` : LIVE_ACTIVITY_LINK_PATH;
}
