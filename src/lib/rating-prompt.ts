// When HoundStack asks a person to rate the APP ITSELF in the App Store or
// Google Play (issue #508). Not the Google review text a business sends its
// own clients after a visit (`review_ask_enabled`); that is a different thing.
//
// Pure: no I/O, no clock, no plugin. Everything it decides on is passed in, so
// every rule below is a unit test. The plugin call, the device storage and the
// foreground listener live in src/lib/rating-prompt-native.ts.
//
// Policy, which is why some things are absent rather than forgotten: no
// "Do you like HoundStack?" pre-prompt and no gating by sentiment (App Review
// Guideline 5.6.1, and Google Play's policy says the same), no incentive, and
// nothing that pops up a link to a review. The one deep link is the static
// "Rate HoundStack" row a person finds for themselves on Preferences
// (RATE_APP_URLS below), which both stores allow. Apple and Google decide
// whether the sheet actually appears, and neither tells us.

import type { AppRole } from "@/hooks/useMyRole";

/** Our own cap on top of the stores': once per person per this many days. */
export const RATING_PROMPT_CAP_DAYS = 120;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A first launch is not a positive moment; nor is the rest of that session. */
export const RATING_PROMPT_MIN_SESSIONS = 2;

/** A technician is asked after this many completed visits of their own. */
export const RATING_PROMPT_TECH_VISITS = 10;

export type RatingPromptTrigger = "first_paid_invoice" | "tenth_completed_visit";

/** The roles whose positive moment is the business getting paid. Not a
 *  dispatcher: a paid invoice is the owner's moment, not the person routing
 *  the trucks, so a dispatcher is never asked. */
const OFFICE_ROLES: ReadonlySet<string> = new Set<AppRole>(["owner", "office_manager"]);
const TECH_ROLE: AppRole = "tech";

export type RatingPromptCounts = {
  role: AppRole | string | null;
  paidInvoiceCount: number;
  completedVisitCount: number;
};

/** Which positive moment this person qualifies under, or null. A role this
 *  file does not know (or none) never qualifies. */
export function ratingPromptTrigger({
  role,
  paidInvoiceCount,
  completedVisitCount,
}: RatingPromptCounts): RatingPromptTrigger | null {
  if (role && OFFICE_ROLES.has(role)) return paidInvoiceCount >= 1 ? "first_paid_invoice" : null;
  if (role === TECH_ROLE) {
    return completedVisitCount >= RATING_PROMPT_TECH_VISITS ? "tenth_completed_visit" : null;
  }
  return null;
}

export type RatingPromptDevice = {
  /** `Capacitor.getPlatform()`: "ios" | "android" | "web". */
  platform: string;
  /** `Capacitor.isNativePlatform()`. False in the hosted app and the PWA. */
  isNative: boolean;
  /** App launches this person has had on this device, this one included. */
  sessions: number;
  /** Epoch ms of the last request on this device for this person, or null. */
  lastPromptedAt: number | null;
  lastPromptedVersion: string | null;
  /** `App.getInfo().version`. */
  appVersion: string;
  /** Epoch ms. */
  now: number;
  /** A calm screen with nothing open over it; see isCalmPath. */
  onCalmScreen: boolean;
};

/**
 * True when the elapsed time since the last request is under the cap.
 * Elapsed whole time, not calendar days: prompted at noon on day 0, the same
 * person is still capped at 119 days 23 hours and free again at exactly 120
 * days (120 * 24h) later.
 */
export function withinRatingPromptCap(lastPromptedAt: number | null, now: number): boolean {
  if (lastPromptedAt === null || !Number.isFinite(lastPromptedAt)) return false;
  return now - lastPromptedAt < RATING_PROMPT_CAP_DAYS * DAY_MS;
}

/** Everything that can be decided on the device, before asking the server for
 *  the two counts. Split out so the wrapper does not spend a request on a
 *  person who could not be asked anyway. */
export function ratingPromptDeviceAllows(d: RatingPromptDevice): boolean {
  if (!d.isNative) return false;
  if (d.platform !== "ios" && d.platform !== "android") return false;
  if (!d.onCalmScreen) return false;
  if (!(d.sessions >= RATING_PROMPT_MIN_SESSIONS)) return false;
  // Without a version the once-per-version cap cannot hold, so do not ask.
  if (!d.appVersion) return false;
  if (d.lastPromptedVersion !== null && d.lastPromptedVersion === d.appVersion) return false;
  if (withinRatingPromptCap(d.lastPromptedAt, d.now)) return false;
  return true;
}

export type RatingPromptInput = RatingPromptDevice &
  RatingPromptCounts & {
    /** An `@demo.test` seed account used by the automated tests. */
    isTestAccount: boolean;
  };

/** The one question: may the app call the store's review sheet right now? */
export function isRatingPromptEligible(input: RatingPromptInput): boolean {
  if (input.isTestAccount) return false;
  if (!ratingPromptDeviceAllows(input)) return false;
  return ratingPromptTrigger(input) !== null;
}

/** The store pages the static "Rate HoundStack" row on Preferences opens,
 *  each straight to its write-a-review screen. */
export const RATE_APP_URLS = {
  ios: "https://apps.apple.com/app/id6804336787?action=write-review",
  android: "https://play.google.com/store/apps/details?id=consulting.thenorth.houndstack",
} as const;

/** The store page for `Capacitor.getPlatform()`, or null where there is no
 *  store to rate in (the web, the PWA). */
export function rateAppUrl(platform: string): string | null {
  if (platform === "ios") return RATE_APP_URLS.ios;
  if (platform === "android") return RATE_APP_URLS.android;
  return null;
}

/** The seed accounts in tests/e2e/seed.mjs and the demo org's invites
 *  (src/lib/users.functions.ts). App Review's demo account may be asked;
 *  Apple decides what it shows. */
export function isTestAccountEmail(email: string | null | undefined): boolean {
  return typeof email === "string" && email.trim().toLowerCase().endsWith("@demo.test");
}

/** The two screens a person rests on: the dashboard and the My Day list. */
const CALM_PATHS: ReadonlySet<string> = new Set(["/dashboard", "/my-day"]);

/**
 * Is this a screen where nobody is in the middle of something?
 *
 * Only the dashboard and the My Day LIST. My Day with `?visit=` is a visit
 * open on top of it (a Live Activity tap lands there too), so it is a task.
 * Payments, `/pay/...`, a visit detail and anything else are simply not on
 * the list. What the URL cannot see (an open dialog, drawer or sheet, a Stripe
 * element) the wrapper checks in the DOM.
 *
 * `search` is the raw query string, with or without its "?".
 */
export function isCalmPath(pathname: string, search = ""): boolean {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (!CALM_PATHS.has(p)) return false;
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (params.has("visit") || params.has("action")) return false;
  return true;
}

/** What is kept on the device, per person: `rating_prompt:<user id>`. */
export type RatingPromptState = {
  lastPromptedAt: number | null;
  lastPromptedVersion: string | null;
  sessions: number;
};

export function ratingPromptKey(userId: string): string {
  return `rating_prompt:${userId}`;
}

/** Read back what was stored, forgiving anything malformed: a value nobody can
 *  read counts as "never asked, no sessions yet", which errs towards waiting. */
export function parseRatingPromptState(raw: string | null | undefined): RatingPromptState {
  const empty: RatingPromptState = { lastPromptedAt: null, lastPromptedVersion: null, sessions: 0 };
  if (!raw) return empty;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!v || typeof v !== "object") return empty;
  const o = v as Record<string, unknown>;
  const at = o.lastPromptedAt;
  const lastPromptedAt =
    typeof at === "number" && Number.isFinite(at)
      ? at
      : typeof at === "string" && Number.isFinite(Date.parse(at))
        ? Date.parse(at)
        : null;
  const lastPromptedVersion =
    typeof o.lastPromptedVersion === "string" && o.lastPromptedVersion
      ? o.lastPromptedVersion
      : null;
  const sessions =
    typeof o.sessions === "number" && Number.isFinite(o.sessions) && o.sessions > 0
      ? Math.floor(o.sessions)
      : 0;
  return { lastPromptedAt, lastPromptedVersion, sessions };
}
