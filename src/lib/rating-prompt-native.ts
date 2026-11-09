// The thin native half of the app-rating prompt (issue #508). Every rule is in
// src/lib/rating-prompt.ts; this file only reads and writes device storage,
// asks the server for two counts, and calls the store's review sheet.
//
// Never on the web: everything here starts with isNative(), and the plugins
// are imported dynamically so the hosted bundle does not carry them. The
// shell's hook (src/hooks/useRatingPrompt.ts) is also behind IS_NATIVE_BUNDLE.
//
// Never loud: a missing plugin, a refused request, an offline count, a full
// disk. Each ends in a catch that does nothing. A rating prompt is never worth
// an error on a phone.

import { isNative, platform, topmostOpenLayer } from "@/lib/native";
import {
  isCalmPath,
  isRatingPromptEligible,
  parseRatingPromptState,
  ratingPromptDeviceAllows,
  ratingPromptKey,
  type RatingPromptState,
} from "@/lib/rating-prompt";

/** People whose session this launch has already counted. A process start is
 *  a session; coming back from the background is not. */
const countedThisLaunch = new Set<string>();
/** People already asked (or attempted) in this launch: one try per launch,
 *  so a plugin that rejects is not called on every foreground. */
const triedThisLaunch = new Set<string>();
let evaluating = false;

/** Counts are cached briefly: a person going back and forth to the dashboard
 *  should not cost a request each time. */
const COUNTS_TTL_MS = 5 * 60 * 1000;
let countsCache: {
  userId: string;
  at: number;
  value: Awaited<ReturnType<typeof fetchCounts>>;
} | null = null;

async function fetchCounts() {
  const { getRatingPromptCounts } = await import("@/lib/rating-prompt.functions");
  return getRatingPromptCounts();
}

async function readState(userId: string): Promise<RatingPromptState> {
  const { Preferences } = await import("@capacitor/preferences");
  const { value } = await Preferences.get({ key: ratingPromptKey(userId) });
  return parseRatingPromptState(value);
}

async function writeState(userId: string, state: RatingPromptState): Promise<void> {
  const { Preferences } = await import("@capacitor/preferences");
  await Preferences.set({ key: ratingPromptKey(userId), value: JSON.stringify(state) });
}

/** A Stripe Payment Element or Checkout frame anywhere on the page. */
const STRIPE_ELEMENT =
  'iframe[src*="js.stripe.com"], iframe[name^="__privateStripeFrame"], .StripeElement';

/** Nothing open over the page and no payment on it: no Radix dialog, alert
 *  dialog, sheet or vaul drawer (all Radix Dialog), no popover or menu, and no
 *  Stripe element. No document (a test, a server) counts as nothing open. */
export function nothingOpenOnPage(doc: Document | undefined): boolean {
  if (!doc) return true;
  if (topmostOpenLayer(doc)) return false;
  if (doc.querySelector('[data-vaul-drawer][data-state="open"]')) return false;
  if (doc.querySelector(STRIPE_ELEMENT)) return false;
  return true;
}

export type RatingPromptLocation = () => { pathname: string; search: string };

function onCalmScreen(location: RatingPromptLocation): boolean {
  const { pathname, search } = location();
  return (
    isCalmPath(pathname, search) &&
    nothingOpenOnPage(typeof document === "undefined" ? undefined : document)
  );
}

/** The debug-only Android plugin backed by Play's FakeReviewManager (issue
 *  #521). Must match FakeReviewPlugin.NAME in android/app/src/debug. */
export const FAKE_REVIEW_PLUGIN = "HoundStackFakeReview";

type FakeReviewPlugin = { requestReview(): Promise<{ outcome: string }> };

/**
 * Call the store's review sheet. Production, iOS and every release build:
 * @capacitor-community/in-app-review, as always.
 *
 * The one exception is a DEBUG Android build made with
 * -Phoundstack.fakeReview=on|fail (docs/android-rating-prompt-qa.md). Only
 * that APK registers HoundStackFakeReview, so asking whether the plugin is
 * there is the flag: no build setting in this bundle, nothing to forget to
 * turn off. Anything but "launched" throws, like a refused real request, so
 * the caller's catch treats it the same way.
 */
async function requestStoreReview(): Promise<void> {
  const core = await import("@capacitor/core");
  if (platform() === "android" && core.Capacitor.isPluginAvailable?.(FAKE_REVIEW_PLUGIN)) {
    const fake = core.registerPlugin<FakeReviewPlugin>(FAKE_REVIEW_PLUGIN);
    const { outcome } = await fake.requestReview();
    if (outcome !== "launched") throw new Error(`FakeReviewManager: ${outcome}`);
    return;
  }
  const { InAppReview } = await import("@capacitor-community/in-app-review");
  await InAppReview.requestReview();
}

/** Count this launch as a session for this person, once. */
export async function countRatingPromptSession(userId: string): Promise<void> {
  if (!isNative() || countedThisLaunch.has(userId)) return;
  countedThisLaunch.add(userId);
  try {
    const state = await readState(userId);
    await writeState(userId, { ...state, sessions: state.sessions + 1 });
  } catch {
    // No storage: the person simply stays in their first session.
  }
}

/**
 * Ask the store for its review sheet if, and only if, every rule holds right
 * now. Returns whether the request was made (not whether a sheet appeared,
 * which neither store reports).
 */
export async function maybeRequestRatingPrompt(
  userId: string,
  location: RatingPromptLocation,
  now: () => number = Date.now,
): Promise<boolean> {
  if (!isNative() || evaluating || triedThisLaunch.has(userId)) return false;
  evaluating = true;
  try {
    const [state, info] = await Promise.all([
      readState(userId),
      import("@capacitor/app").then(({ App }) => App.getInfo()),
    ]);
    const device = () => ({
      platform: platform(),
      isNative: isNative(),
      sessions: state.sessions,
      lastPromptedAt: state.lastPromptedAt,
      lastPromptedVersion: state.lastPromptedVersion,
      appVersion: info.version,
      now: now(),
      onCalmScreen: onCalmScreen(location),
    });
    // Everything the device can answer first, so a person who could not be
    // asked anyway costs no request.
    if (!ratingPromptDeviceAllows(device())) return false;

    const fresh =
      countsCache && countsCache.userId === userId && now() - countsCache.at < COUNTS_TTL_MS;
    const counts = fresh ? countsCache!.value : await fetchCounts();
    if (!fresh) countsCache = { userId, at: now(), value: counts };

    // Again, with the screen as it is NOW: the count took a round trip, and
    // the person may have opened something in the meantime.
    if (!isRatingPromptEligible({ ...device(), ...counts })) return false;

    triedThisLaunch.add(userId);
    await requestStoreReview();
    await writeState(userId, {
      sessions: state.sessions,
      lastPromptedAt: now(),
      lastPromptedVersion: info.version,
    });
    return true;
  } catch (e) {
    console.debug("[rating-prompt] skipped", e);
    return false;
  } finally {
    evaluating = false;
  }
}

/**
 * Start the prompt for a signed-in person: count the session, then try every
 * time the app comes back to the foreground. The other moment, a calm screen
 * settling, is the hook's (src/hooks/useRatingPrompt.ts). Returns a cleanup
 * that removes the listener. Web: no-op.
 */
export async function startRatingPrompt(
  userId: string,
  location: RatingPromptLocation,
): Promise<() => void> {
  if (!isNative()) return () => {};
  await countRatingPromptSession(userId);
  try {
    const { App } = await import("@capacitor/app");
    const handle = await App.addListener("appStateChange", ({ isActive }) => {
      if (isActive) void maybeRequestRatingPrompt(userId, location);
    });
    return () => {
      void handle.remove();
    };
  } catch {
    return () => {};
  }
}

/** For tests: forget this launch. */
export function resetRatingPromptForTests() {
  countedThisLaunch.clear();
  triedThisLaunch.clear();
  evaluating = false;
  countsCache = null;
}
