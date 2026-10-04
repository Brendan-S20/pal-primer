import type { AnyRouter } from "@tanstack/react-router";
import { navDirection, uaAlreadyAnimated, type NavDirection } from "./direction";
import { prefersReducedMotion } from "./reduced-motion";

/**
 * The DOM half of page transitions. direction.ts decides; this carries the
 * decision to the two places that act on it:
 *
 *   * <html data-nav-dir>, which styles.css reads to pick the animation and
 *     to name the page, header and tab bar for the duration of the
 *     transition only;
 *   * the router's `defaultViewTransition.types` callback, which returns
 *     `false` to skip the transition entirely where the browser supports
 *     view-transition types (Chrome 125+, Safari 18.2+). Where it does not,
 *     the router starts a plain transition anyway and `data-nav-dir="none"`
 *     makes it instant in CSS.
 *
 * Feature detection is the router's: it only calls startViewTransition when
 * `document.startViewTransition` exists. Anywhere else, navigation is
 * exactly what it was.
 */

let current: NavDirection = "none";
let lastTraversal: { at: number; uaAnimated: boolean } | null = null;
let activeTransitions = 0;
let clearTimer: ReturnType<typeof setTimeout> | undefined;
let installed = false;

/** A history traversal this recent is the one the router is loading now. */
const TRAVERSAL_WINDOW_MS = 1000;

function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  // iPadOS reports itself as a Mac; a Mac with a touch screen is an iPad.
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

function setDir(dir: NavDirection) {
  current = dir;
  if (clearTimer) clearTimeout(clearTimer);
  document.documentElement.dataset.navDir = dir;
}

function clearDir() {
  if (activeTransitions > 0) return;
  delete document.documentElement.dataset.navDir;
}

/**
 * Watch for back/forward traversals, and for whether the platform animated
 * them. Capture phase and registered before the router exists, so this runs
 * before @tanstack/history's own popstate listener starts the navigation.
 */
function watchTraversals() {
  const ios = isIOS();
  const record = (has: unknown) => {
    lastTraversal = {
      at: performance.now(),
      uaAnimated: uaAlreadyAnimated(typeof has === "boolean" ? has : undefined, ios),
    };
  };
  window.addEventListener("popstate", (e) => record((e as PopStateEvent & { hasUAVisualTransition?: boolean }).hasUAVisualTransition), {
    capture: true,
  });
  // The Navigation API fires `navigate` before `popstate`, with the same flag.
  const nav = (window as unknown as { navigation?: EventTarget }).navigation;
  nav?.addEventListener?.("navigate", (e) => {
    const ev = e as Event & { navigationType?: string; hasUAVisualTransition?: boolean };
    if (ev.navigationType === "traverse") record(ev.hasUAVisualTransition);
  });
}

function takeTraversal() {
  const t = lastTraversal;
  lastTraversal = null;
  if (!t || performance.now() - t.at > TRAVERSAL_WINDOW_MS) return null;
  return t;
}

/**
 * A skipped view transition (another navigation started, the tab was
 * hidden) rejects its `ready` and `finished` promises, and nothing in the
 * router observes them, so every skip would print "Uncaught (in promise)
 * AbortError" — on a console the E2E suite requires to be clean. Observing
 * them here is the whole of this wrapper; it also tells us when a transition
 * is over, which is when the names come off.
 */
function observeTransitions() {
  const doc = document as Document & {
    startViewTransition?: (arg: unknown) => {
      ready: Promise<void>;
      finished: Promise<void>;
    };
  };
  const original = doc.startViewTransition;
  if (typeof original !== "function") return;
  doc.startViewTransition = function (this: Document, arg: unknown) {
    const t = original.call(this, arg);
    activeTransitions++;
    t.ready.catch(() => {});
    t.finished
      .catch(() => {})
      .finally(() => {
        activeTransitions = Math.max(0, activeTransitions - 1);
        clearDir();
      });
    return t;
  } as typeof original;
}

/** For the router's `defaultViewTransition` (its `ViewTransitionOptions`,
 *  which @tanstack/react-router does not re-export). */
export const pageViewTransition = {
  types: (): string[] | false => (current === "none" ? false : [`hs-${current}`]),
};

export function installPageTransitions(router: AnyRouter) {
  if (installed || typeof window === "undefined") return;
  installed = true;
  watchTraversals();
  observeTransitions();

  router.subscribe("onBeforeLoad", (e) => {
    const traversal = takeTraversal();
    const fromState = e.fromLocation?.state as { __TSR_index?: number } | undefined;
    const toState = e.toLocation.state as { __TSR_index?: number } | undefined;
    setDir(
      navDirection({
        fromPath: e.fromLocation?.pathname,
        toPath: e.toLocation.pathname,
        isPop: traversal !== null,
        fromIndex: fromState?.__TSR_index,
        toIndex: toState?.__TSR_index,
        uaTransitioned: traversal?.uaAnimated ?? false,
        reducedMotion: prefersReducedMotion(),
      }),
    );
  });

  // Backstop: a navigation that resolved without any transition starting
  // (no support, or one was not wanted) must not leave the names on. They
  // make <main> a stacking context, which is harmless for 220ms and not for
  // the rest of the session.
  router.subscribe("onResolved", () => {
    if (clearTimer) clearTimeout(clearTimer);
    clearTimer = setTimeout(clearDir, 1000);
  });
}
