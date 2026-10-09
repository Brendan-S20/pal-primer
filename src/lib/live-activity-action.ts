// What the lock screen's Start button may do, and how the server decides
// whether a press is allowed.
//
// The buttons on the route's Live Activity run an App Intent in the iPhone
// app's process, in the background, with no web view (ios/App/App/
// LiveActivity/RouteActivityIntents.swift). It cannot use the tech's Supabase
// session and must never be given one. What it holds instead is an ACTION
// TOKEN, minted by the signed-in app when the route goes on the lock screen
// and kept in the iPhone's keychain, which the hook at
// /api/public/hooks/live-activity-action trades for exactly one transition on
// exactly one stop.
//
// Complete is not one of them. It opens the app on the stop, into the photo
// capture when a photo is what the visit needs: a completion fans out to the
// customer (email, portal push, the review text) through gates that read the
// tech's own session, and the supabase migration
// 20261008150000_the-lock-screen-starts-the-stop.sql says why that stays in
// the app.
//
// Everything here is pure, so the rules are tested without a database
// (tests/the-lock-screen-starts-the-stop.test.ts): the token's shape, how
// long it lives, whether a token may act on a visit, and whether the visit is
// in a state Start can move it from. The server half, with the database, is
// src/lib/live-activity-action.server.ts.

/** Where the intent posts. Relative to the origin the app was loaded from. */
export const LIVE_ACTIVITY_ACTION_PATH = "/api/public/hooks/live-activity-action";

/** 32 random bytes, base64url: always 43 characters. */
export const ACTION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** The most a token may ever live, whatever the workday says. */
export const ACTION_TOKEN_MAX_MS = 16 * 60 * 60 * 1000;
/** A tech who runs past the workday's end keeps the button this much longer. */
export const ACTION_TOKEN_GRACE_MS = 2 * 60 * 60 * 1000;
/** A token minted after the workday (and its grace) still lives this long,
 *  so a late stop is not refused the moment the route goes on the screen.
 *  The app mints a fresh one whenever it next updates the route. */
export const ACTION_TOKEN_FLOOR_MS = 60 * 60 * 1000;
/** Mint again when the one held has less than this left. */
export const ACTION_TOKEN_REFRESH_MS = 30 * 60 * 1000;

/** Presses per token in any one minute. A tech presses one button a few
 *  times an hour; anything near this is a stuck loop or a stolen token. */
export const ACTION_RATE_PER_MINUTE = 6;

/** What a lock-screen press may do. One entry, on purpose. */
export const LOCK_SCREEN_ACTIONS = ["start"] as const;
export type LockScreenAction = (typeof LOCK_SCREEN_ACTIONS)[number];

export function isLockScreenAction(v: unknown): v is LockScreenAction {
  return typeof v === "string" && (LOCK_SCREEN_ACTIONS as readonly string[]).includes(v);
}

/** The instant a wall-clock time on an org-local day happens, in that org's
 *  zone. "2026-10-08" at "17:00:00" in America/Chicago is 22:00Z. */
export function orgWallClockInstant(day: string, time: string, tz: string): Date {
  const [y, mo, d] = day.split("-").map(Number);
  const [h, mi, s] = time.split(":").map((x) => Number(x) || 0);
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const offset = (at: number) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(at));
    const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - at;
  };
  // Twice, so a guess on the far side of a DST change settles.
  let at = guess - offset(guess);
  at = guess - offset(at);
  return new Date(at);
}

/**
 * When a token minted now expires: the end of the org's workday on the route
 * day plus the grace, but never more than sixteen hours from now and never
 * less than an hour.
 */
export function actionTokenExpiry(opts: {
  now: Date;
  routeDate: string;
  tz: string;
  /** organizations.workday_end, "17:00:00". Null or bad falls back to 17:00. */
  workdayEnd: string | null | undefined;
}): Date {
  const end = /^\d{1,2}:\d{2}(:\d{2})?$/.test(opts.workdayEnd ?? "")
    ? opts.workdayEnd!
    : "17:00:00";
  const workday =
    orgWallClockInstant(opts.routeDate, end, opts.tz).getTime() + ACTION_TOKEN_GRACE_MS;
  const now = opts.now.getTime();
  const at = Math.min(now + ACTION_TOKEN_MAX_MS, Math.max(workday, now + ACTION_TOKEN_FLOOR_MS));
  return new Date(at);
}

// ── the decisions the hook makes, in order ──────────────────────────────────

export type ActionTokenRow = {
  id: string;
  user_id: string;
  organization_id: string;
  staff_id: string;
  route_date: string;
  locale: string;
  expires_at: string;
  revoked_at: string | null;
};

export type ActionVisitRow = {
  id: string;
  organization_id: string;
  assigned_staff_id: string | null;
  scheduled_on: string;
  status: string;
};

/** Why a press was refused. Each maps to one HTTP status in the hook, and the
 *  intent treats every one of them the same way: open the app on the stop. */
export type ActionRefusal =
  | "bad_request"
  | "unknown_token"
  | "revoked"
  | "expired"
  | "rate_limited"
  | "not_your_stop"
  | "not_startable";

export const REFUSAL_STATUS: Record<ActionRefusal, number> = {
  bad_request: 400,
  // One status for every way a token can be wrong, so the answer does not
  // say whether a guessed token ever existed.
  unknown_token: 401,
  revoked: 401,
  expired: 401,
  rate_limited: 429,
  // A visit that is not on this token's route is answered as if it did not
  // exist, whoever's it is.
  not_your_stop: 404,
  not_startable: 409,
};

/** Is this token good right now. */
export function checkActionToken(
  row: ActionTokenRow | null | undefined,
  now: Date,
): ActionRefusal | null {
  if (!row) return "unknown_token";
  if (row.revoked_at) return "revoked";
  if (new Date(row.expires_at).getTime() <= now.getTime()) return "expired";
  return null;
}

/** Is this visit on the route the token was minted for: the same business,
 *  the same technician, the same day. */
export function checkActionScope(
  token: Pick<ActionTokenRow, "organization_id" | "staff_id" | "route_date">,
  visit: ActionVisitRow | null | undefined,
): ActionRefusal | null {
  if (!visit) return "not_your_stop";
  if (visit.organization_id !== token.organization_id) return "not_your_stop";
  if (!visit.assigned_staff_id || visit.assigned_staff_id !== token.staff_id)
    return "not_your_stop";
  if (visit.scheduled_on !== token.route_date) return "not_your_stop";
  return null;
}

/**
 * Can Start move the visit from where it is: a scheduled stop starts, and one
 * already under way is "already", which is what a second tap, or a card that
 * had not caught up, finds. Anything else (done, skipped, missed, canceled)
 * is refused, and the intent opens the app on the stop instead.
 */
export function checkActionState(
  status: string,
): { refusal: ActionRefusal } | { already: boolean } {
  if (status === "scheduled") return { already: false };
  if (status === "in_progress") return { already: true };
  return { refusal: "not_startable" };
}

export function rateLimited(pressesInLastMinute: number): boolean {
  return pressesInLastMinute >= ACTION_RATE_PER_MINUTE;
}
