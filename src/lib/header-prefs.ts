// Which optional controls the top bar shows, per person, on this device.
//
// ── WHY THIS EXISTS ───────────────────────────────────────────────────────
//
// The staff header carries five controls beside the search box: the sidebar
// toggle, the Knowledge Center "?", the weather popover, the notification
// bell and the account menu. Each is a 44px box, which is the minimum a thumb
// can hit — so on a 360px phone they occupy 220px of a 360px bar and the
// search field, which is the control people actually use, is squeezed into
// what is left. Two of the five are genuinely optional: someone who has read
// the help once does not need a permanent link to it, and weather matters to
// a business that scoops yards in the rain until the day it does not.
//
// So they can be turned off. Not removed — a preference, because the same
// header serves an owner doing office work on a laptop and a tech in a
// driveway, and those two want different things from it.
//
// ── WHY LOCAL, AND WHY PER USER ───────────────────────────────────────────
//
// This is a display preference about one person's own chrome. It is not
// business data, it does not belong to the organization, and nothing else
// needs to read it — so it does not need a column, a migration, or a network
// round trip that can fail. localStorage answers instantly and offline, which
// matters because the header renders before anything else does; a preference
// fetched over the wire would flash the controls in and then out.
//
// Keyed by user id for the same reason as [[tour-seen]]: a crew tablet or a
// lent phone has more than one person on it, and one of them hiding the
// weather should not hide it for the next.
//
// NOT under `READ_CACHE_KEY_PREFIX`. That prefix is swept on sign-out so a
// shared tablet cannot leak the previous tech's route. This holds two
// booleans about button visibility — there is nothing in it to leak, and
// having your header rearrange itself every time you sign out would be a bug,
// not privacy.

const KEY_PREFIX = "hs:header-prefs:";

/** The controls that can be turned off, plus how a phone navigates.
 *
 *  The note that used to be here said the sidebar toggle "has no other entry
 *  point". That was true when it was written and is not true now: below the
 *  tablet breakpoint MobileTabBar renders a More button whose sheet lists
 *  every destination the sidebar has and the tabs do not. So on a phone the
 *  two menus go to the same places, and the app was rendering both. */
export type HeaderPrefs = {
  /** The "?" that links to the Knowledge Center. */
  showHelp: boolean;
  /** The weather popover. */
  showWeather: boolean;
  /** Which single menu a phone gets.
   *
   *  `bottom` — the tab bar, with More. The hamburger is hidden.
   *  `side`   — the hamburger and its sheet. The tab bar is hidden.
   *
   *  Exactly one, never both, because both is what the app did and it meant
   *  two buttons, in two corners, opening two sheets, listing the same
   *  destinations. Which one suits you is not something this codebase can
   *  know: a tech working one-handed in a driveway wants a thumb-reachable
   *  bar, and somebody used to the desktop layout wants the menu where it has
   *  always been.
   *
   *  Only consulted below the tablet breakpoint. From `md`/`lg` up the docked
   *  sidebar is the navigation and the toggle collapses it, which is a
   *  different job from opening a sheet. */
  phoneNav: "bottom" | "side";
};

export const DEFAULT_HEADER_PREFS: HeaderPrefs = {
  // Both default ON, so nobody loses a control they were using by upgrading.
  showHelp: true,
  showWeather: true,
  // The tab bar is the default because it is the one with a thumb-reachable
  // hit area and the one iOS users expect, and because it is what a phone
  // already showed before this preference existed. Choosing `side` is opting
  // OUT of the platform convention, which is a thing to allow and not a thing
  // to assume.
  phoneNav: "bottom",
};

/** Fired when prefs change, so every header on the page re-reads them.
 *  Storage events do not fire in the tab that wrote the value. */
export const HEADER_PREFS_EVENT = "hs:header-prefs-changed";

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    // Private-mode Safari and locked-down WebViews throw on access. Showing
    // the default header is fine; failing the app is not.
    return null;
  }
}

export function readHeaderPrefs(userId: string | null | undefined): HeaderPrefs {
  if (!userId) return DEFAULT_HEADER_PREFS;
  try {
    const raw = storage()?.getItem(KEY_PREFIX + userId);
    if (!raw) return DEFAULT_HEADER_PREFS;
    const parsed = JSON.parse(raw) as Partial<HeaderPrefs>;
    // Spread over the defaults rather than trusting the stored shape: a value
    // written by an older build is missing whatever was added since, and
    // `undefined` for a boolean would hide a control nobody asked to hide.
    return { ...DEFAULT_HEADER_PREFS, ...parsed };
  } catch {
    return DEFAULT_HEADER_PREFS;
  }
}

export function writeHeaderPrefs(userId: string | null | undefined, next: HeaderPrefs): void {
  if (!userId) return;
  try {
    storage()?.setItem(KEY_PREFIX + userId, JSON.stringify(next));
  } catch {
    // Quota or blocked storage. The setting simply does not persist.
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(HEADER_PREFS_EVENT));
  }
}
